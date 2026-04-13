// lib/figma/client.ts

const FIGMA_API = 'https://api.figma.com'
const MAX_FRAMES = 25

export interface FigmaFrame {
  id: string
  name: string
  thumbnailUrl: string
}

interface FigmaNode {
  id: string
  name: string
  type: string
  children?: FigmaNode[]
}

/**
 * Parses any Figma URL into { fileKey, nodeId? }.
 * Handles /file/ and /design/ formats, and node-id with either
 * URL-encoded colons (%3A) or hyphen separators (1-2 → 1:2).
 */
export function parseFigmaUrl(url: string): { fileKey: string; nodeId?: string } | null {
  const match = url.match(/figma\.com\/(?:file|design)\/([^/?#]+)/)
  if (!match) return null
  const fileKey = match[1]
  const nodeIdMatch = url.match(/[?&]node-id=([^&]+)/)
  if (!nodeIdMatch) return { fileKey }
  const decoded = decodeURIComponent(nodeIdMatch[1])
  const nodeId = decoded.includes(':') ? decoded : decoded.replace(/-/g, ':')
  return { fileKey, nodeId }
}

function figmaHeaders(token: string) {
  return { Authorization: `Bearer ${token}` }
}

/**
 * Fetches the file cover thumbnail URL. Lightweight — uses depth=1.
 * Returns null if the Figma API is unavailable or the token is invalid.
 */
export async function fetchFigmaCover(token: string, fileKey: string): Promise<string | null> {
  try {
    const res = await fetch(`${FIGMA_API}/v1/files/${fileKey}?depth=1`, {
      headers: figmaHeaders(token),
    })
    if (!res.ok) return null
    const data = await res.json()
    return (data.thumbnailUrl as string) ?? null
  } catch {
    return null
  }
}

/**
 * Finds a node and its parent in the tree. Returns null if not found.
 */
function findNodeWithParent(
  nodes: FigmaNode[],
  targetId: string,
  parent: FigmaNode | null = null
): { node: FigmaNode; parent: FigmaNode | null } | null {
  for (const node of nodes) {
    if (node.id === targetId) return { node, parent }
    if (node.children) {
      const result = findNodeWithParent(node.children, targetId, node)
      if (result) return result
    }
  }
  return null
}

/**
 * Fetches Figma frames based on the nodeId selection logic:
 * - nodeId is a CANVAS (page) → all top-level FRAME children
 * - nodeId is a FRAME → that frame + its FRAME siblings
 * - nodeId undefined → returns { frames: [], warnings: ['no_node_id'] }
 * Caps at 25 frames to prevent Claude context overflow.
 */
export async function fetchFigmaFrames(
  token: string,
  fileKey: string,
  nodeId?: string
): Promise<{ frames: FigmaFrame[]; warnings: string[] }> {
  if (!nodeId) return { frames: [], warnings: ['no_node_id'] }

  let res: Response
  try {
    res = await fetch(`${FIGMA_API}/v1/files/${fileKey}?depth=2`, {
      headers: figmaHeaders(token),
    })
  } catch {
    return { frames: [], warnings: ['figma_api_error'] }
  }
  if (!res.ok) return { frames: [], warnings: ['figma_api_error'] }
  let data: { document?: { children?: FigmaNode[] } }
  try {
    data = await res.json()
  } catch {
    return { frames: [], warnings: ['figma_api_error'] }
  }

  const pages: FigmaNode[] = data.document?.children ?? []
  let targetFrameIds: string[] = []
  const frameNames: Record<string, string> = {}

  const page = pages.find((p) => p.id === nodeId)
  if (page) {
    const frames = (page.children ?? []).filter((n) => n.type === 'FRAME')
    frames.forEach((f) => { frameNames[f.id] = f.name })
    targetFrameIds = frames.map((f) => f.id)
  } else {
    for (const p of pages) {
      const result = findNodeWithParent(p.children ?? [], nodeId, p)
      if (result) {
        const siblings = (result.parent?.children ?? [result.node]).filter((n) => n.type === 'FRAME')
        siblings.forEach((f) => { frameNames[f.id] = f.name })
        targetFrameIds = siblings.map((f) => f.id)
        break
      }
    }
  }

  if (targetFrameIds.length === 0) return { frames: [], warnings: ['no_frames_found'] }

  const cappedWarnings: string[] = []
  if (targetFrameIds.length > MAX_FRAMES) {
    cappedWarnings.push('frames_capped_at_25')
    targetFrameIds = targetFrameIds.slice(0, MAX_FRAMES)
  }

  let imgRes: Response
  try {
    imgRes = await fetch(
      `${FIGMA_API}/v1/images/${fileKey}?ids=${encodeURIComponent(targetFrameIds.join(','))}&format=png&scale=1`,
      { headers: figmaHeaders(token) }
    )
  } catch {
    return { frames: [], warnings: ['figma_api_error'] }
  }
  if (!imgRes.ok) return { frames: [], warnings: ['figma_api_error'] }
  let imgData: { images?: Record<string, string> }
  try {
    imgData = await imgRes.json()
  } catch {
    return { frames: [], warnings: ['figma_api_error'] }
  }
  const images: Record<string, string> = imgData.images ?? {}

  const frames: FigmaFrame[] = targetFrameIds
    .map((id) => ({ id, name: frameNames[id] ?? id, thumbnailUrl: images[id] ?? '' }))
    .filter((f) => f.thumbnailUrl)

  return { frames, warnings: cappedWarnings }
}

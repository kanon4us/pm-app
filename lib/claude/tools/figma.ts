// lib/claude/tools/figma.ts
// view_figma: renders a Figma frame to PNG and returns it as an image tool_result,
// so the chat Claude can actually see linked designs. Available in both planning
// and prototyping phases. Uses the chatting user's Figma OAuth token (same source
// as the step-thumbnail route). Images are not persisted — re-view when needed.
import type Anthropic from '@anthropic-ai/sdk'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { parseFigmaUrl } from '@/lib/figma/client'
import type { AppliedChanges } from '@/lib/claude/tools/planning'

const FIGMA_API = 'https://api.figma.com'
// Anthropic caps images around 5MB base64; keep the raw PNG comfortably below that.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024

export const FIGMA_TOOL_NAME = 'view_figma'
export const FIGMA_STYLES_TOOL_NAME = 'get_figma_styles'
export const FIGMA_TOOL_NAMES = [FIGMA_TOOL_NAME, FIGMA_STYLES_TOOL_NAME] as const

export const FIGMA_TOOLS: Anthropic.Tool[] = [
  {
    name: FIGMA_TOOL_NAME,
    description:
      'Render a Figma frame as an image so you can see the design. Use the [figma: ...] links on steps or any Figma URL the PM shares. The URL must include a node-id (a specific frame).',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Figma file/design URL including node-id' },
      },
      required: ['url'],
    },
  },
  {
    name: FIGMA_STYLES_TOOL_NAME,
    description:
      "Extract the frame's exact design tokens from the Figma file: font families/sizes/weights, solid fill colors as hex, corner radii, shadows, and auto-layout spacing. Use this alongside view_figma so colors and typography come from real values, not guesses from the image.",
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Figma file/design URL including node-id' },
      },
      required: ['url'],
    },
  },
]

export type ToolResultContent = string | Anthropic.ToolResultBlockParam['content']

export async function executeViewFigma(
  userId: string | undefined,
  input: { url: string },
  applied: AppliedChanges
): Promise<{ result: ToolResultContent; isError: boolean }> {
  try {
    const parsed = parseFigmaUrl(input.url ?? '')
    if (!parsed) throw new Error(`Not a Figma URL: ${input.url}`)
    if (!parsed.nodeId) {
      throw new Error('The URL has no node-id, so it points at a whole file. Ask the PM for a frame link (right-click the frame in Figma → Copy link).')
    }
    const auth = await resolveFigmaAuth(userId)
    if (!auth) throw new Error('Figma access is not configured — set FIGMA_ACCESS_TOKEN in the pm-app environment')

    const png = await renderFrame(auth, parsed.fileKey, parsed.nodeId)
    applied.framesViewed++

    return {
      result: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
        },
        { type: 'text', text: `Figma frame ${parsed.nodeId} from ${input.url}` },
      ],
      isError: false,
    }
  } catch (err) {
    return { result: err instanceof Error ? err.message : 'view_figma failed', isError: true }
  }
}

interface FigmaAuth {
  headers: Record<string, string>
}

/**
 * Parses a Figma URL, resolves auth, fetches the node, and returns the compact
 * style-token summary — the same output get_figma_styles surfaces to chat.
 * Reused by resolveReuseRefs. Throws with a PM-readable message on failure.
 */
export async function getFigmaNodeStyleSummary(
  userId: string | undefined,
  url: string
): Promise<string> {
  const parsed = parseFigmaUrl(url ?? '')
  if (!parsed) throw new Error(`Not a Figma URL: ${url}`)
  if (!parsed.nodeId) throw new Error('The URL has no node-id — get_figma_styles needs a specific frame link.')

  const auth = await resolveFigmaAuth(userId)
  if (!auth) throw new Error('Figma access is not configured — set FIGMA_ACCESS_TOKEN in the pm-app environment')

  const res = await fetch(
    `${FIGMA_API}/v1/files/${parsed.fileKey}/nodes?ids=${encodeURIComponent(parsed.nodeId)}`,
    { headers: auth.headers }
  )
  if (!res.ok) {
    const apiErr = await res.json().then((d: { err?: string }) => d.err).catch(() => null)
    throw new Error(`Figma API error ${res.status}${apiErr ? `: ${apiErr}` : ''}. Report this exact error to the PM.`)
  }
  const data = (await res.json()) as { nodes?: Record<string, { document?: FigmaStyleNode }> }
  const root = data.nodes?.[parsed.nodeId]?.document
  if (!root) throw new Error(`Figma returned no node for ${parsed.nodeId}`)

  return summarizeStyles(root)
}

/**
 * Prefers the user's OAuth token (Bearer) when one exists; falls back to the
 * app-wide FIGMA_ACCESS_TOKEN PAT (X-Figma-Token) — the same credential the
 * rest of the Figma read pipeline uses. There is no OAuth connect UI today,
 * so the PAT is the path that actually works in practice.
 */
export async function executeGetFigmaStyles(
  userId: string | undefined,
  input: { url: string },
  applied: AppliedChanges
): Promise<{ result: ToolResultContent; isError: boolean }> {
  try {
    const summary = await getFigmaNodeStyleSummary(userId, input.url ?? '')
    applied.framesViewed++
    return { result: summary, isError: false }
  } catch (err) {
    return { result: err instanceof Error ? err.message : 'get_figma_styles failed', isError: true }
  }
}

interface FigmaStyleNode {
  name?: string
  type?: string
  fills?: { type?: string; visible?: boolean; color?: { r: number; g: number; b: number; a?: number }; opacity?: number }[]
  strokes?: { type?: string; color?: { r: number; g: number; b: number } }[]
  style?: { fontFamily?: string; fontWeight?: number; fontSize?: number; lineHeightPx?: number }
  cornerRadius?: number
  effects?: { type?: string; visible?: boolean; radius?: number; offset?: { x: number; y: number }; color?: { r: number; g: number; b: number; a?: number } }[]
  itemSpacing?: number
  paddingLeft?: number
  paddingTop?: number
  children?: FigmaStyleNode[]
}

function toHex(c: { r: number; g: number; b: number }): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`
}

/** Walks the node tree and aggregates a compact design-token summary. */
function summarizeStyles(root: FigmaStyleNode): string {
  const fonts = new Map<string, number>()
  const fills = new Map<string, number>()
  const strokes = new Map<string, number>()
  const radii = new Map<number, number>()
  const shadows = new Set<string>()
  const spacing = new Map<number, number>()
  let visited = 0

  const bump = <K,>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1)

  function walk(node: FigmaStyleNode, depth: number) {
    if (visited++ > 3000 || depth > 12) return
    if (node.style?.fontFamily) {
      bump(fonts, `${node.style.fontFamily} ${node.style.fontWeight ?? ''} @ ${node.style.fontSize ?? '?'}px`)
    }
    for (const f of node.fills ?? []) {
      if (f.type === 'SOLID' && f.visible !== false && f.color) bump(fills, toHex(f.color))
    }
    for (const s of node.strokes ?? []) {
      if (s.type === 'SOLID' && s.color) bump(strokes, toHex(s.color))
    }
    if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) bump(radii, node.cornerRadius)
    for (const e of node.effects ?? []) {
      if (e.type === 'DROP_SHADOW' && e.visible !== false && e.color) {
        shadows.add(`drop-shadow ${e.offset?.x ?? 0}px ${e.offset?.y ?? 0}px ${e.radius ?? 0}px ${toHex(e.color)}${e.color.a != null ? ` @${Math.round(e.color.a * 100)}%` : ''}`)
      }
    }
    if (typeof node.itemSpacing === 'number') bump(spacing, node.itemSpacing)
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  walk(root, 0)

  const top = <K,>(m: Map<K, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, count]) => `${String(k)} (×${count})`)

  return [
    `Design tokens for "${root.name ?? 'frame'}" (${visited} nodes scanned):`,
    `Fonts: ${top(fonts, 10).join(', ') || 'none found'}`,
    `Fill colors: ${top(fills, 16).join(', ') || 'none found'}`,
    `Stroke colors: ${top(strokes, 8).join(', ') || 'none found'}`,
    `Corner radii: ${top(radii, 8).join(', ') || 'none found'}`,
    `Shadows: ${[...shadows].slice(0, 5).join('; ') || 'none found'}`,
    `Auto-layout gaps: ${top(spacing, 8).join(', ') || 'none found'}`,
  ].join('\n')
}

async function resolveFigmaAuth(userId: string | undefined): Promise<FigmaAuth | null> {
  if (userId) {
    const db = await getSupabaseServiceClient()
    const { data } = await db
      .from('oauth_tokens')
      .select('access_token')
      .eq('user_id', userId)
      .eq('provider', 'figma')
      .single()
    if (data?.access_token) return { headers: { Authorization: `Bearer ${data.access_token}` } }
  }
  const pat = process.env.FIGMA_ACCESS_TOKEN
  if (pat) return { headers: { 'X-Figma-Token': pat } }
  return null
}

async function renderFrame(auth: FigmaAuth, fileKey: string, nodeId: string): Promise<Buffer> {
  // scale=2 for legible UI text; drop to scale=1 if the render is too heavy.
  for (const scale of [2, 1]) {
    const res = await fetch(
      `${FIGMA_API}/v1/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${scale}`,
      { headers: auth.headers }
    )
    if (!res.ok) {
      const apiErr = await res.json().then((d: { err?: string; message?: string }) => d.err ?? d.message).catch(() => null)
      // Surface Figma's own reason (e.g. "Invalid token", "Token expired") — do
      // not guess about share settings; report exactly what the API said.
      throw new Error(`Figma API error ${res.status}${apiErr ? `: ${apiErr}` : ''}. Report this exact error to the PM — do not speculate about causes the API did not state.`)
    }
    const data = (await res.json()) as { images?: Record<string, string | null>; err?: string }
    const imageUrl = data.images?.[nodeId]
    if (!imageUrl) throw new Error(data.err ?? `Figma returned no image for node ${nodeId} — the frame may not exist`)

    const imgRes = await fetch(imageUrl)
    if (!imgRes.ok) throw new Error(`Failed to download the rendered frame (${imgRes.status})`)
    const bytes = Buffer.from(await imgRes.arrayBuffer())
    if (bytes.byteLength <= MAX_IMAGE_BYTES) return bytes
  }
  throw new Error('Frame renders larger than the image limit even at scale 1 — try a smaller frame or a sub-section of it')
}

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
 * Prefers the user's OAuth token (Bearer) when one exists; falls back to the
 * app-wide FIGMA_ACCESS_TOKEN PAT (X-Figma-Token) — the same credential the
 * rest of the Figma read pipeline uses. There is no OAuth connect UI today,
 * so the PAT is the path that actually works in practice.
 */
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

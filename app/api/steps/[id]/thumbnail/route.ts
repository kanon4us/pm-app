import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { parseFigmaUrl } from '@/lib/figma/client'

/**
 * POST /api/steps/[id]/thumbnail
 * Fetches the Figma thumbnail for the step's figma_frame_id and persists it.
 * Requires a connected Figma OAuth token for the current user.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser()
  if (!user?.dbId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const db = await getSupabaseServiceClient()

  // Load step
  const { data: step, error: stepErr } = await db.from('steps').select().eq('id', id).single()
  if (stepErr || !step) return NextResponse.json({ error: 'Step not found' }, { status: 404 })
  if (!step.figma_url) return NextResponse.json({ error: 'Step has no figma_url' }, { status: 400 })

  const parsed = parseFigmaUrl(step.figma_url)
  if (!parsed) return NextResponse.json({ error: 'Invalid figma_url' }, { status: 400 })

  // Load user Figma token
  const { data: tokenRow } = await db
    .from('oauth_tokens')
    .select('access_token')
    .eq('user_id', user.dbId)
    .eq('provider', 'figma')
    .single()

  if (!tokenRow?.access_token) {
    return NextResponse.json({ error: 'No Figma token — connect Figma in settings' }, { status: 400 })
  }

  const { fileKey, nodeId } = parsed

  // If we have a specific node, fetch image for that node; otherwise fall back to file thumbnail.
  let thumbnailUrl: string | null = null

  if (nodeId) {
    try {
      const imgRes = await fetch(
        `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=1`,
        { headers: { 'X-Figma-Token': tokenRow.access_token } }
      )
      if (imgRes.ok) {
        const imgData: { images?: Record<string, string> } = await imgRes.json()
        thumbnailUrl = imgData.images?.[nodeId] ?? null
      }
    } catch { /* fall through to file cover */ }
  }

  if (!thumbnailUrl) {
    try {
      const fileRes = await fetch(
        `https://api.figma.com/v1/files/${fileKey}?depth=1`,
        { headers: { 'X-Figma-Token': tokenRow.access_token } }
      )
      if (fileRes.ok) {
        const fileData: { thumbnailUrl?: string } = await fileRes.json()
        thumbnailUrl = fileData.thumbnailUrl ?? null
      }
    } catch { /* non-fatal */ }
  }

  if (!thumbnailUrl) {
    return NextResponse.json({ error: 'Could not fetch thumbnail from Figma' }, { status: 502 })
  }

  // Persist thumbnail URL on the step
  const { data: updated, error: updateErr } = await db
    .from('steps')
    .update({ figma_thumbnail_url: thumbnailUrl })
    .eq('id', id)
    .select()
    .single()

  if (updateErr || !updated) {
    return NextResponse.json({ error: 'Failed to save thumbnail' }, { status: 500 })
  }

  return NextResponse.json({ figma_thumbnail_url: thumbnailUrl })
}

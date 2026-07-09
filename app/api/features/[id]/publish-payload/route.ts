import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'

/**
 * Hands the authed PM the copy-paste payload for the Figma plugin:
 * { featureId, token, baseUrl }. Session-gated — this is how FIGMA_PLUGIN_TOKEN
 * reaches the browser, only for a signed-in user. Never logged.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const token = process.env.FIGMA_PLUGIN_TOKEN
  if (!token) return NextResponse.json({ error: 'FIGMA_PLUGIN_TOKEN not configured' }, { status: 500 })
  const baseUrl = process.env.PUBLIC_APP_URL ?? new URL(req.url).origin
  return NextResponse.json({ featureId: id, token, baseUrl })
}

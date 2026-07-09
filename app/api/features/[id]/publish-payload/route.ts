import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'

/**
 * Hands the authed PM the copy-paste payload for the Figma plugin:
 * { featureId, token, baseUrl }. Session-gated — this is how FIGMA_PLUGIN_TOKEN
 * reaches the browser, only for a signed-in user. Never logged.
 *
 * baseUrl resolves from PUBLIC_APP_URL / NEXTAUTH_URL (both stable domains;
 * NEXTAUTH_URL is a branch alias here, never a per-deploy alias) and only falls
 * back to the request origin as a last resort — it is baked into the payload the
 * external plugin uses for callbacks, so it must be stable, and the plugin
 * manifest's allowedDomains must include it.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const token = process.env.FIGMA_PLUGIN_TOKEN
  if (!token) return NextResponse.json({ error: 'FIGMA_PLUGIN_TOKEN not configured' }, { status: 500 })
  const baseUrl = process.env.PUBLIC_APP_URL ?? process.env.NEXTAUTH_URL ?? new URL(req.url).origin
  return NextResponse.json({ featureId: id, token, baseUrl })
}

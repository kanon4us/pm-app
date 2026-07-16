import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { generateUxStitch } from '@/lib/features/ux-architect'

// Runs Gemini inline (one call); give it room. Same budget as the resolver.
export const maxDuration = 120

/**
 * Force-regenerates the feature's UX stitch on demand. Unlike the automatic
 * planning→approved trigger, this runs regardless of phase (force) so a stitch
 * that never generated (or a stale one) can be rebuilt without toggling phase.
 * Session-gated: this is an internal pm-app action, not the token-gated plugin API.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const result = await generateUxStitch(id, { force: true })
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.reason ?? 'stitch generation failed' }, { status: 502 })
  }
  return NextResponse.json({ ok: true })
}

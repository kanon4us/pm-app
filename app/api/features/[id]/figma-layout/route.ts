import { NextRequest, NextResponse } from 'next/server'
import { resolveFigmaLayout } from '@/lib/features/figma-layout'

// Gemini resolve runs inline; give it room.
export const maxDuration = 120

/** Returns the fully-resolved Figma layout spec. Token-gated (plugin is external). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = process.env.FIGMA_PLUGIN_TOKEN
  if (!token) return NextResponse.json({ error: 'FIGMA_PLUGIN_TOKEN not configured' }, { status: 500 })
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  const spec = await resolveFigmaLayout(id)
  if (!spec) return NextResponse.json({ error: 'Could not resolve a layout (missing stitch or Gemini failure)' }, { status: 502 })
  return NextResponse.json(spec)
}

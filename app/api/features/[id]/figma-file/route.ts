import { NextRequest, NextResponse } from 'next/server'
import { updateFeature } from '@/lib/features/client'

/** Stores the Figma file key the plugin published into. Token-gated. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = process.env.FIGMA_PLUGIN_TOKEN
  const auth = req.headers.get('authorization')
  if (!token || auth !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const fileKey = (body as { fileKey?: unknown }).fileKey
  if (typeof fileKey !== 'string' || !fileKey) {
    return NextResponse.json({ error: 'fileKey required' }, { status: 400 })
  }
  await updateFeature(id, { figma_file_key: fileKey })
  return NextResponse.json({ ok: true })
}

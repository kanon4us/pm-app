import { NextRequest } from 'next/server'
import { updateFeature } from '@/lib/features/client'
import { figmaJson, figmaPreflight } from '@/lib/features/figma-cors'

/** CORS preflight — the plugin sandbox sends OPTIONS before the token-authed POST. */
export function OPTIONS() {
  return figmaPreflight()
}

/** Stores the Figma file key the plugin published into. Token-gated. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = process.env.FIGMA_PLUGIN_TOKEN
  if (!token) return figmaJson({ error: 'FIGMA_PLUGIN_TOKEN not configured' }, { status: 500 })
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${token}`) {
    return figmaJson({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const fileKey = (body as { fileKey?: unknown }).fileKey
  if (typeof fileKey !== 'string' || !fileKey) {
    return figmaJson({ error: 'fileKey required' }, { status: 400 })
  }
  await updateFeature(id, { figma_file_key: fileKey })
  return figmaJson({ ok: true })
}

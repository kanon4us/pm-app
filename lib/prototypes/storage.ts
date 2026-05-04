import { getSupabaseServiceClient } from '@/lib/supabase/server'
import type { Step } from '@/lib/scenarios/client'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const BUCKET = 'prototype-assets'

function isSupabaseUrl(url: string): boolean {
  if (!SUPABASE_URL) return url.includes('supabase.co')
  return url.startsWith(SUPABASE_URL)
}

async function uploadFigmaImage(stepId: string, figmaUrl: string): Promise<string | null> {
  const db = await getSupabaseServiceClient()
  let imageData: ArrayBuffer
  try {
    const res = await fetch(figmaUrl)
    if (!res.ok) return null
    imageData = await res.arrayBuffer()
  } catch {
    return null
  }

  const path = `steps/${stepId}.png`
  const { error } = await db.storage
    .from(BUCKET)
    .upload(path, imageData, { contentType: 'image/png', upsert: true })
  if (error) return null

  const { data } = db.storage.from(BUCKET).getPublicUrl(path)
  return data.publicUrl
}

export async function ensureStepImages(steps: Pick<Step, 'id' | 'figma_thumbnail_url' | 'figma_url'>[]): Promise<Pick<Step, 'id' | 'figma_thumbnail_url' | 'figma_url'>[]> {
  const db = await getSupabaseServiceClient()
  return Promise.all(steps.map(async (step) => {
    if (!step.figma_thumbnail_url || isSupabaseUrl(step.figma_thumbnail_url)) return step
    const permanentUrl = await uploadFigmaImage(step.id, step.figma_thumbnail_url)
    if (!permanentUrl) return step
    await db.from('steps').update({ figma_thumbnail_url: permanentUrl }).eq('id', step.id)
    return { ...step, figma_thumbnail_url: permanentUrl }
  }))
}

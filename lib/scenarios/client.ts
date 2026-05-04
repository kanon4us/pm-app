import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { parseFigmaUrl } from '@/lib/figma/client'
import type { Tables, InsertDto, UpdateDto } from '@/lib/supabase/types'

export type Scenario = Tables<'scenarios'>
export type Step = Tables<'steps'>

export async function createScenario(data: InsertDto<'scenarios'>): Promise<Scenario> {
  const db = await getSupabaseServiceClient()
  const { data: row, error } = await db.from('scenarios').insert(data).select().single()
  if (error) throw new Error(error.message)
  return row
}

export async function updateScenario(id: string, data: UpdateDto<'scenarios'>): Promise<Scenario> {
  const db = await getSupabaseServiceClient()
  const { data: row, error } = await db.from('scenarios').update(data).eq('id', id).select().single()
  if (error) throw new Error(error.message)
  return row
}

export async function createStep(data: InsertDto<'steps'>): Promise<Step> {
  const db = await getSupabaseServiceClient()
  const enriched = enrichStepWithFigmaId(data)
  const { data: row, error } = await db.from('steps').insert(enriched).select().single()
  if (error) throw new Error(error.message)
  return row
}

export async function updateStep(id: string, data: UpdateDto<'steps'>): Promise<Step> {
  const db = await getSupabaseServiceClient()
  const enriched = enrichStepWithFigmaId(data)
  const { data: row, error } = await db.from('steps').update(enriched).eq('id', id).select().single()
  if (error) throw new Error(error.message)
  return row
}

export async function deleteStep(id: string): Promise<void> {
  const db = await getSupabaseServiceClient()
  const { error } = await db.from('steps').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export async function getScenarioSteps(scenarioId: string): Promise<Step[]> {
  const db = await getSupabaseServiceClient()
  const { data, error } = await db
    .from('steps').select().eq('scenario_id', scenarioId).order('display_order')
  if (error) return []
  return data ?? []
}

export async function getStoryScenarios(storyId: string): Promise<Scenario[]> {
  const db = await getSupabaseServiceClient()
  const { data, error } = await db
    .from('scenarios').select().eq('user_story_id', storyId).order('display_order')
  if (error) return []
  return data ?? []
}

function enrichStepWithFigmaId<T extends { figma_url?: string | null }>(data: T): T {
  if (!data.figma_url) return data
  const parsed = parseFigmaUrl(data.figma_url)
  if (!parsed) return data
  return { ...data, figma_frame_id: parsed.nodeId ?? null }
}

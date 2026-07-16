import { getSupabaseServiceClient } from '@/lib/supabase/server'
import type { Tables, InsertDto, UpdateDto } from '@/lib/supabase/types'

export type Feature = Tables<'features'>
export type FeatureInsert = InsertDto<'features'>
export type FeatureUpdate = UpdateDto<'features'>

export async function createFeature(data: FeatureInsert): Promise<Feature> {
  const db = await getSupabaseServiceClient()
  const { data: row, error } = await db.from('features').insert(data).select().single()
  if (error) throw new Error(error.message)
  return row
}

export async function getFeature(id: string): Promise<Feature | null> {
  const db = await getSupabaseServiceClient()
  const { data, error } = await db.from('features').select().eq('id', id).single()
  if (error) return null
  return data
}

export async function listFeatures(query?: string): Promise<Feature[]> {
  const db = await getSupabaseServiceClient()
  let q = db.from('features').select()
  if (query) q = q.ilike('name', `%${query}%`)
  const { data, error } = await q.order('created_at', { ascending: false })
  if (error) return []
  return data ?? []
}

export async function updateFeature(id: string, data: FeatureUpdate): Promise<Feature> {
  const db = await getSupabaseServiceClient()
  const { data: row, error } = await db.from('features').update(data).eq('id', id).select().single()
  if (error) throw new Error(error.message)
  return row
}

export async function linkTask(featureId: string, taskId: string): Promise<void> {
  const db = await getSupabaseServiceClient()
  const { error } = await db.from('feature_tasks').insert([{ feature_id: featureId, task_id: taskId }])
  if (error && error.code !== '23505') throw new Error(error.message)
}

export async function unlinkTask(featureId: string, taskId: string): Promise<void> {
  const db = await getSupabaseServiceClient()
  const { error } = await db.from('feature_tasks').delete().eq('feature_id', featureId).eq('task_id', taskId)
  if (error) throw new Error(error.message)
}

/** ClickUp task id of a task ASSOCIATED with this feature (via feature_tasks),
 * or null if none is linked. Used by the manual re-sync path so it only ever
 * enriches from a task the feature already owns — never an arbitrary task. */
export async function getClickupTaskIdForFeature(featureId: string): Promise<string | null> {
  const db = await getSupabaseServiceClient()
  const { data: link } = await db
    .from('feature_tasks').select('task_id').eq('feature_id', featureId).limit(1).single()
  if (!link) return null
  const { data: task } = await db
    .from('tasks').select('clickup_task_id').eq('id', link.task_id).single()
  return task?.clickup_task_id ?? null
}

export async function getTaskFeatures(taskId: string): Promise<Feature[]> {
  const db = await getSupabaseServiceClient()
  const { data, error } = await db
    .from('feature_tasks')
    .select('features(*)')
    .eq('task_id', taskId)
  if (error || !data) return []
  return data.flatMap((r: { features: Feature | Feature[] | null }) =>
    r.features ? (Array.isArray(r.features) ? r.features : [r.features]) : []
  )
}

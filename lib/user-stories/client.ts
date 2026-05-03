import { getSupabaseServiceClient } from '@/lib/supabase/server'
import type { Tables, InsertDto, UpdateDto } from '@/lib/supabase/types'

export type UserStory = Tables<'user_stories'>

export async function createUserStory(data: InsertDto<'user_stories'>): Promise<UserStory> {
  const db = await getSupabaseServiceClient()
  const { data: row, error } = await db.from('user_stories').insert(data).select().single()
  if (error) throw new Error(error.message)
  return row
}

export async function updateUserStory(id: string, data: UpdateDto<'user_stories'>): Promise<UserStory> {
  const db = await getSupabaseServiceClient()
  const { data: row, error } = await db.from('user_stories').update(data).eq('id', id).select().single()
  if (error) throw new Error(error.message)
  return row
}

export async function linkStory(featureId: string, storyId: string, displayOrder = 0): Promise<void> {
  const db = await getSupabaseServiceClient()
  const { error } = await db
    .from('feature_user_stories')
    .insert([{ feature_id: featureId, user_story_id: storyId, display_order: displayOrder }])
  if (error && error.code !== '23505') throw new Error(error.message)
}

export async function unlinkStory(featureId: string, storyId: string): Promise<void> {
  const db = await getSupabaseServiceClient()
  const { error } = await db
    .from('feature_user_stories')
    .delete()
    .eq('feature_id', featureId)
    .eq('user_story_id', storyId)
  if (error) throw new Error(error.message)
}

export async function getStoryFeatureCount(storyId: string): Promise<number> {
  const db = await getSupabaseServiceClient()
  const { count, error } = await db
    .from('feature_user_stories')
    .select('*', { count: 'exact', head: true })
    .eq('user_story_id', storyId)
  if (error) return 0
  return count ?? 0
}

export async function forkStory(storyId: string, targetFeatureId: string): Promise<UserStory> {
  const db = await getSupabaseServiceClient()
  const { data: original, error: fetchErr } = await db
    .from('user_stories').select().eq('id', storyId).single()
  if (fetchErr || !original) throw new Error('Story not found')
  const { id: _id, created_at: _ca, ...fields } = original
  const { data: forked, error: insertErr } = await db
    .from('user_stories').insert(fields).select().single()
  if (insertErr || !forked) throw new Error('Fork failed')
  await linkStory(targetFeatureId, forked.id, 0)
  return forked
}

export async function getFeatureStories(featureId: string): Promise<UserStory[]> {
  const db = await getSupabaseServiceClient()
  const { data, error } = await db
    .from('feature_user_stories')
    .select('user_stories(*), display_order')
    .eq('feature_id', featureId)
    .order('display_order')
  if (error || !data) return []
  return data.flatMap((r: { user_stories: UserStory | UserStory[] | null }) =>
    r.user_stories ? (Array.isArray(r.user_stories) ? r.user_stories : [r.user_stories]) : []
  )
}

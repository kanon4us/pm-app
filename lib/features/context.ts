// lib/features/context.ts
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export async function buildFeatureContext(featureId: string): Promise<string> {
  const db = await getSupabaseServiceClient()

  const { data: feature } = await db.from('features').select().eq('id', featureId).single()
  if (!feature) return ''

  const { data: fus } = await db
    .from('feature_user_stories')
    .select('user_stories(*), display_order')
    .eq('feature_id', featureId)
    .order('display_order')

  const lines: string[] = [
    `Feature: ${feature.name}`,
    `Status: ${feature.status}`,
    ...(feature.description ? [`Description: ${feature.description}`] : []),
    '',
  ]

  for (const fu of fus ?? []) {
    const story = fu.user_stories as { id: string; as_a: string; i_want: string; so_that: string } | null
    if (!story) continue
    lines.push(`User Story: As a ${story.as_a}, I want ${story.i_want} so that ${story.so_that}`)

    const { data: scenarios } = await db
      .from('scenarios').select().eq('user_story_id', story.id).order('display_order')

    for (const scenario of scenarios ?? []) {
      lines.push(`  Scenario: ${scenario.title}${scenario.description ? ` — ${scenario.description}` : ''}`)

      const { data: steps } = await db
        .from('steps').select().eq('scenario_id', scenario.id).order('display_order')

      let stepNum = 1
      for (const step of steps ?? []) {
        const img = step.figma_thumbnail_url ? ` [image: ${step.figma_thumbnail_url}]` : ' [no image]'
        const figmaLink = step.figma_url ? ` [figma: ${step.figma_url}]` : ''
        lines.push(`    Step ${stepNum}: ${step.title}${step.description ? ` — ${step.description}` : ''}${img}${figmaLink}`)
        stepNum++
      }
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

export async function buildAllFeaturesContext(featureIds?: string[]): Promise<string> {
  const db = await getSupabaseServiceClient()
  let q = db.from('features').select('id').eq('status', 'active')
  if (featureIds?.length) q = db.from('features').select('id').in('id', featureIds)
  const { data } = await q
  const ids: string[] = (data ?? []).map((f: { id: string }) => f.id)
  const blocks = await Promise.all(ids.map(buildFeatureContext))
  return blocks.filter(Boolean).join('\n---\n')
}

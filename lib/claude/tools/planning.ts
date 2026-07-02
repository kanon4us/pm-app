// lib/claude/tools/planning.ts
// Planning-phase tools for the Feature Editor chat. Executors write directly to
// Supabase (the PM gate is spec approval, not per-proposal confirmation) and are
// append-only for panel content: existing stories/scenarios/steps are never mutated.
import type Anthropic from '@anthropic-ai/sdk'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { createUserStory, linkStory, getFeatureStories } from '@/lib/user-stories/client'
import { createScenario, createStep, getScenarioSteps } from '@/lib/scenarios/client'
import { updateFeature } from '@/lib/features/client'

interface StepInput { title: string; description?: string }
interface ScenarioInput { title: string; description?: string; steps?: StepInput[] }
interface StoryInput { title?: string; as_a: string; i_want: string; so_that: string; scenarios?: ScenarioInput[] }

export interface AppliedChanges {
  stories: number
  scenarios: number
  steps: number
  specUpdated: boolean
  filesInspected: number
  prototypePrUrl: string | null
}

export function emptyApplied(): AppliedChanges {
  return { stories: 0, scenarios: 0, steps: 0, specUpdated: false, filesInspected: 0, prototypePrUrl: null }
}

const stepSchema = {
  type: 'object' as const,
  properties: {
    title: { type: 'string', description: 'Short imperative step title' },
    description: { type: 'string', description: 'What the user sees/does in this step' },
  },
  required: ['title'],
}

export const PLANNING_TOOLS: Anthropic.Tool[] = [
  {
    name: 'propose_plan',
    description:
      'Create NEW user stories (with scenarios and steps) in the feature panel. Append-only: never edits existing items. Call only after the PM agreed on the direction.',
    input_schema: {
      type: 'object',
      properties: {
        rationale: { type: 'string', description: 'One or two sentences on why this structure' },
        user_stories: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              as_a: { type: 'string' },
              i_want: { type: 'string' },
              so_that: { type: 'string' },
              scenarios: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    steps: { type: 'array', items: stepSchema },
                  },
                  required: ['title'],
                },
              },
            },
            required: ['as_a', 'i_want', 'so_that'],
          },
        },
      },
      required: ['rationale', 'user_stories'],
    },
  },
  {
    name: 'add_steps',
    description:
      'Append steps to an EXISTING scenario. Use the scenario id shown as (id: ...) in the Current Feature State.',
    input_schema: {
      type: 'object',
      properties: {
        scenario_id: { type: 'string' },
        steps: { type: 'array', items: stepSchema },
      },
      required: ['scenario_id', 'steps'],
    },
  },
  {
    name: 'write_spec',
    description:
      "Save or fully replace the feature's markdown spec. The PM approves it separately; overwrite freely as decisions evolve.",
    input_schema: {
      type: 'object',
      properties: {
        spec_markdown: { type: 'string', description: 'The complete spec document (markdown)' },
        summary_of_changes: { type: 'string', description: 'One sentence on what changed since the last version' },
      },
      required: ['spec_markdown', 'summary_of_changes'],
    },
  },
]

export async function executePlanningTool(
  featureId: string,
  toolName: string,
  input: unknown,
  applied: AppliedChanges
): Promise<{ result: string; isError: boolean }> {
  try {
    switch (toolName) {
      case 'propose_plan':
        return { result: await executeProposePlan(featureId, input as { user_stories: StoryInput[] }, applied), isError: false }
      case 'add_steps':
        return { result: await executeAddSteps(input as { scenario_id: string; steps: StepInput[] }, applied), isError: false }
      case 'write_spec':
        return { result: await executeWriteSpec(featureId, input as { spec_markdown: string }, applied), isError: false }
      default:
        return { result: `Unknown tool: ${toolName}`, isError: true }
    }
  } catch (err) {
    return { result: err instanceof Error ? err.message : 'Tool execution failed', isError: true }
  }
}

async function executeProposePlan(
  featureId: string,
  input: { user_stories: StoryInput[] },
  applied: AppliedChanges
): Promise<string> {
  if (!input.user_stories?.length) throw new Error('user_stories is empty')
  const existingCount = (await getFeatureStories(featureId)).length

  for (const [i, story] of input.user_stories.entries()) {
    const created = await createUserStory({
      title: story.title ?? story.as_a,
      as_a: story.as_a,
      i_want: story.i_want,
      so_that: story.so_that,
    })
    await linkStory(featureId, created.id, existingCount + i)
    applied.stories++

    for (const [j, scenario] of (story.scenarios ?? []).entries()) {
      const createdScenario = await createScenario({
        user_story_id: created.id,
        title: scenario.title,
        description: scenario.description ?? null,
        display_order: j,
      })
      applied.scenarios++

      for (const [k, step] of (scenario.steps ?? []).entries()) {
        await createStep({
          scenario_id: createdScenario.id,
          title: step.title,
          description: step.description ?? null,
          display_order: k,
        })
        applied.steps++
      }
    }
  }
  return `Applied: created ${applied.stories} user stor${applied.stories === 1 ? 'y' : 'ies'}, ${applied.scenarios} scenario(s), ${applied.steps} step(s). The panel now shows them.`
}

async function executeAddSteps(
  input: { scenario_id: string; steps: StepInput[] },
  applied: AppliedChanges
): Promise<string> {
  if (!input.steps?.length) throw new Error('steps is empty')
  const db = await getSupabaseServiceClient()
  const { data: scenario } = await db.from('scenarios').select('id, title').eq('id', input.scenario_id).single()
  if (!scenario) throw new Error(`Scenario ${input.scenario_id} not found — use an (id: ...) from the Current Feature State`)

  const existing = await getScenarioSteps(input.scenario_id)
  let order = existing.length ? Math.max(...existing.map((s) => s.display_order)) + 1 : 0
  for (const step of input.steps) {
    await createStep({
      scenario_id: input.scenario_id,
      title: step.title,
      description: step.description ?? null,
      display_order: order++,
    })
    applied.steps++
  }
  return `Applied: appended ${input.steps.length} step(s) to scenario "${scenario.title}".`
}

async function executeWriteSpec(
  featureId: string,
  input: { spec_markdown: string },
  applied: AppliedChanges
): Promise<string> {
  if (!input.spec_markdown?.trim()) throw new Error('spec_markdown is empty')
  await updateFeature(featureId, { spec_content: input.spec_markdown })
  applied.specUpdated = true
  return 'Spec draft saved. The PM can review and approve it from the Spec panel.'
}

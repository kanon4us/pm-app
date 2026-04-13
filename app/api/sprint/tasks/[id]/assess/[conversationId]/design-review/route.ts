import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Anthropic: typeof import('@anthropic-ai/sdk').default = require('@anthropic-ai/sdk').default
import { parseFigmaUrl, fetchFigmaFrames } from '@/lib/figma/client'
import type { FigmaFrame } from '@/lib/figma/client'
import type { Json } from '@/lib/supabase/types'

export const maxDuration = 60

type Params = { params: Promise<{ id: string; conversationId: string }> }

export type TourStepType = 'mapped' | 'visual-only' | 'not-yet-designed'

export interface TourStep {
  stepNumber: number
  title: string
  userStoryText: string | null
  figmaFrameId: string | null
  figmaFrameName: string | null
  type: TourStepType
}

interface DesignReviewResult {
  steps: TourStep[]
  divergenceNotes: string
  figmaFrames: FigmaFrame[]
  warnings: string[]
  generatedAt: string
}

const CLAUDE_MODEL = 'claude-opus-4-6'

// POST /api/sprint/tasks/[id]/assess/[conversationId]/design-review
// Idempotent: returns cached result if assessment_conversations.design_review is already populated.
// When no cache: fetches Figma frames, calls Claude to map user stories to frames, persists result.
export async function POST(req: NextRequest, { params }: Params) {
  const { id, conversationId } = await params
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { figmaLink?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const { figmaLink } = body

  const supabase = await getSupabaseServiceClient()

  // ── Auth ──────────────────────────────────────────────────────────────────────
  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // ── Load conversation (check cache) ───────────────────────────────────────────
  // Cast required until migration 006 is applied and Supabase types are regenerated.
  const { data: conv } = await (supabase
    .from('assessment_conversations')
    .select('id, task_id, design_review')
    .eq('id', conversationId)
    .eq('task_id', id)
    .single() as unknown as Promise<{ data: { id: string; task_id: string; design_review: unknown } | null; error: unknown }>)
  if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

  // ── Return cached result if already generated ─────────────────────────────────
  if (conv.design_review) {
    return NextResponse.json({ ...(conv.design_review as unknown as DesignReviewResult), cached: true })
  }

  // ── Load task + objective assessments in parallel ─────────────────────────────
  const [{ data: task }, { data: objAssessments }] = await Promise.all([
    supabase.from('tasks').select('id, name').eq('id', id).single(),
    supabase.from('objective_assessments').select('objective_id, score, reasoning').eq('task_id', id),
  ])
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  // ── Fetch Figma frames ────────────────────────────────────────────────────────
  const warnings: string[] = []
  let figmaFrames: FigmaFrame[] = []

  if (figmaLink) {
    const parsed = parseFigmaUrl(figmaLink)
    if (!parsed) {
      warnings.push('invalid_figma_url')
    } else {
      const { data: figmaToken } = await supabase
        .from('oauth_tokens')
        .select('access_token')
        .eq('user_id', user.id)
        .eq('provider', 'figma')
        .single()

      if (!figmaToken?.access_token) {
        warnings.push('figma_auth_required')
      } else {
        const result = await fetchFigmaFrames(figmaToken.access_token, parsed.fileKey, parsed.nodeId)
        figmaFrames = result.frames
        if (result.warnings.length > 0) warnings.push('figma_unavailable')
      }
    }
  } else {
    warnings.push('no_figma_link')
  }

  // ── Claude: map user stories to frames ───────────────────────────────────────
  const frameListText = figmaFrames.length > 0
    ? figmaFrames.map((f, i) => `${i + 1}. Frame ID: ${f.id} | Name: "${f.name}"`).join('\n')
    : '(No Figma frames available)'

  const objectivesText = (objAssessments ?? [])
    .map((o) => `Objective ${o.objective_id} (score: ${o.score}): ${o.reasoning ?? 'No reasoning'}`)
    .join('\n')

  const anthropic = new Anthropic()
  let claudeResult: { steps: TourStep[]; divergenceNotes: string }

  try {
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: `You are a product analyst mapping user stories to Figma design frames.
Return a JSON object with exactly two keys:
- "steps": array of TourStep objects
- "divergenceNotes": string describing gaps between stories and design

TourStep schema:
{
  "stepNumber": number,
  "title": string,
  "userStoryText": string | null,
  "figmaFrameId": string | null,
  "figmaFrameName": string | null,
  "type": "mapped" | "visual-only" | "not-yet-designed"
}

Rules:
- "mapped": both a frame and a user story exist for this step
- "visual-only": a frame exists but no user story covers it
- "not-yet-designed": a user story exists but no frame covers it
- Order steps logically (user journey order)
- Keep userStoryText to 1-2 sentences
- Return ONLY valid JSON, no markdown fences`,
      messages: [
        {
          role: 'user',
          content: `Feature: ${task.name}

Objective Assessment Reasoning (these describe the design intent):
${objectivesText}

Figma Frames:
${frameListText}

Map the user stories implied by the objective reasoning to the Figma frames above.
Return the JSON object.`,
        },
      ],
    })

    const rawText = response.content.find((b) => b.type === 'text')?.text ?? '{}'
    claudeResult = JSON.parse(rawText)
    if (!Array.isArray(claudeResult?.steps) || typeof claudeResult?.divergenceNotes !== 'string') {
      console.error(`[design-review task=${id} conv=${conversationId}] Claude returned invalid shape:`, rawText.slice(0, 200))
      return NextResponse.json({ error: 'Tour generation failed' }, { status: 500 })
    }
  } catch (err) {
    console.error(`[design-review task=${id} conv=${conversationId}] Claude error:`, err)
    return NextResponse.json({ error: 'Tour generation failed' }, { status: 500 })
  }

  // ── Persist to Supabase ───────────────────────────────────────────────────────
  const result: DesignReviewResult = {
    steps: claudeResult.steps,
    divergenceNotes: claudeResult.divergenceNotes,
    figmaFrames,
    warnings,
    generatedAt: new Date().toISOString(),
  }

  // Cast required until migration 006 is applied and Supabase types are regenerated.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updateError } = await supabase
    .from('assessment_conversations')
    .update({ design_review: result as unknown as Json } as any)
    .eq('id', conversationId)

  if (updateError) {
    console.error(`[design-review task=${id}] Supabase persist failed:`, updateError)
    return NextResponse.json({ error: 'Failed to persist design review' }, { status: 500 })
  }

  return NextResponse.json({ ...result, cached: false })
}

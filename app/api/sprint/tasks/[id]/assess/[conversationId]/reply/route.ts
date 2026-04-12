import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
import type { Json } from '@/lib/supabase/types'

export const maxDuration = 300

type Params = { params: Promise<{ id: string; conversationId: string }> }

const CLAUDE_MODEL = 'claude-opus-4-6'

// POST /api/sprint/tasks/[id]/assess/[conversationId]/reply
// Body: { answer: string, objectiveId: number }
// Returns either the next question, or a finalization proposal when all objectives are covered.
export async function POST(req: NextRequest, { params }: Params) {
  const { id, conversationId } = await params
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { answer, objectiveId } = await req.json()

  const supabase = await getSupabaseServiceClient()

  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // Load conversation
  const { data: conv } = await supabase
    .from('assessment_conversations')
    .select('id, task_id, proposed_scores, vault_context')
    .eq('id', conversationId)
    .eq('task_id', id)
    .single()
  if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

  // Load all prior messages
  const { data: priorMessages } = await supabase
    .from('assessment_messages')
    .select('role, content, objective_id, proposed_score, vault_evidence')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })

  // Save user answer
  await supabase.from('assessment_messages').insert({
    conversation_id: conversationId,
    role: 'user',
    content: answer,
    objective_id: objectiveId,
  })

  // Load objectives and roles for context
  const { data: objectives } = await supabase.from('objectives_registry').select('*').order('objective_id')

  // Build history for Claude
  const historyText = (priorMessages ?? []).map((m) => {
    const label = m.role === 'assistant' ? `PM Agent (about Obj ${m.objective_id})` : 'User'
    return `${label}: ${m.content}`
  }).join('\n\n')

  const proposedScores = conv.proposed_scores as Array<{ objectiveId: number; score: number; confidence: string; reasoning: string }>

  const objectivesText = (objectives ?? []).map((o) =>
    `Obj ${o.objective_id} — ${o.name} (Owner: ${o.owner_name}): ${o.mandate}`
  ).join('\n')

  const systemPrompt = `You are the Viscap PM Agent continuing an FVI assessment interview.

You have proposed scores for all 7 objectives. The user has just answered a question about one objective. Your job is to:
1. Update the score for the objective the question was about, based on the answer.
2. Determine if there are other low-confidence objectives still needing a question.
3. If yes: return the next question.
4. If no (all objectives confidently scored): return a finalization proposal.

THE 7 OBJECTIVES:
${objectivesText}

Current proposed scores (may need updating based on new answer):
${proposedScores.map((s) => `Obj ${s.objectiveId}: score=${s.score}, confidence=${s.confidence}`).join('\n')}

Your response MUST be valid JSON — no markdown, no text outside JSON:

IF more questions are needed:
{
  "type": "question",
  "updatedScore": {"objectiveId":<id>,"score":<-5 to 5>,"confidence":"high|medium|low","reasoning":"<updated reasoning>"},
  "nextQuestion": {"objectiveId":<id>,"objectiveName":"...","objectiveOwner":"...","question":"...","reasoning":"...","evidence":"...","currentProposedScore":<score>}
}

IF ready to finalize (no more questions needed):
{
  "type": "finalize",
  "updatedScore": {"objectiveId":<id>,"score":<-5 to 5>,"confidence":"high","reasoning":"<reasoning>"},
  "allScores": [{"objectiveId":<1-7>,"objectiveName":"...","objectiveOwner":"...","score":<-5 to 5>,"reasoning":"<1-2 sentences>"}],
  "proposedRoles": [{"roleName":"...","teamDomain":"agency|brand","influenceType":"DM|NDM","weight":<number>,"usageFrequency":<1-4>,"reasoning":"..."}],
  "proposedEffort": {"days":<number>,"reasoning":"..."},
  "proposedRisk": {"level":"Routine|Standard|Moderate|High|Critical","multiplier":<1.0|1.2|1.5|2.0|3.0>,"reasoning":"..."},
  "vaultSpecContent": "<full markdown content for the vault spec stub, following Feature-Spec-Template.md format>"
}`

  const userMessage = `ASSESSMENT HISTORY:
${historyText}

USER JUST ANSWERED (about Objective ${objectiveId}):
"${answer}"

Based on this answer, update the score for Objective ${objectiveId} and determine whether more questions are needed or you can finalize.`

  const anthropic = new Anthropic()
  let response: Awaited<ReturnType<typeof anthropic.messages.create>>
  try {
    response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[assess:reply task=${id} conv=${conversationId}] Anthropic API error:`, err)
    return NextResponse.json({ error: `Claude API error: ${msg}` }, { status: 500 })
  }

  const textBlock = response.content.find((b) => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    return NextResponse.json({ error: 'No response from Claude' }, { status: 500 })
  }

  let result: Record<string, unknown>
  try {
    const raw = textBlock.text.trim().replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '')
    result = JSON.parse(raw)
  } catch {
    const match = textBlock.text.match(/\{[\s\S]*\}/)
    if (!match) return NextResponse.json({ error: 'Failed to parse Claude response', raw: textBlock.text.slice(0, 500) }, { status: 500 })
    try { result = JSON.parse(match[0]) } catch {
      return NextResponse.json({ error: 'Failed to parse Claude response', raw: textBlock.text.slice(0, 500) }, { status: 500 })
    }
  }

  // Update conversation's proposed_scores with the updated score
  if (result.updatedScore) {
    const updated = result.updatedScore as { objectiveId: number; score: number; confidence: string; reasoning: string }
    const newScores = proposedScores.map((s) =>
      s.objectiveId === updated.objectiveId ? { ...s, ...updated } : s
    )
    await supabase.from('assessment_conversations').update({ proposed_scores: newScores as unknown as Json }).eq('id', conversationId)
  }

  // Save next question message if applicable
  if (result.type === 'question' && result.nextQuestion) {
    const q = result.nextQuestion as Record<string, unknown>
    await supabase.from('assessment_messages').insert({
      conversation_id: conversationId,
      role: 'assistant',
      content: q.question as string,
      objective_id: q.objectiveId as number,
      proposed_score: q.currentProposedScore as number,
      vault_evidence: q.evidence as string,
    })
  }

  return NextResponse.json(result)
}

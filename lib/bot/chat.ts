// lib/bot/chat.ts
// Turn orchestration: classify → retrieve → answer-with-citations → propose actions.
// Side effects are NEVER executed here — only drafted as proposedAction for
// user confirmation in viscap-ai-cloud-functions (/help-bot/action/confirm).

import Anthropic from '@anthropic-ai/sdk'
import { classifyMessage } from './classify'
import { searchLessons, type RetrievedLesson } from './retrieval'
import { recordChatObservation } from './observations'
import type {
  BotChatPolicy,
  BotJwtClaims,
  ChatIntent,
  ChatTurnRequest,
  ChatTurnResponse,
  ProposedAction,
} from './types'

const ESCALATION_REPLY =
  "I wasn't able to find a confident answer for this. I can connect you with our support team — they'll have your full conversation so you won't need to repeat yourself. Want me to create that ticket?"

interface AnswerJson {
  reply: string
  citations: string[]
  answered: boolean
  confidence: number
  proposed_action: ProposedAction | null
}

export function parseAnswer(raw: string): AnswerJson | null {
  const stripped = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
  try {
    const obj = JSON.parse(stripped)
    if (typeof obj.reply !== 'string') return null
    return {
      reply: obj.reply,
      citations: Array.isArray(obj.citations) ? obj.citations.map(String) : [],
      answered: Boolean(obj.answered),
      confidence: typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0,
      proposed_action: obj.proposed_action ?? null,
    }
  } catch {
    return null
  }
}

function mustEscalate(message: string, policy: BotChatPolicy): boolean {
  const phrases = policy.escalation_rules.must_escalate_phrases ?? []
  const lower = message.toLowerCase()
  return phrases.some((p) => lower.includes(p.toLowerCase()))
}

function escalationResponse(policy: BotChatPolicy, intent: ChatIntent): ChatTurnResponse {
  return {
    reply: ESCALATION_REPLY,
    citations: [],
    answered: false,
    confidence: 0,
    intent,
    proposedAction: { type: 'create_support_ticket', payload: { reason: 'escalation' } },
    policyVersion: policy.version,
  }
}

/** Validate citations against what was actually retrieved — no fabricated citations. */
export function sanitizeCitations(citations: string[], retrieved: RetrievedLesson[], max: number): string[] {
  const validIds = new Set(retrieved.map((l) => l.id))
  return citations.filter((c) => validIds.has(c)).slice(0, max)
}

export async function runChatTurn(
  req: ChatTurnRequest,
  claims: BotJwtClaims,
  policy: BotChatPolicy,
  client?: Anthropic,
): Promise<ChatTurnResponse> {
  const anthropic = client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const maxTurns = policy.escalation_rules.max_turns ?? 6
  const minConfidence = policy.escalation_rules.min_confidence ?? 0.5
  const maxCitations = policy.citation_rules.max_citations ?? 3

  // 1. Hard escalation triggers: explicit request for a human, or conversation too long.
  if (mustEscalate(req.message, policy) || req.turnIndex >= maxTurns) {
    const resp = escalationResponse(policy, 'escalation')
    await recordChatObservation({
      conversation_ref: req.conversationRef,
      turn_index: req.turnIndex,
      policy_version: policy.version,
      classification: 'escalation',
      page_slug: req.pageSlug,
      workspace_id: claims.teamId,
      answered: false,
      event_type: 'escalated',
    })
    return resp
  }

  // 2. Classify (or continue a prior intent mid-interview).
  const classification = req.priorIntent
    ? { intent: req.priorIntent, confidence: 1, reasoning: 'continuing prior intent' }
    : await classifyMessage(req.message, policy, anthropic)

  // 3. Retrieve — entitlement filter from verified claims only.
  let retrieved: RetrievedLesson[] = []
  let retrievalFailed = false
  try {
    retrieved = await searchLessons(req.message, claims)
  } catch (err) {
    console.error('[bot-chat] retrieval failed:', err)
    retrievalFailed = true
  }

  // 4. No content and not an interview-style intent → ripcord.
  const interviewIntents: ChatIntent[] = ['bug', 'feature_suggestion']
  if ((retrievalFailed || retrieved.length === 0) && !interviewIntents.includes(classification.intent)) {
    const resp = escalationResponse(policy, classification.intent)
    await recordChatObservation({
      conversation_ref: req.conversationRef,
      turn_index: req.turnIndex,
      policy_version: policy.version,
      classification: classification.intent,
      page_slug: req.pageSlug,
      workspace_id: claims.teamId,
      answered: false,
      event_type: retrievalFailed ? 'escalated' : 'content_gap',
    })
    return resp
  }

  // 5. Answer with citations.
  const lessonContext = retrieved
    .map((l) => `<lesson id="${l.id}" title="${l.title}" type="${l.type}">\n${l.body}\n</lesson>`)
    .join('\n\n')

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: `${policy.answer_prompt}\n\nIntent for this turn: ${classification.intent}.${
      policy.manual_directives.length ? `\n\nManual directives:\n- ${policy.manual_directives.join('\n- ')}` : ''
    }`,
    messages: [
      {
        role: 'user',
        content: `<retrieved_lessons>\n${lessonContext}\n</retrieved_lessons>\n\n<user_message>\n${req.message}\n</user_message>\n\nPage: ${req.pageSlug ?? 'unknown'}`,
      },
    ],
  })

  const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
  const parsed = parseAnswer(text)

  // 6. Unparseable or low-confidence → ripcord.
  if (!parsed || (!parsed.answered && parsed.confidence < minConfidence && !parsed.proposed_action)) {
    const resp = escalationResponse(policy, classification.intent)
    await recordChatObservation({
      conversation_ref: req.conversationRef,
      turn_index: req.turnIndex,
      policy_version: policy.version,
      classification: classification.intent,
      page_slug: req.pageSlug,
      workspace_id: claims.teamId,
      answered: false,
      confidence: parsed?.confidence ?? 0,
      event_type: 'escalated',
    })
    return resp
  }

  const citations = sanitizeCitations(parsed.citations, retrieved, maxCitations)

  const result: ChatTurnResponse = {
    reply: parsed.reply,
    citations,
    answered: parsed.answered,
    confidence: parsed.confidence,
    intent: classification.intent,
    proposedAction: parsed.proposed_action,
    policyVersion: policy.version,
  }

  await recordChatObservation({
    conversation_ref: req.conversationRef,
    turn_index: req.turnIndex,
    policy_version: policy.version,
    classification: classification.intent,
    cited_lesson_ids: citations,
    page_slug: req.pageSlug,
    workspace_id: claims.teamId,
    answered: parsed.answered,
    confidence: parsed.confidence,
    event_type: parsed.proposed_action ? 'action_proposed' : 'turn',
  })

  return result
}

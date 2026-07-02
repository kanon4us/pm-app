// lib/features/conversation.ts
import Anthropic from '@anthropic-ai/sdk'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildFeatureContext } from '@/lib/features/context'
import { getFeature, type Feature } from '@/lib/features/client'
import { PLANNING_SYSTEM } from '@/lib/claude/prompts/planning'
import { PROTOTYPING_SYSTEM } from '@/lib/claude/prompts/prototyping'
import { PLANNING_TOOLS, executePlanningTool, emptyApplied, type AppliedChanges } from '@/lib/claude/tools/planning'
import { PROTOTYPING_TOOLS, PROTOTYPING_TOOL_NAMES, executePrototypingTool } from '@/lib/claude/tools/prototyping'
import type { Tables } from '@/lib/supabase/types'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 4096

export type FeatureConversation = Tables<'feature_conversations'>
export type FeatureMessage = Tables<'feature_messages'>

export async function getOrCreateConversation(featureId: string): Promise<FeatureConversation> {
  const db = await getSupabaseServiceClient()
  const { data: existing } = await db
    .from('feature_conversations')
    .select()
    .eq('feature_id', featureId)
    .single()
  if (existing) return existing
  const { data: created, error } = await db
    .from('feature_conversations')
    .insert({ feature_id: featureId })
    .select()
    .single()
  if (error || !created) throw new Error('Failed to create conversation')
  return created
}

export async function addMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string
): Promise<FeatureMessage> {
  const db = await getSupabaseServiceClient()
  const { data, error } = await db
    .from('feature_messages')
    .insert({ conversation_id: conversationId, role, content })
    .select()
    .single()
  if (error || !data) throw new Error('Failed to save message')
  return data
}

export async function getMessages(conversationId: string): Promise<FeatureMessage[]> {
  const db = await getSupabaseServiceClient()
  const { data } = await db
    .from('feature_messages')
    .select()
    .eq('conversation_id', conversationId)
    .order('created_at')
  return data ?? []
}

// Tool-round budget per PM message: planning turns stay conversational (a plan
// mutation + a narration round); prototyping turns explore the product repo.
const PLANNING_MAX_TOOL_ROUNDS = 3
const PROTOTYPING_MAX_TOOL_ROUNDS = 25

export async function sendFeatureMessage(
  featureId: string,
  userContent: string
): Promise<{ content: string; applied: AppliedChanges | null }> {
  const feature = await getFeature(featureId)
  if (!feature) throw new Error('Feature not found')
  const conversation = await getOrCreateConversation(featureId)
  const history = await getMessages(conversation.id)
  const featureContext = await buildFeatureContext(featureId)

  await addMessage(conversation.id, 'user', userContent)

  const prototypingActive = feature.planning_phase !== 'planning'
  const tools = prototypingActive ? [...PLANNING_TOOLS, ...PROTOTYPING_TOOLS] : PLANNING_TOOLS
  const maxToolRounds = prototypingActive ? PROTOTYPING_MAX_TOOL_ROUNDS : PLANNING_MAX_TOOL_ROUNDS
  const system = buildSystem(feature, featureContext, prototypingActive)

  let messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: userContent },
  ]

  const applied = emptyApplied()
  const textParts: string[] = []
  let budgetReached = false

  for (let round = 0; ; round++) {
    const response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS, system, tools, messages,
    })
    textParts.push(...collectText(response))
    if (response.stop_reason !== 'tool_use') break

    // Always execute what the model requested, even on the last round —
    // a dangling tool_use with no execution would silently drop work.
    const toolResults = await runTools(featureId, response, applied)
    if (round + 1 >= maxToolRounds) {
      budgetReached = true
      break
    }
    messages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResults },
    ]
  }

  const markers = buildMarkers(applied)
  if (budgetReached) markers.push('[Tool budget reached — reply to continue]')
  const assistantContent = [textParts.join('\n\n').trim(), ...markers].filter(Boolean).join('\n\n')
  if (!assistantContent) throw new Error('Claude returned no response')
  await addMessage(conversation.id, 'assistant', assistantContent)

  const anyChange =
    applied.stories > 0 || applied.scenarios > 0 || applied.steps > 0 || applied.specUpdated || applied.prototypePrUrl !== null
  return { content: assistantContent, applied: anyChange ? applied : null }
}

function buildSystem(feature: Feature, featureContext: string, prototypingActive: boolean): string {
  const parts = [PLANNING_SYSTEM]
  if (prototypingActive) {
    parts.push(PROTOTYPING_SYSTEM)
    if (feature.code_paths?.length) {
      parts.push(`Suggested Starting Points in the product repo:\n${feature.code_paths.map((p) => `- ${p}`).join('\n')}`)
    }
  }
  parts.push(`--- Current Feature State ---\n${featureContext}`)
  return parts.join('\n\n')
}

function collectText(response: Anthropic.Message): string[] {
  return response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text)
}

async function runTools(
  featureId: string,
  response: Anthropic.Message,
  applied: AppliedChanges
): Promise<Anthropic.ToolResultBlockParam[]> {
  const results: Anthropic.ToolResultBlockParam[] = []
  for (const block of response.content) {
    if (block.type !== 'tool_use') continue
    const isPrototyping = (PROTOTYPING_TOOL_NAMES as readonly string[]).includes(block.name)
    const { result, isError } = isPrototyping
      ? await executePrototypingTool(featureId, block.name, block.input, applied)
      : await executePlanningTool(featureId, block.name, block.input, applied)
    results.push({ type: 'tool_result', tool_use_id: block.id, content: result, is_error: isError })
  }
  return results
}

// Persisted history is text-only; these markers keep tool activity visible to
// the PM and to Claude on replay without reconstructing tool_use blocks.
function buildMarkers(applied: AppliedChanges): string[] {
  const markers: string[] = []
  if (applied.stories > 0 || applied.scenarios > 0 || applied.steps > 0) {
    const parts = [
      ...(applied.stories > 0 ? [`${applied.stories} stor${applied.stories === 1 ? 'y' : 'ies'}`] : []),
      ...(applied.scenarios > 0 ? [`${applied.scenarios} scenario(s)`] : []),
      ...(applied.steps > 0 ? [`${applied.steps} step(s)`] : []),
    ]
    markers.push(`[Applied to panel: ${parts.join(', ')}]`)
  }
  if (applied.specUpdated) markers.push('[Spec draft updated]')
  if (applied.filesInspected > 0) markers.push(`[Inspected ${applied.filesInspected} file(s) in the product repo]`)
  if (applied.prototypePrUrl) markers.push(`[Prototype PR: ${applied.prototypePrUrl}]`)
  return markers
}

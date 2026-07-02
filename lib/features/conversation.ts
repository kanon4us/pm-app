// lib/features/conversation.ts
import Anthropic from '@anthropic-ai/sdk'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildFeatureContext } from '@/lib/features/context'
import { PLANNING_SYSTEM } from '@/lib/claude/prompts/planning'
import { PLANNING_TOOLS, executePlanningTool, emptyApplied, type AppliedChanges } from '@/lib/claude/tools/planning'
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

export async function sendFeatureMessage(
  featureId: string,
  userContent: string
): Promise<{ content: string; applied: AppliedChanges | null }> {
  const conversation = await getOrCreateConversation(featureId)
  const history = await getMessages(conversation.id)
  const featureContext = await buildFeatureContext(featureId)

  await addMessage(conversation.id, 'user', userContent)

  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: userContent },
  ]
  const system = `${PLANNING_SYSTEM}\n\n--- Current Feature State ---\n${featureContext}`

  const request = (msgs: Anthropic.MessageParam[]) =>
    client.messages.create({ model: MODEL, max_tokens: MAX_TOKENS, system, tools: PLANNING_TOOLS, messages: msgs })

  const applied = emptyApplied()
  const textParts: string[] = []

  const response = await request(messages)
  textParts.push(...collectText(response))

  if (response.stop_reason === 'tool_use') {
    const toolResults = await runTools(featureId, response, applied)

    // One continuation so Claude can narrate what it applied. If it tool-calls
    // again here, we execute but do not continue further (prompt allows one
    // plan mutation per turn; write_spec commonly rides along).
    const continuation = await request([
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResults },
    ])
    textParts.push(...collectText(continuation))
    if (continuation.stop_reason === 'tool_use') {
      await runTools(featureId, continuation, applied)
    }
  }

  const markers = buildMarkers(applied)
  const assistantContent = [textParts.join('\n\n').trim(), ...markers].filter(Boolean).join('\n\n')
  if (!assistantContent) throw new Error('Claude returned no response')
  await addMessage(conversation.id, 'assistant', assistantContent)

  const anyChange = applied.stories > 0 || applied.scenarios > 0 || applied.steps > 0 || applied.specUpdated
  return { content: assistantContent, applied: anyChange ? applied : null }
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
    const { result, isError } = await executePlanningTool(featureId, block.name, block.input, applied)
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
  return markers
}

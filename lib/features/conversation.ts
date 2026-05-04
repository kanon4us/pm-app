// lib/features/conversation.ts
import Anthropic from '@anthropic-ai/sdk'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildFeatureContext } from '@/lib/features/context'
import type { Tables } from '@/lib/supabase/types'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export type FeatureConversation = Tables<'feature_conversations'>
export type FeatureMessage = Tables<'feature_messages'>

const CONVERSATION_SYSTEM = `You are a product design assistant helping a PM refine a feature's user stories, scenarios, and steps.

You have full context of the feature's current state. You can:
- Suggest new steps (format as: **[SUGGESTED STEP]** Title: "..." | Description: "...")
- Critique scenario completeness
- Annotate or improve step descriptions
- Generate an HTML prototype when asked (return ONLY the HTML, no markdown fences)
- Help identify UX gaps

Be concise and actionable.`

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
): Promise<{ content: string; suggestedStep: { title: string; description: string } | null }> {
  const conversation = await getOrCreateConversation(featureId)
  const history = await getMessages(conversation.id)
  const featureContext = await buildFeatureContext(featureId)

  await addMessage(conversation.id, 'user', userContent)

  const messages = [
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user' as const, content: userContent },
  ]

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: `${CONVERSATION_SYSTEM}\n\n--- Current Feature State ---\n${featureContext}`,
    messages,
  })

  const block = response.content.find((b) => b.type === 'text')
  if (!block || block.type !== 'text' || !block.text) throw new Error('Claude returned no response')
  const assistantContent = block.text
  await addMessage(conversation.id, 'assistant', assistantContent)

  const suggestedStep = parseSuggestedStep(assistantContent)
  return { content: assistantContent, suggestedStep }
}

function parseSuggestedStep(text: string): { title: string; description: string } | null {
  const match = text.match(/\*\*\[SUGGESTED STEP\]\*\*\s+Title:\s*"([^"]+)"\s*\|\s*Description:\s*"([^"]+)"/)
  if (!match) return null
  return { title: match[1], description: match[2] }
}

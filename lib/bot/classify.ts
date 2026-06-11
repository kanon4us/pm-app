// lib/bot/classify.ts
import Anthropic from '@anthropic-ai/sdk'
import type { BotChatPolicy, ChatIntent } from './types'

const VALID_INTENTS: ChatIntent[] = ['question', 'user_error', 'bug', 'feature_suggestion']

export interface ClassificationResult {
  intent: ChatIntent
  confidence: number
  reasoning: string
}

/**
 * Classifies a user message into one of the four intake intents.
 * The user message is wrapped in delimiters and treated as DATA —
 * the policy prompt instructs the model to ignore embedded instructions.
 */
export async function classifyMessage(
  message: string,
  policy: BotChatPolicy,
  client?: Anthropic,
): Promise<ClassificationResult> {
  const anthropic = client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system: policy.classification_prompt,
    messages: [
      {
        role: 'user',
        content: `<user_message>\n${message}\n</user_message>`,
      },
    ],
  })

  const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
  const parsed = parseClassification(text)
  if (!parsed) {
    // Unparseable model output — treat as a question (safest default) with low confidence.
    return { intent: 'question', confidence: 0, reasoning: 'classification parse failure' }
  }
  return parsed
}

export function parseClassification(raw: string): ClassificationResult | null {
  const stripped = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
  try {
    const obj = JSON.parse(stripped)
    if (!VALID_INTENTS.includes(obj.intent)) return null
    const confidence = typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0
    return { intent: obj.intent, confidence, reasoning: String(obj.reasoning ?? '') }
  } catch {
    return null
  }
}

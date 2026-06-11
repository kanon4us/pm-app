// lib/bot/observations.ts
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import type { ChatObservation } from './types'

/**
 * Records a derived-signal observation for a chat turn.
 *
 * PRIVACY BOUNDARY (D6): message text must NEVER be stored in Supabase.
 * This function strips any text-like keys defensively before insert.
 * Conversations live in Viscap's Firestore — we keep only references.
 */
const FORBIDDEN_KEYS = ['message', 'message_text', 'messageText', 'text', 'reply', 'transcript', 'body', 'content']

export function stripForbiddenKeys<T extends Record<string, unknown>>(obs: T): T {
  const clean = { ...obs }
  for (const key of FORBIDDEN_KEYS) {
    if (key in clean) {
      console.error(`[bot-observations] privacy guard: stripped forbidden key "${key}" (D6)`)
      delete clean[key]
    }
  }
  return clean
}

export async function recordChatObservation(obs: ChatObservation): Promise<void> {
  const supabase = await getSupabaseServiceClient()
  const clean = stripForbiddenKeys(obs as unknown as Record<string, unknown>)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.from('bot_chat_observations') as any).insert(clean)
  if (error) console.error('[bot-observations] insert failed:', error)
}

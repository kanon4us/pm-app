// lib/bot/policies.ts
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import type { BotChatPolicy } from './types'

export async function getActiveChatPolicy(): Promise<BotChatPolicy> {
  const supabase = await getSupabaseServiceClient()
  const { data, error } = await supabase
    .from('bot_chat_policies')
    .select('*')
    .eq('status', 'active')
    .single()

  if (error || !data) throw new Error('No active chat policy found')
  return data as BotChatPolicy
}

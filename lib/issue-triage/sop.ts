// lib/issue-triage/sop.ts
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import type { BotSop } from './types'

export async function getActiveSop(): Promise<BotSop> {
  const supabase = await getSupabaseServiceClient()
  const { data, error } = await supabase
    .from('bot_sops')
    .select('*')
    .eq('status', 'active')
    .single()

  if (error || !data) throw new Error('No active SOP found')
  return data as BotSop
}

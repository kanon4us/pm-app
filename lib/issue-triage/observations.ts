// lib/issue-triage/observations.ts
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import type { ObservationEventType } from './types'

export async function recordObservation(
  threadTs: string,
  clickupTaskId: string | null,
  sopVersion: number,
  eventType: ObservationEventType,
  payload: Record<string, unknown>,
): Promise<void> {
  const supabase = await getSupabaseServiceClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.from('bot_observations') as any).insert({
    thread_ts: threadTs,
    clickup_task_id: clickupTaskId,
    sop_version: sopVersion,
    event_type: eventType,
    payload,
  })
  if (error) console.error('[observations] insert failed:', error)
}

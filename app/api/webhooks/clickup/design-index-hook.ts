// app/api/webhooks/clickup/design-index-hook.ts
import type { getSupabaseServiceClient } from '@/lib/supabase/server'
import { isDesignIndexStatus, extractFigmaUrl } from '@/lib/design-index/inbox-trigger'

type Supabase = Awaited<ReturnType<typeof getSupabaseServiceClient>>

export interface DesignIndexHookInput {
  clickupTaskId: string
  taskName: string
  toStatus: string
  customFields: { name?: string; value?: unknown }[] | undefined
}

/** Upserts a design_index_inbox row when the ticket status is a configured trigger. */
export async function maybeQueueDesignIndex(
  supabase: Supabase,
  input: DesignIndexHookInput,
  configuredStatuses: string[]
): Promise<void> {
  if (!isDesignIndexStatus(input.toStatus, configuredStatuses)) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase.from('design_index_inbox') as any).upsert(
    {
      clickup_task_id: input.clickupTaskId,
      title: input.taskName,
      figma_url: extractFigmaUrl(input.customFields),
      trigger_status: input.toStatus,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'clickup_task_id' }
  )
}

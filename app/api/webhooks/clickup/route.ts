import { NextRequest, NextResponse } from 'next/server'
import { verifyClickUpSignature, parseWebhookEvent } from '@/lib/clickup/webhook'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildClickUpClient } from '@/lib/clickup/client'
import type { Json } from '@/lib/supabase/types'

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const signature = req.headers.get('x-signature') ?? ''

  if (!verifyClickUpSignature(rawBody, signature, process.env.CLICKUP_WEBHOOK_SECRET!)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const payload = JSON.parse(rawBody) as Record<string, unknown>
  const event = parseWebhookEvent(payload)
  console.log('[webhook] parsed', JSON.stringify({ event: payload.event, parsedEvent: event, historyItem0: (payload.history_items as unknown[])?.[0] }))
  if (!event) return NextResponse.json({ ok: true }) // Unsupported event — ack and ignore

  const supabase = await getSupabaseServiceClient()

  // Find the task by ClickUp task ID
  let { data: task } = await supabase
    .from('tasks')
    .select('id, list_id, status')
    .eq('clickup_task_id', event.taskId)
    .single()

  // Task not tracked yet — auto-import if it belongs to a subscribed list
  if (!task) {
    const { data: token } = await supabase
      .from('oauth_tokens').select('access_token').eq('provider', 'clickup').limit(1).single()

    if (token) {
      try {
        const cuTask = await buildClickUpClient(token.access_token).getTask(event.taskId)
        const { data: list } = await supabase
          .from('lists').select('id').eq('clickup_list_id', cuTask.list.id).single()

        if (list) {
          const { data: inserted } = await supabase.from('tasks').insert({
            clickup_task_id: cuTask.id,
            list_id: list.id,
            name: cuTask.name,
            status: event.toStatus,
            custom_fields: (cuTask.custom_fields ?? []) as unknown as Json,
            synced_at: new Date().toISOString(),
          }).select('id, list_id, status').single()
          task = inserted
        }
      } catch (err) {
        console.warn('[webhook] auto-import failed for task', event.taskId, err)
      }
    }

    if (!task) return NextResponse.json({ ok: true }) // Not in a subscribed list
  }

  // Find matching trigger configs for this status transition
  const { data: configs } = await supabase
    .from('trigger_configs')
    .select('*')
    .eq('list_id', task.list_id)
    .eq('to_status', event.toStatus)

  if (!configs?.length) {
    // Update task status and return — no trigger configured
    await supabase.from('tasks').update({ status: event.toStatus, synced_at: new Date().toISOString() }).eq('id', task.id)
    return NextResponse.json({ ok: true })
  }

  // Update task status
  await supabase.from('tasks').update({ status: event.toStatus, synced_at: new Date().toISOString() }).eq('id', task.id)

  // Enqueue one trigger per matching config (filter by from_status if set)
  const triggers = configs
    .filter((c) => !c.from_status || c.from_status === task.status)
    .map((config) => ({ task_id: task.id, config_id: config.id, status: 'pending' as const }))

  if (triggers.length > 0) {
    await supabase.from('trigger_queue').insert(triggers)
  }

  return NextResponse.json({ ok: true })
}

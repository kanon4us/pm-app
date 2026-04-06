import { NextRequest, NextResponse } from 'next/server'
import { verifyClickUpSignature, parseWebhookEvent } from '@/lib/clickup/webhook'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const signature = req.headers.get('x-signature') ?? ''

  if (!verifyClickUpSignature(rawBody, signature, process.env.CLICKUP_WEBHOOK_SECRET!)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const payload = JSON.parse(rawBody) as Record<string, unknown>
  const event = parseWebhookEvent(payload)
  if (!event) return NextResponse.json({ ok: true }) // Unsupported event — ack and ignore

  const supabase = await getSupabaseServiceClient()

  // Find the task by ClickUp task ID
  const { data: task } = await supabase
    .from('tasks')
    .select('id, list_id, status')
    .eq('clickup_task_id', event.taskId)
    .single()

  if (!task) return NextResponse.json({ ok: true }) // Task not in a subscribed list

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

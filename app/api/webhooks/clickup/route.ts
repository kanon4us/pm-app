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
    await handleSlackHandoff(event.taskId, event.type, event.listId, supabase)
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

  // Parallel: check if this task is tracked in slack_issues for bot handoff
  await handleSlackHandoff(event.taskId, event.type, event.listId, supabase)

  return NextResponse.json({ ok: true })
}

async function handleSlackHandoff(
  clickupTaskId: string,
  eventType: string,
  targetListId: string | undefined,
  supabase: Awaited<ReturnType<typeof getSupabaseServiceClient>>,
): Promise<void> {
  const { data: slackIssue } = await supabase
    .from('slack_issues')
    .select('*')
    .eq('clickup_task_id', clickupTaskId)
    .single()

  if (!slackIssue) return

  // Ticket returned to New Tickets list → dev sent it back for more info
  const newTicketsListId = process.env.CLICKUP_NEW_TICKETS_LIST_ID
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const issue = slackIssue as any
  if (eventType === 'taskMoved' && targetListId === newTicketsListId && issue.handoff_status === 'taken') {
    await supabase.from('slack_issues').update({
      handoff_status: 'returned',
      updated_at: new Date().toISOString(),
    }).eq('clickup_task_id', clickupTaskId)

    const token = process.env.SLACK_BOT_TOKEN
    if (token) {
      const { buildSlackClient } = await import('@/lib/slack/client')
      await buildSlackClient(token).postMessage(
        issue.channel_id,
        "🔄 The dev team needs more information — I'll follow up with some questions.",
        issue.thread_ts,
      )
    }
    return
  }

  // Already handed off — don't re-trigger
  if (issue.handoff_status === 'taken') return

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase.from('slack_issues') as any).update({
    handoff_status: 'taken',
    updated_at: new Date().toISOString(),
  }).eq('clickup_task_id', clickupTaskId)

  const token = process.env.SLACK_BOT_TOKEN
  if (!token) return

  const { buildSlackClient } = await import('@/lib/slack/client')
  const slack = buildSlackClient(token)

  // Post handoff message
  await slack.postMessage(
    issue.channel_id,
    '✅ Dev team has claimed this ticket — handing off.',
    issue.thread_ts,
  )

  // Post reporter feedback survey via Blocks
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: issue.channel_id,
      thread_ts: issue.thread_ts,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'How helpful was the support bot during this process?' },
        },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: '🟢 Helpful' }, action_id: 'survey_helpful', value: issue.thread_ts },
            { type: 'button', text: { type: 'plain_text', text: '🟡 Neutral' }, action_id: 'survey_neutral', value: issue.thread_ts },
            { type: 'button', text: { type: 'plain_text', text: '🔴 Not Helpful' }, action_id: 'survey_not_helpful', value: issue.thread_ts },
          ],
        },
      ],
    }),
  })
}

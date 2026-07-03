import { NextRequest, NextResponse } from 'next/server'
import { verifyClickUpSignature, parseWebhookEvent } from '@/lib/clickup/webhook'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildClickUpClient } from '@/lib/clickup/client'
import type { Json } from '@/lib/supabase/types'
import { maybeQueueDesignIndex } from './design-index-hook'
import { parseDesignIndexStatuses, isDesignIndexStatus } from '@/lib/design-index/inbox-trigger'
import { activateFeatureFromTask } from '@/lib/features/gatekeeper'
import { parsePrototypeStatuses, isPrototypeStatus, hasPrototypeTag } from '@/lib/features/gatekeeper-extract'

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const signature = req.headers.get('x-signature') ?? ''

  if (!verifyClickUpSignature(rawBody, signature, process.env.CLICKUP_WEBHOOK_SECRET!)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const payload = JSON.parse(rawBody) as Record<string, unknown>
  const event = parseWebhookEvent(payload)
  if (!event) return NextResponse.json({ ok: true })

  const supabase = await getSupabaseServiceClient()

  if (event.type === 'taskMoved') {
    if (!event.listId) return NextResponse.json({ ok: true })

    // Resolve destination list by ClickUp list ID
    const { data: destList } = await supabase
      .from('lists')
      .select('id')
      .eq('clickup_list_id', event.listId)
      .single()

    if (!destList) {
      await handleSlackHandoff(event.taskId, event.type, event.listId, supabase)
      return NextResponse.json({ ok: true })
    }

    // Find or auto-import the task
    let { data: task } = await supabase
      .from('tasks')
      .select('id, list_id, status')
      .eq('clickup_task_id', event.taskId)
      .single()

    if (!task) {
      const { data: token } = await supabase
        .from('oauth_tokens').select('access_token').eq('provider', 'clickup').limit(1).single()
      if (token) {
        try {
          const cuTask = await buildClickUpClient(token.access_token).getTask(event.taskId)
          const { data: inserted } = await supabase.from('tasks').insert({
            clickup_task_id: cuTask.id,
            list_id: destList.id,
            name: cuTask.name,
            custom_fields: (cuTask.custom_fields ?? []) as unknown as Json,
            synced_at: new Date().toISOString(),
          }).select('id, list_id, status').single()
          task = inserted
        } catch (err) {
          console.warn('[webhook] auto-import failed for task', event.taskId, err)
        }
      }
      if (!task) return NextResponse.json({ ok: true })
    }

    // Update list_id only — preserve status
    await supabase.from('tasks')
      .update({ list_id: destList.id, synced_at: new Date().toISOString() })
      .eq('id', task.id)

    // Find trigger configs for this destination list
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: configs } = await (supabase.from('trigger_configs') as any)
      .select('*')
      .eq('destination_list_id', destList.id)

    if (configs?.length) {
      await supabase.from('trigger_queue').insert(
        configs.map((config: { id: string }) => ({ task_id: task!.id, config_id: config.id, status: 'pending' as const }))
      )
    }

    await handleSlackHandoff(event.taskId, event.type, event.listId, supabase)
    return NextResponse.json({ ok: true })
  }

  // ── Design-index scaffold — independent of support-bot task/list resolution ──
  // Runs for ANY taskStatusUpdated whose status is a configured design status,
  // fetching task details straight from ClickUp. The tasks/lists tables may be
  // missing the task or hold duplicate list rows (which break the .single()
  // auto-import below), and neither must block the design-index queue.
  const designStatuses = parseDesignIndexStatuses(process.env.CLICKUP_DESIGN_INDEX_STATUSES)
  if (isDesignIndexStatus(event.toStatus, designStatuses)) {
    const { data: diToken } = await supabase
      .from('oauth_tokens').select('access_token').eq('provider', 'clickup').limit(1).single()
    if (diToken) {
      try {
        const cuTask = await buildClickUpClient(diToken.access_token).getTask(event.taskId)
        await maybeQueueDesignIndex(
          supabase,
          {
            clickupTaskId: event.taskId,
            taskName: cuTask.name,
            toStatus: event.toStatus,
            customFields: cuTask.custom_fields as { name?: string; value?: unknown }[] | undefined,
          },
          designStatuses
        )
      } catch (err) {
        console.warn('[design-index] scaffold fetch failed for task', event.taskId, err)
      }
    }
  }

  // ── Prototyping gatekeeper — scaffold/enrich a feature + route its app ──
  // Trigger: status ∈ CLICKUP_PROTOTYPE_STATUSES, or the proto-ready tag
  // (CLICKUP_PROTOTYPE_TAG). Independent of the trigger_configs machinery below;
  // failures are logged, never block the other hooks.
  const protoStatuses = parsePrototypeStatuses(process.env.CLICKUP_PROTOTYPE_STATUSES)
  const tagTriggered =
    event.type === 'taskTagUpdated' &&
    hasPrototypeTag(event.tags ?? [], process.env.CLICKUP_PROTOTYPE_TAG ?? 'proto-ready')
  if (isPrototypeStatus(event.toStatus, protoStatuses) || tagTriggered) {
    try {
      await activateFeatureFromTask(supabase, event.taskId)
    } catch (err) {
      console.warn('[gatekeeper] activation failed for task', event.taskId, err)
    }
  }
  // Tag events carry no status — nothing below applies to them.
  if (event.type === 'taskTagUpdated') return NextResponse.json({ ok: true })

  // taskStatusUpdated — existing behavior unchanged
  let { data: task } = await supabase
    .from('tasks')
    .select('id, list_id, status, name, custom_fields')
    .eq('clickup_task_id', event.taskId)
    .single()

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
          }).select('id, list_id, status, name, custom_fields').single()
          task = inserted
        }
      } catch (err) {
        console.warn('[webhook] auto-import failed for task', event.taskId, err)
      }
    }
    if (!task) return NextResponse.json({ ok: true })
  }

  const { data: configs } = await supabase
    .from('trigger_configs')
    .select('*')
    .eq('list_id', task.list_id)
    .eq('to_status', event.toStatus)

  await supabase.from('tasks')
    .update({ status: event.toStatus, synced_at: new Date().toISOString() })
    .eq('id', task.id)

  if (configs?.length) {
    const triggers = configs
      .filter((c) => !c.from_status || c.from_status === task!.status)
      .map((config) => ({ task_id: task!.id, config_id: config.id, status: 'pending' as const }))
    if (triggers.length > 0) {
      await supabase.from('trigger_queue').insert(triggers)
    }
  }

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

  await slack.postMessage(
    issue.channel_id,
    '✅ Dev team has claimed this ticket — handing off.',
    issue.thread_ts,
  )
}

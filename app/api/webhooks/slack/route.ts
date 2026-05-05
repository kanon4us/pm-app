import { NextRequest, NextResponse, after } from 'next/server'
import { verifySlackSignature } from '@/lib/slack/verify'
import { buildSlackClient } from '@/lib/slack/client'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { runIntakeTurn } from '@/lib/issue-triage/conversation'
import { detectDuplicate } from '@/lib/issue-triage/duplicate-detection'
import { searchForWorkaround } from '@/lib/issue-triage/workaround-search'
import { EMPTY_TICKET_DATA } from '@/lib/issue-triage/types'
import type { SlackIssue } from '@/lib/issue-triage/types'

interface SlackEvent {
  type: string
  user?: string
  bot_id?: string
  subtype?: string
  channel: string
  text: string
  ts: string
  thread_ts?: string
}

interface SlackPayload {
  type: string
  challenge?: string
  event?: SlackEvent
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text()

  // Parse body first — url_verification must respond before sig is set up
  let payload: SlackPayload
  try {
    payload = JSON.parse(rawBody) as SlackPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // URL verification handshake (no sig needed)
  if (payload.type === 'url_verification') {
    return NextResponse.json({ challenge: payload.challenge })
  }

  // Verify signature for all other requests
  const timestamp = req.headers.get('x-slack-request-timestamp') ?? ''
  const signature = req.headers.get('x-slack-signature') ?? ''
  const signingSecret = process.env.SLACK_SIGNING_SECRET ?? ''

  if (!verifySlackSignature(rawBody, timestamp, signature, signingSecret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const event = payload.event
  if (!event) return NextResponse.json({ ok: true })

  // Guard: ignore bot messages and off-channel messages
  const issuesChannel = process.env.SLACK_ISSUES_CHANNEL_ID
  if (!issuesChannel) {
    console.error('[slack-webhook] SLACK_ISSUES_CHANNEL_ID is not set — dropping event')
    return NextResponse.json({ ok: true })
  }
  if (event.bot_id || event.subtype === 'bot_message') return NextResponse.json({ ok: true })
  if (event.channel !== issuesChannel) return NextResponse.json({ ok: true })
  if (!event.user) return NextResponse.json({ ok: true })

  // ACK immediately — all work in after()
  after(async () => {
    try {
      await processSlackEvent(event)
    } catch (err) {
      console.error('[slack-webhook] after() error:', err)
    }
  })

  return NextResponse.json({ ok: true })
}

async function processSlackEvent(event: SlackEvent): Promise<void> {
  const supabase = await getSupabaseServiceClient()
  const slack = buildSlackClient(process.env.SLACK_BOT_TOKEN ?? '')

  // Replies use thread_ts; new messages use their own ts as the thread key
  const threadTs = event.thread_ts ?? event.ts

  const { data: existing } = await supabase
    .from('slack_issues')
    .select('*')
    .eq('thread_ts', threadTs)
    .single()

  const issue = existing as SlackIssue | null

  // Bot is silent when dev has claimed the ticket
  if (issue?.handoff_status === 'taken') return

  // Non-reporter spoke in thread → team feedback (Phase B will handle this properly)
  if (issue && event.user !== issue.reporter_id) {
    return
  }

  // New issue
  if (!issue) {
    const newIssue = {
      thread_ts: threadTs,
      channel_id: event.channel,
      reporter_id: event.user ?? '',
      status: 'gathering' as const,
      ticket_data: { ...EMPTY_TICKET_DATA },
      metadata: { logrocket_links: [], file_ids: [], vault_snippets_used: [], triage_reasoning: '' },
      handoff_status: null,
      sop_version: null,
      clickup_task_id: null,
      last_msg_ts: event.ts,
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: insertError } = await supabase.from('slack_issues').insert(newIssue as any)
    if (insertError) {
      console.error('[slack-webhook] failed to insert new issue:', insertError)
      return
    }
    const fullIssue: SlackIssue = { ...newIssue, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    await handleGathering(fullIssue, event, slack, supabase)
    return
  }

  if (issue.status === 'gathering') {
    await handleGathering(issue, event, slack, supabase)
  } else if (issue.status === 'confirming') {
    await handleConfirming(issue, event, slack, supabase)
  }
  // triaging / complete / human_takeover: silent
}

async function handleGathering(
  issue: SlackIssue,
  event: SlackEvent,
  slack: ReturnType<typeof buildSlackClient>,
  supabase: Awaited<ReturnType<typeof getSupabaseServiceClient>>,
): Promise<void> {
  const history = await slack.getThreadReplies(event.channel, issue.thread_ts).catch(() => [])
  const result = await runIntakeTurn(issue, event.text, history)

  const newStatus = result.confidence >= 0.8 ? 'confirming' : 'gathering'

  await supabase
    .from('slack_issues')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update({ ticket_data: result.updated_schema as any, status: newStatus, last_msg_ts: event.ts, updated_at: new Date().toISOString() })
    .eq('thread_ts', issue.thread_ts)

  await slack.postMessage(event.channel, result.bot_response, issue.thread_ts)
}

async function handleConfirming(
  issue: SlackIssue,
  event: SlackEvent,
  slack: ReturnType<typeof buildSlackClient>,
  supabase: Awaited<ReturnType<typeof getSupabaseServiceClient>>,
): Promise<void> {
  const text = event.text.toLowerCase().trim()
  const isYes = /\b(yes|submit|go ahead|confirm|yep|yeah|sure|ok|okay)\b/.test(text)
  const isNo = /\b(no|wait|hold on|actually|not yet|forgot)\b/.test(text)

  if (isYes) {
    await supabase
      .from('slack_issues')
      .update({ status: 'triaging', updated_at: new Date().toISOString() })
      .eq('thread_ts', issue.thread_ts)

    await slack.postMessage(event.channel, '⏳ Got it! Running triage now…', issue.thread_ts)

    const triageResult = await detectDuplicate(issue.ticket_data)

    if (!triageResult.duplicate_task_id) {
      const workaround = await searchForWorkaround(issue.ticket_data)
      triageResult.workaround_found = workaround.found
      triageResult.workaround_text = workaround.text
      triageResult.has_user_facing_docs = workaround.hasUserFacingDocs
      triageResult.documentation_gap = workaround.docGap

      if (workaround.found && workaround.hasUserFacingDocs) {
        triageResult.routing_decision = 'new_tickets_with_workaround'
      } else if (workaround.found && !workaround.hasUserFacingDocs) {
        triageResult.routing_decision = 'needs_tutorial'
      } else {
        triageResult.routing_decision = 'escalate_to_michael'
      }
    }

    // TODO: replaced by createTicket/appendToParentTicket in Task 10
    const clickupTaskId: string | null = null

    await supabase
      .from('slack_issues')
      .update({
        status: 'complete',
        clickup_task_id: clickupTaskId,
        updated_at: new Date().toISOString(),
      })
      .eq('thread_ts', issue.thread_ts)

  } else if (isNo) {
    await supabase
      .from('slack_issues')
      .update({ status: 'gathering', updated_at: new Date().toISOString() })
      .eq('thread_ts', issue.thread_ts)

    await slack.postMessage(event.channel, "No problem! What would you like to add or change?", issue.thread_ts)

  } else {
    await slack.postMessage(
      event.channel,
      "Just to confirm — are you ready for me to submit this ticket? Reply **Yes** to submit or **No** to make changes.",
      issue.thread_ts,
    )
  }
}

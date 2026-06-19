// app/api/webhooks/slack/route.ts
import { NextRequest, NextResponse, after } from 'next/server'
import { verifySlackSignature } from '@/lib/slack/verify'
import { buildSlackClient } from '@/lib/slack/client'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { runIntakeTurn } from '@/lib/issue-triage/conversation'
import { detectDuplicate, checkUrgencyCollision } from '@/lib/issue-triage/duplicate-detection'
import { createTicket, updateTicketDescription, appendToParentTicket, notifyUrgencyCollision } from '@/lib/issue-triage/router'
import { recordObservation } from '@/lib/issue-triage/observations'
import { getActiveSop } from '@/lib/issue-triage/sop'
import { fetchSlackFile, uploadToClickUp, generateVisualSummary } from '@/lib/issue-triage/media'
import { EMPTY_TICKET_DATA } from '@/lib/issue-triage/types'
import type { SlackIssue } from '@/lib/issue-triage/types'
import { DEV_TEAM_IDS } from '@/lib/issue-triage/dev-team'
import { validateIntakePromptChange } from '@/lib/issue-triage/sop-proposal-guard'

interface SlackFile {
  id: string
  name: string
  url_private: string
  mimetype: string
}

interface SlackEvent {
  type: string
  user?: string
  bot_id?: string
  subtype?: string
  channel: string
  text: string
  ts: string
  thread_ts?: string
  files?: SlackFile[]
}

interface SlackReactionEvent {
  type: 'reaction_added'
  user: string
  reaction: string
  item: { type: string; channel: string; ts: string }
  item_user: string
}

interface SlackPayload {
  type: string
  challenge?: string
  event?: SlackEvent | SlackReactionEvent
}

interface SlackBlockAction {
  type: 'block_actions'
  trigger_id: string
  response_url?: string
  user: { id: string }
  actions: Array<{ action_id: string; value?: string }>
}

interface SlackViewSubmission {
  type: 'view_submission'
  user: { id: string }
  view: {
    callback_id: string
    private_metadata: string
    state: {
      values: Record<string, Record<string, { value: string | null }>>
    }
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  console.log('[slack-webhook] POST received', req.headers.get('x-slack-signature') ? 'signed' : 'unsigned', new Date().toISOString())
  const contentType = req.headers.get('content-type') ?? ''
  const rawBody = await req.text()

  // Block Kit interactive payloads are form-encoded
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(rawBody)
    const payloadStr = params.get('payload')
    if (!payloadStr) return NextResponse.json({ ok: true })

    const timestamp = req.headers.get('x-slack-request-timestamp') ?? ''
    const signature = req.headers.get('x-slack-signature') ?? ''
    if (!verifySlackSignature(rawBody, timestamp, signature, process.env.SLACK_SIGNING_SECRET ?? '')) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const parsed = JSON.parse(payloadStr) as SlackBlockAction | SlackViewSubmission
    if (parsed.type === 'block_actions') {
      after(async () => { await handleBlockAction(parsed as SlackBlockAction) })
      return NextResponse.json({ ok: true })
    }
    if (parsed.type === 'view_submission') {
      after(async () => { await handleViewSubmission(parsed as SlackViewSubmission) })
      // Slack closes a modal only on an empty 200 (or a valid response_action).
      // A non-empty body like {ok:true} is read as an invalid response_action and
      // surfaces "We had some trouble connecting. Try again?" in the modal.
      return new NextResponse(null, { status: 200 })
    }
    return NextResponse.json({ ok: true })
  }

  // JSON event callbacks
  let payload: SlackPayload
  try {
    payload = JSON.parse(rawBody) as SlackPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (payload.type === 'url_verification') {
    return NextResponse.json({ challenge: payload.challenge })
  }

  const timestamp = req.headers.get('x-slack-request-timestamp') ?? ''
  const signature = req.headers.get('x-slack-signature') ?? ''
  if (!verifySlackSignature(rawBody, timestamp, signature, process.env.SLACK_SIGNING_SECRET ?? '')) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const event = payload.event
  if (!event) return NextResponse.json({ ok: true })

  const issuesChannel = process.env.SLACK_ISSUES_CHANNEL_ID
  if (!issuesChannel) {
    console.error('[slack-webhook] SLACK_ISSUES_CHANNEL_ID is not set')
    return NextResponse.json({ ok: true })
  }

  // Reaction events
  if (event.type === 'reaction_added') {
    const re = event as SlackReactionEvent
    if (re.item.channel === issuesChannel) {
      after(async () => { await handleReaction(re) })
    }
    return NextResponse.json({ ok: true })
  }

  // Message events
  const msgEvent = event as SlackEvent
  if (msgEvent.bot_id || msgEvent.subtype === 'bot_message') return NextResponse.json({ ok: true })
  if (msgEvent.subtype === 'channel_join' || msgEvent.subtype === 'channel_leave') return NextResponse.json({ ok: true })
  if (msgEvent.channel !== issuesChannel) return NextResponse.json({ ok: true })
  if (!msgEvent.user) return NextResponse.json({ ok: true })

  after(async () => {
    try { await processMessageEvent(msgEvent) } catch (err) {
      console.error('[slack-webhook] after() error:', err)
    }
  })

  return NextResponse.json({ ok: true })
}

async function processMessageEvent(event: SlackEvent): Promise<void> {
  const supabase = await getSupabaseServiceClient()
  const slack = buildSlackClient(process.env.SLACK_BOT_TOKEN ?? '')
  const threadTs = event.thread_ts ?? event.ts

  // Ignore thread replies that have no existing issue record — dev or others commenting
  // on a thread the bot never processed (e.g. pre-bot messages)
  if (!event.thread_ts === false && event.thread_ts !== event.ts) {
    const isReply = event.thread_ts && event.thread_ts !== event.ts
    if (isReply) {
      const { data: check } = await supabase
        .from('slack_issues').select('thread_ts').eq('thread_ts', threadTs).single()
      if (!check) return
    }
  }

  const { data: existing } = await supabase
    .from('slack_issues').select('*').eq('thread_ts', threadTs).single()
  const issue = existing as SlackIssue | null

  // Bot is silent when dev has claimed the ticket
  if (issue?.handoff_status === 'taken') return

  // Ticket was returned by dev: re-enable gathering so bot can resume
  if (issue?.handoff_status === 'returned') {
    await supabase.from('slack_issues')
      .update({ handoff_status: null, status: 'gathering', updated_at: new Date().toISOString() })
      .eq('thread_ts', threadTs)
    // Fall through to process as a gathering turn
  }

  // Passive mode: confirmed duplicate — append additional reporter input to parent
  if (issue?.status === 'passive') {
    if (event.user === issue.reporter_id && issue.clickup_task_id) {
      await appendToParentTicket(issue.clickup_task_id, issue, event.text)
      await slack.addReaction(event.channel, event.ts, 'memo').catch(() => undefined)
    }
    return
  }

  // Dev team member replied in an active gathering thread: hand off silently
  if (issue && DEV_TEAM_IDS.has(event.user ?? '') && issue.status === 'gathering') {
    await supabase.from('slack_issues')
      .update({ status: 'complete', updated_at: new Date().toISOString() })
      .eq('thread_ts', threadTs)
    return
  }

  // Other non-reporter message (not dev team): triage feedback
  if (issue && event.user !== issue.reporter_id) {
    await handleTeamFeedback(issue, event, slack, supabase)
    return
  }

  // New top-level message: create ticket
  if (!issue) {
    await handleNewIssue(event, slack, supabase)
    return
  }

  // Reporter follow-up in existing gathering thread
  if (issue.status === 'gathering') {
    await handleGathering(issue, event, slack, supabase)
  }
}

async function handleNewIssue(
  event: SlackEvent,
  slack: ReturnType<typeof buildSlackClient>,
  supabase: Awaited<ReturnType<typeof getSupabaseServiceClient>>,
): Promise<void> {
  const sop = await getActiveSop()
  const botToken = process.env.SLACK_BOT_TOKEN ?? ''
  const cuToken = process.env.CLICKUP_BOT_TOKEN ?? ''
  const apiKey = process.env.ANTHROPIC_API_KEY ?? ''
  const slackBase = process.env.SLACK_WORKSPACE_URL ?? 'https://slack.com'
  const originalMsgUrl = `${slackBase}/archives/${event.channel}/p${event.ts.replace('.', '')}`

  // Process any media attachments
  let visualSummary: string | null = null

  if (event.files?.length && cuToken) {
    for (const file of event.files) {
      try {
        const data = await fetchSlackFile(file.url_private, botToken)
        if (!visualSummary && apiKey) {
          visualSummary = await generateVisualSummary(data, file.mimetype, apiKey)
        }
      } catch (err) {
        console.warn('[slack-webhook] media pre-fetch failed:', err)
      }
    }
  }

  // Look up reporter profile from Slack
  const reporterProfile = await slack.getUserProfile(event.user ?? '').catch(() => ({ email: null, displayName: null }))
  const reporterFirstName = reporterProfile.displayName?.split(' ')[0] ?? null

  // Strip Slack mention syntax and seed ticket with clean initial message
  const cleanText = event.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  const seedTicketData = { ...EMPTY_TICKET_DATA, issue_summary: cleanText.slice(0, 200), reporter_email: reporterProfile.email ?? '' }

  const newIssueData = {
    thread_ts: event.ts,
    channel_id: event.channel,
    reporter_id: event.user ?? '',
    status: 'gathering' as const,
    ticket_data: seedTicketData,
    metadata: { logrocket_links: [], file_ids: [], vault_snippets_used: [], triage_reasoning: '' },
    handoff_status: null,
    clickup_task_id: null,
    sop_version: sop.version,
    last_msg_ts: event.ts,
  }

  const tempIssue: SlackIssue = {
    ...newIssueData,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  // Create ClickUp ticket immediately
  const task = await createTicket(tempIssue, visualSummary)

  // Upload media now that we have a task ID
  if (event.files?.length && cuToken) {
    for (const file of event.files) {
      try {
        const data = await fetchSlackFile(file.url_private, botToken)
        await uploadToClickUp(task.id, cuToken, file.name, data, file.mimetype)
      } catch (err) {
        console.warn('[slack-webhook] ClickUp upload failed:', err)
      }
    }
  }

  // Persist to Supabase
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await supabase.from('slack_issues').insert({ ...newIssueData, clickup_task_id: task.id } as any)

  // React with :admission_tickets: to signal the ticket was created
  await slack.addReaction(event.channel, event.ts, 'admission_tickets').catch(() => undefined)

  const fullIssue: SlackIssue = { ...tempIssue, clickup_task_id: task.id }

  // Quick duplicate detection on initial message
  let dupStatus = '*No related tickets found at this time.*'
  let triageResult
  try {
    triageResult = await detectDuplicate(fullIssue.ticket_data, task.id)
    if (triageResult.duplicate_task_id) {
      dupStatus = `⚠️ Possible duplicate of <https://app.clickup.com/t/${triageResult.duplicate_task_id}|existing ticket> — monitoring as we learn more.`
    }
  } catch (err) {
    console.warn('[slack-webhook] initial triage failed:', err)
  }

  // Check if a dev team member has already replied before asking a question
  const threadHistory = await slack.getThreadReplies(event.channel, event.ts).catch(() => [])
  const devAlreadyReplied = threadHistory.some((m) => m.user && DEV_TEAM_IDS.has(m.user))

  if (devAlreadyReplied) {
    await slack.postMessage(
      event.channel,
      `I've opened a ticket: <${task.url}|View in ClickUp>\n🔗 <${originalMsgUrl}|Original message>\n\n${dupStatus}`,
      event.ts,
    )
  } else {
    let firstQuestion = 'Can you tell me a bit more about what happened?'
    try {
      const intakeResult = await runIntakeTurn(fullIssue, event.text, [])
      firstQuestion = intakeResult.bot_response
      await supabase.from('slack_issues')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update({ ticket_data: intakeResult.updated_schema as any, updated_at: new Date().toISOString() })
        .eq('thread_ts', event.ts)

      // Update ClickUp task with the clean AI-generated summary and reporter name prefix
      if (intakeResult.updated_schema.issue_summary) {
        const namePrefix = reporterFirstName ? `[${reporterFirstName}] ` : ''
        const taskName = `${namePrefix}${intakeResult.updated_schema.issue_summary}`.slice(0, 200)
        const updatedIssue = { ...fullIssue, ticket_data: intakeResult.updated_schema }
        await updateTicketDescription(task.id, updatedIssue).catch((err) =>
          console.warn('[slack-webhook] initial ClickUp name update failed:', err)
        )
        await import('@/lib/clickup/client').then(({ buildClickUpClient }) =>
          buildClickUpClient(process.env.CLICKUP_BOT_TOKEN ?? '').updateTask(task.id, { name: taskName })
        ).catch((err) => console.warn('[slack-webhook] ClickUp name update failed:', err))
      }
    } catch (err) {
      console.warn('[slack-webhook] initial intake turn failed:', err)
    }

    await slack.postMessage(
      event.channel,
      `I've opened a ticket for you: <${task.url}|View in ClickUp>\n🔗 <${originalMsgUrl}|Original message>\n\n${dupStatus}\n\n${firstQuestion}`,
      event.ts,
    )
  }

  await recordObservation(event.ts, task.id, sop.version, 'ticket_created', {
    initialTriageConfidence: triageResult?.duplicate_confidence ?? 0,
    possibleDuplicateId: triageResult?.duplicate_task_id ?? null,
    mediaPresent: (event.files?.length ?? 0) > 0,
  })
}

async function handleGathering(
  issue: SlackIssue,
  event: SlackEvent,
  slack: ReturnType<typeof buildSlackClient>,
  supabase: Awaited<ReturnType<typeof getSupabaseServiceClient>>,
): Promise<void> {
  const sop = await getActiveSop()
  const history = await slack.getThreadReplies(event.channel, issue.thread_ts).catch(() => [])

  // If any dev team member has replied, stop gathering — they've taken over
  const devReplied = history.some((m) => m.user && DEV_TEAM_IDS.has(m.user))
  if (devReplied) {
    await supabase.from('slack_issues')
      .update({ status: 'complete', updated_at: new Date().toISOString() })
      .eq('thread_ts', issue.thread_ts)
    return
  }

  const result = await runIntakeTurn(issue, event.text, history)

  // Update ClickUp ticket in real-time
  if (issue.clickup_task_id) {
    const updatedIssue = { ...issue, ticket_data: result.updated_schema }
    await updateTicketDescription(issue.clickup_task_id, updatedIssue).catch((err) =>
      console.warn('[slack-webhook] ClickUp update failed:', err)
    )
  }

  // Re-run duplicate detection
  let triageResult
  try {
    triageResult = await detectDuplicate(result.updated_schema)
  } catch (err) {
    console.warn('[slack-webhook] triage re-run failed:', err)
  }

  // Check escalation rules
  const turnCount = history.filter((m) => !m.bot_id).length
  const shouldEscalate =
    turnCount >= sop.escalation_rules.maxTurns ||
    (result.confidence < 0.1 && turnCount >= sop.escalation_rules.disengagementThreshold)

  let newStatus: SlackIssue['status'] = 'gathering'
  let botResponse = result.bot_response

  // Confirmed duplicate: shift to passive mode
  if (triageResult?.duplicate_task_id && triageResult.duplicate_confidence >= sop.duplicate_thresholds.confirmed) {
    newStatus = 'passive'

    let parentUrl: string | undefined
    try {
      const { buildClickUpClient } = await import('@/lib/clickup/client')
      const parentTask = await buildClickUpClient(process.env.CLICKUP_BOT_TOKEN ?? '').getTask(triageResult.duplicate_task_id)
      parentUrl = parentTask.url
    } catch { /* non-fatal */ }

    await appendToParentTicket(
      triageResult.duplicate_task_id,
      { ...issue, ticket_data: result.updated_schema },
      event.text,
    ).catch(() => undefined)

    // Check urgency collision
    const isCollision = await checkUrgencyCollision(triageResult.duplicate_task_id, supabase)
    if (isCollision && parentUrl) {
      await notifyUrgencyCollision(
        triageResult.duplicate_task_id,
        parentUrl,
        sop.duplicate_thresholds.collisionCount,
      )
      await recordObservation(issue.thread_ts, issue.clickup_task_id, sop.version, 'priority_bump', {
        parentTaskId: triageResult.duplicate_task_id,
        collisionCount: sop.duplicate_thresholds.collisionCount,
      })
    }

    botResponse = `This looks like a known issue. Here's the existing ticket: ${parentUrl ?? triageResult.duplicate_task_id}. Your context has been added as a comment.${triageResult.workaround_text ? `\n\nWorkaround: ${triageResult.workaround_text}` : ''}`

    await recordObservation(issue.thread_ts, issue.clickup_task_id, sop.version, 'duplicate_confirmed', {
      parentTaskId: triageResult.duplicate_task_id,
      confidence: triageResult.duplicate_confidence,
      turnCount,
    })
  } else if (shouldEscalate) {
    newStatus = 'complete'
    botResponse = "I don't have enough information to help you at this time — support will reach out within 24 hours."
    await recordObservation(issue.thread_ts, issue.clickup_task_id, sop.version, 'escalation_triggered', {
      turnCount,
      lastConfidence: result.confidence,
      reason: turnCount >= sop.escalation_rules.maxTurns ? 'max_turns' : 'low_confidence',
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await supabase.from('slack_issues').update({
    ticket_data: result.updated_schema as any,
    status: newStatus as any,
    last_msg_ts: event.ts,
    updated_at: new Date().toISOString(),
  }).eq('thread_ts', issue.thread_ts)

  await slack.postMessage(event.channel, botResponse, issue.thread_ts)

  if (newStatus === 'gathering') {
    await recordObservation(issue.thread_ts, issue.clickup_task_id, sop.version, 'enrichment_turn', {
      turnCount,
      confidenceDelta: result.confidence - (triageResult?.duplicate_confidence ?? 0),
      questionAsked: result.bot_response,
    })
  }
}

async function handleTeamFeedback(
  issue: SlackIssue,
  event: SlackEvent,
  slack: ReturnType<typeof buildSlackClient>,
  supabase: Awaited<ReturnType<typeof getSupabaseServiceClient>>,
): Promise<void> {
  const sop = await getActiveSop()
  const text = event.text.toLowerCase()

  // Detect duplicate dispute
  const isDuplicateDispute = /\b(not a duplicate|not related|wrong ticket|different issue)\b/.test(text)

  if (isDuplicateDispute) {
    await supabase.from('slack_issues')
      .update({ status: 'gathering', updated_at: new Date().toISOString() })
      .eq('thread_ts', issue.thread_ts)
    await slack.postMessage(event.channel, "Got it — removing the duplicate flag. I'll keep gathering information.", issue.thread_ts)
    await recordObservation(issue.thread_ts, issue.clickup_task_id, sop.version, 'duplicate_overridden', {
      overriddenBy: event.user,
    })
    return
  }

  await slack.postMessage(event.channel, "Thanks for the context — I've noted it.", issue.thread_ts)
  await recordObservation(issue.thread_ts, issue.clickup_task_id, sop.version, 'team_correction', {
    feedback: event.text,
    correctedBy: event.user,
  })
}

async function handleReaction(event: SlackReactionEvent): Promise<void> {
  // white_check_mark from a dev team member: post resolution survey tagging dev + reporter
  if (event.reaction === 'white_check_mark' && DEV_TEAM_IDS.has(event.user)) {
    const supabase = await getSupabaseServiceClient()
    const { data: issueData } = await supabase
      .from('slack_issues').select('*').eq('thread_ts', event.item.ts).single()
    if (!issueData) return

    const issue = issueData as unknown as SlackIssue
    const slack = buildSlackClient(process.env.SLACK_BOT_TOKEN ?? '')

    await slack.postBlocks(
      event.item.channel,
      `✅ <@${event.user}> marked this resolved.`,
      [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ <@${event.user}> has marked this as resolved. <@${issue.reporter_id}> and <@${event.user}>, we'd love your feedback on the support experience.`,
          },
        },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Leave Feedback' }, action_id: 'feedback_open', value: issue.thread_ts },
          ],
        },
      ],
      issue.thread_ts,
    )

    await supabase.from('slack_issues')
      .update({ status: 'complete', updated_at: new Date().toISOString() })
      .eq('thread_ts', issue.thread_ts)

    return
  }

  // Signal reactions on bot messages (dev team quality feedback)
  const botUserId = process.env.SLACK_BOT_USER_ID
  if (!botUserId || event.item_user !== botUserId) return

  const SIGNAL_MAP: Record<string, string> = {
    warning: 'missed_detail',
    x: 'misidentified',
  }
  const signal = SIGNAL_MAP[event.reaction]
  if (!signal) return

  const supabase = await getSupabaseServiceClient()
  const { data: issue } = await supabase
    .from('slack_issues').select('*')
    .eq('last_msg_ts', event.item.ts).single()
  if (!issue) return

  const sop = await getActiveSop()
  await recordObservation(
    (issue as unknown as SlackIssue).thread_ts,
    (issue as unknown as SlackIssue).clickup_task_id,
    sop.version,
    'human_feedback',
    { source: 'dev_team', signal, reaction: event.reaction, reactedBy: event.user },
  )
}

async function handleViewSubmission(submission: SlackViewSubmission): Promise<void> {
  const values = submission.view.state.values
  const field = (block: string, action: string) => values[block]?.[action]?.value ?? ''

  if (submission.view.callback_id === 'feedback_modal') {
    const threadTs = submission.view.private_metadata
    const sop = await getActiveSop()
    await recordObservation(threadTs, null, sop.version, 'human_feedback', {
      source: 'survey',
      respondedBy: submission.user.id,
      liked: field('liked', 'liked_input'),
      disliked: field('disliked', 'disliked_input'),
    })
    return
  }

  if (submission.view.callback_id === 'sop_decision_modal') {
    let meta: { proposalId?: string; decision?: 'approve' | 'reject'; responseUrl?: string } = {}
    try { meta = JSON.parse(submission.view.private_metadata || '{}') } catch { /* malformed metadata */ }
    if (!meta.proposalId || !meta.decision) return

    const result = await resolveSopProposal(meta.proposalId, meta.decision, submission.user.id, field('reason', 'reason_input'))
    const slack = buildSlackClient(process.env.SLACK_BOT_TOKEN ?? '')
    const channel = process.env.SLACK_BOT_IMPROVEMENTS_CHANNEL_ID ?? ''
    if (channel) await slack.postMessage(channel, result.message).catch(() => undefined)
    // Only replace the original message (removing the buttons) when the proposal
    // was actually resolved — if it was blocked, leave the buttons so it can be
    // re-actioned after the proposal is fixed.
    if (result.resolved && meta.responseUrl) {
      await slack
        .updateViaResponseUrl(meta.responseUrl, [{ type: 'section', text: { type: 'mrkdwn', text: result.message } }], result.message)
        .catch(() => undefined)
    }
    return
  }
}

async function handleBlockAction(action: SlackBlockAction): Promise<void> {
  const actionId = action.actions[0]?.action_id

  // Feedback modal trigger
  if (actionId === 'feedback_open') {
    const threadTs = action.actions[0]?.value ?? ''
    const slack = buildSlackClient(process.env.SLACK_BOT_TOKEN ?? '')
    await slack.openModal(action.trigger_id, {
      type: 'modal',
      callback_id: 'feedback_modal',
      private_metadata: threadTs,
      title: { type: 'plain_text', text: 'Ticket Feedback' },
      submit: { type: 'plain_text', text: 'Submit' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'liked',
          label: { type: 'plain_text', text: 'One thing you liked' },
          element: { type: 'plain_text_input', action_id: 'liked_input', multiline: true, placeholder: { type: 'plain_text', text: 'e.g. Quick initial response' } },
        },
        {
          type: 'input',
          block_id: 'disliked',
          label: { type: 'plain_text', text: 'One thing to improve' },
          element: { type: 'plain_text_input', action_id: 'disliked_input', multiline: true, placeholder: { type: 'plain_text', text: 'e.g. Follow-up questions were too broad' } },
        },
      ],
    })
    return
  }

  // SOP Approve/Reject → open a decision modal that captures a reason/notes.
  // The actual resolution happens on modal submit (handleViewSubmission).
  if (actionId === 'sop_approve' || actionId === 'sop_reject') {
    const proposalId = action.actions[0]?.value
    if (!proposalId) return
    const decision: 'approve' | 'reject' = actionId === 'sop_approve' ? 'approve' : 'reject'
    const slack = buildSlackClient(process.env.SLACK_BOT_TOKEN ?? '')
    await slack.openModal(action.trigger_id, {
      type: 'modal',
      callback_id: 'sop_decision_modal',
      private_metadata: JSON.stringify({ proposalId, decision, responseUrl: action.response_url ?? '' }),
      title: { type: 'plain_text', text: decision === 'approve' ? 'Approve proposal' : 'Reject proposal' },
      submit: { type: 'plain_text', text: decision === 'approve' ? 'Approve' : 'Reject' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'reason',
          optional: true,
          label: { type: 'plain_text', text: decision === 'approve' ? 'Notes (optional)' : 'Reason for rejecting' },
          element: {
            type: 'plain_text_input',
            action_id: 'reason_input',
            multiline: true,
            placeholder: {
              type: 'plain_text',
              text: decision === 'approve'
                ? 'Any context to record with this change'
                : "Why not? This is fed back to the bot so it doesn't re-propose the same thing.",
            },
          },
        },
      ],
    })
    return
  }
}

/**
 * Apply a PM's approve/reject decision to a proposal. Idempotent: a proposal that
 * is no longer pending_review is left untouched. Returns a human-readable result
 * line for posting to the improvements channel / updating the original message.
 */
async function resolveSopProposal(
  proposalId: string,
  decision: 'approve' | 'reject',
  userId: string,
  pmResponse: string,
): Promise<{ resolved: boolean; message: string }> {
  const supabase = await getSupabaseServiceClient()
  const { data: proposal } = await supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from('sop_proposals' as any).select('*').eq('id', proposalId).single()
  if (!proposal) return { resolved: false, message: 'SOP proposal not found.' }

  const p = proposal as unknown as {
    status: string
    proposed_changes: Record<string, { old: unknown; new: unknown }>
    pattern_summary: string
    supporting_data?: { requires_code?: boolean }
  }
  if (p.status !== 'pending_review') {
    return { resolved: false, message: `This proposal was already *${p.status}* — no change made.` }
  }

  const resolved = { resolved_by: userId, resolved_at: new Date().toISOString(), pm_response: pmResponse || null }
  const reasonLine = pmResponse ? `\n*${decision === 'approve' ? 'Notes' : 'Reason'}:* ${pmResponse}` : ''

  if (decision === 'reject') {
    await supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from('sop_proposals' as any).update({ status: 'rejected', ...resolved }).eq('id', proposalId)
    return { resolved: true, message: `🚫 Proposal rejected by <@${userId}>. The current SOP stays active.${reasonLine}` }
  }

  // Approve. Feature requests have no config to apply — just log them.
  if (p.supporting_data?.requires_code) {
    await supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from('sop_proposals' as any).update({ status: 'approved', ...resolved }).eq('id', proposalId)
    return { resolved: true, message: `✅ Logged as an engineering task by <@${userId}> — no SOP config change applied.${reasonLine}` }
  }

  // Config change. Guard against a lossy intake_prompt rewrite breaking the live
  // bot (see SOP v2: it dropped the JSON output contract). Block, don't apply.
  const sop = await getActiveSop()
  const changes = p.proposed_changes ?? {}
  if ('intake_prompt' in changes) {
    const check = validateIntakePromptChange(sop.intake_prompt, String(changes.intake_prompt?.new ?? ''))
    if (!check.ok) {
      return {
        resolved: false,
        message: `⚠️ *Not applied* — the proposed \`intake_prompt\` would break the bot: ${check.issues.join('; ')}. The SOP is unchanged (still v${sop.version}). Fix the proposal or reject it.`,
      }
    }
  }

  // Safe to apply: archive the active SOP and publish the next version.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase.from('bot_sops') as any).update({ status: 'archived' }).eq('status', 'active')
  const newSopData: Record<string, unknown> = {
    version: sop.version + 1,
    intake_prompt: sop.intake_prompt,
    escalation_rules: sop.escalation_rules,
    duplicate_thresholds: sop.duplicate_thresholds,
    manual_directives: sop.manual_directives,
    status: 'active',
    change_summary: p.pattern_summary,
    approved_by: userId,
    approved_at: new Date().toISOString(),
  }
  for (const [key, change] of Object.entries(changes)) {
    newSopData[key] = change.new
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase.from('bot_sops') as any).insert(newSopData)
  await supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from('sop_proposals' as any).update({ status: 'approved', ...resolved }).eq('id', proposalId)
  return { resolved: true, message: `✅ Approved by <@${userId}> — SOP v${sop.version + 1} is now active.${reasonLine}` }
}

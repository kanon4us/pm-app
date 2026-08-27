// Hourly cron: re-engage stalled support tickets.
//
// Replaces the old "nudge once, then mark complete" behavior. Per repeated PM
// feedback the bot must keep tickets moving: ping the reporter + dev team ~1h
// after a ticket goes unanswered (business hours only), re-nudge the dev team
// every ~12h until it's closed, ping a dev who reacted but never replied, nudge
// to confirm a posted fix (never auto-close), and flag tickets past the 24h
// close target. Thresholds come from the active SOP's escalation_rules; nudge
// bookkeeping is stored in slack_issues.metadata.nudges (no schema migration).

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildSlackClient, isTransientSlackError, SlackApiError, type SlackMessage } from '@/lib/slack/client'
import { getActiveSop } from '@/lib/issue-triage/sop'
import { recordObservation } from '@/lib/issue-triage/observations'
import { getDevTeamIds, devMention } from '@/lib/issue-triage/dev-team'
import { createTicket } from '@/lib/issue-triage/router'
import {
  decideStaleActions,
  resolveStaleRules,
  isBusinessHours,
  type ResolvedStaleRules,
  type StaleAction,
  type ThreadState,
} from '@/lib/issue-triage/stale-nudge'
import type { NudgeState, SlackIssue, SlackIssueMetadata, SlackIssueStatus } from '@/lib/issue-triage/types'

const OPEN_STATUSES = ['gathering', 'confirming', 'triaging'] as const
const FIX_PHRASE = /\b(try (it )?(now|again)|should (be working|work now)|fixed( now)?|deployed|pushed (a )?fix|is live|live now)\b/i

interface IssueRow {
  thread_ts: string
  channel_id: string
  reporter_id: string
  status: SlackIssueStatus
  sop_version: number | null
  clickup_task_id: string | null
  last_msg_ts: string | null
  ticket_data: SlackIssue['ticket_data']
  metadata: SlackIssueMetadata | null
}

/**
 * @param mention Pre-resolved dev-team mention (see devMention). Passed in
 *   rather than resolved here so the roster is read once per run, and so an
 *   empty roster can't leave a dangling mention or stray comma in the message.
 */
function actionText(action: StaleAction, issue: IssueRow, rules: ResolvedStaleRules, mention: string): string {
  switch (action.type) {
    case 'reporter_and_dev_nudge':
      return mention
        ? `<@${issue.reporter_id}> just checking in — are you still running into this? ${mention}, could we get a status update on this ticket?`
        : `<@${issue.reporter_id}> just checking in — are you still running into this? Could we get a status update on this ticket?`
    case 'dev_renudge':
      return `${mention ? mention + ' ' : ''}This ticket is still open and unresolved — can we get an update? (We'll keep checking every ${rules.devNudgeRepeatHours}h until it's closed.)`
    case 'reaction_no_reply':
      return `<@${action.devId}> you reacted here but haven't posted an update yet — what's the status on this ticket?`
    case 'resolution_confirm':
      return `<@${action.devId}> looks like a fix may have gone out. Can you confirm this is resolved so we can close the ticket?`
    case 'overdue':
      return `⏰ ${mention ? mention + ' ' : ''}This ticket has been open more than ${rules.maxResolutionHours}h (our close target). Please prioritize or post an update.`
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization')
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const slackToken = process.env.SLACK_BOT_TOKEN
  if (!slackToken) {
    console.error('[stale-check] SLACK_BOT_TOKEN is not set')
    return NextResponse.json({ error: 'no slack token' }, { status: 500 })
  }

  const supabase = await getSupabaseServiceClient()
  const slack = buildSlackClient(slackToken)
  const sop = await getActiveSop()
  const rules = resolveStaleRules(sop.escalation_rules)
  const now = Date.now()
  const inBusinessHours = isBusinessHours(
    new Date(now),
    rules.businessHoursTimezone,
    rules.businessHoursStart,
    rules.businessHoursEnd,
  )

  const { data: openIssues, error } = await supabase
    .from('slack_issues')
    .select('thread_ts, channel_id, reporter_id, status, sop_version, clickup_task_id, last_msg_ts, ticket_data, metadata')
    .in('status', OPEN_STATUSES)
  if (error) {
    console.error('[stale-check] query failed:', error)
    return NextResponse.json({ error: 'query failed' }, { status: 500 })
  }
  if (!openIssues?.length) return NextResponse.json({ ticketsNudged: 0, ticketsSkipped: 0, inBusinessHours })

  const devIds = await getDevTeamIds()
  // Resolve the roster once per run: it drives who the bot @-mentions, and it
  // must reflect the Dev Team page rather than the hardcoded seed.
  const mention = await devMention()
  let ticketsNudged = 0
  let totalActions = 0
  let ticketsBackfilled = 0
  let ticketsSkipped = 0
  let ticketsClosed = 0

  for (const issue of openIssues as unknown as IssueRow[]) {
    try {
      // Read the thread first: it is the evidence base for every decision below,
      // and a thread we cannot read is one we must not post into. A thread_ts
      // Slack can no longer resolve (deleted message, stale row) fails here and
      // is also silently dropped by chat.postMessage — which is how nudges end
      // up at channel root with no ticket context, and how a ticket the team
      // already resolved keeps reading as unanswered every run. Absence of
      // evidence is not evidence the ticket is stalled: stay quiet instead.
      let messages: SlackMessage[]
      try {
        messages = await slack.getThreadReplies(issue.channel_id, issue.thread_ts)
      } catch (err) {
        // Transient (rate limit, Slack outage): stay quiet and retry next hour.
        // Permanent (thread_not_found): the thread is gone for good, so this row
        // can never be worked, answered or nudged again — close it rather than
        // re-scanning it every hour until someone notices. Recorded as an
        // observation because a bot closing a ticket should never be silent.
        if (!isTransientSlackError(err)) {
          await supabase.from('slack_issues')
            .update({ status: 'complete', updated_at: new Date().toISOString() })
            .eq('thread_ts', issue.thread_ts)
          await recordObservation(
            issue.thread_ts,
            issue.clickup_task_id,
            issue.sop_version ?? sop.version,
            'thread_unreadable_closed',
            { slackError: err instanceof SlackApiError ? err.code : String(err) },
          )
          ticketsClosed++
        }
        console.warn('[stale-check] thread unreadable, skipping', issue.thread_ts, err)
        ticketsSkipped++
        continue
      }

      // Intake may have been unable to create the ClickUp ticket (an expired
      // CLICKUP_BOT_TOKEN 401s here), in which case the issue was still recorded
      // so the reporter got answered. Repair it now rather than leaving a
      // ticketless thread. Business hours only, like nudges: this posts into the
      // thread, and quiet hours are a deliberate SOP rule, so a few hours' delay
      // on repair beats a 3am notification.
      if (inBusinessHours && !issue.clickup_task_id) {
        try {
          const task = await createTicket(issue as unknown as SlackIssue)
          await supabase.from('slack_issues')
            .update({ clickup_task_id: task.id, updated_at: new Date().toISOString() })
            .eq('thread_ts', issue.thread_ts)
          await slack.postMessage(
            issue.channel_id,
            `:admission_tickets: Ticket now open: <${task.url}|View in ClickUp>`,
            issue.thread_ts,
          )
          issue.clickup_task_id = task.id
          ticketsBackfilled++
        } catch (err) {
          // Still down. Next run tries again; the intake alert already fired, so
          // staying quiet here is what keeps this from becoming hourly spam.
          console.warn('[stale-check] ticket backfill failed for', issue.thread_ts, err)
        }
      }

      // Gather thread state from Slack.
      const replies = messages.slice(1).filter((m) => !m.bot_id)
      const repliers = new Set(replies.map((m) => m.user).filter(Boolean) as string[])
      const hasDevReply = [...repliers].some((u) => devIds.has(u))

      const fixReply = [...replies].reverse().find(
        (m) => m.user && devIds.has(m.user) && FIX_PHRASE.test(m.text ?? ''),
      )
      const fixMessage = fixReply?.user
        ? { devId: fixReply.user, tsMs: Math.floor(parseFloat(fixReply.ts) * 1000) }
        : null

      const reactions = await slack.getReactions(issue.channel_id, issue.thread_ts)
      const reactors = new Set(reactions.flatMap((r) => r.users))
      const devReactorsWithoutReply = [...reactors].filter((u) => devIds.has(u) && !repliers.has(u))

      const openedAtMs = Math.floor(parseFloat(issue.thread_ts) * 1000)
      const replyTimes = replies
        .map((m) => Math.floor(parseFloat(m.ts) * 1000))
        .filter((n) => Number.isFinite(n))
      const lastActivityMs = Math.max(openedAtMs, ...replyTimes)

      const thread: ThreadState = {
        openedAtMs,
        lastActivityMs,
        hasDevReply,
        devReactorsWithoutReply,
        fixMessage,
      }

      const state: NudgeState = issue.metadata?.nudges ?? {}
      const { actions, nextState } = decideStaleActions({
        status: issue.status,
        thread,
        state,
        now,
        rules,
        inBusinessHours,
      })
      if (!actions.length) continue

      for (const action of actions) {
        await slack.postMessage(issue.channel_id, actionText(action, issue, rules, mention), issue.thread_ts)
      }

      const newMetadata: SlackIssueMetadata = { ...(issue.metadata ?? { logrocket_links: [], file_ids: [], vault_snippets_used: [], triage_reasoning: '' }), nudges: nextState }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await supabase.from('slack_issues').update({ metadata: newMetadata as any, updated_at: new Date().toISOString() }).eq('thread_ts', issue.thread_ts)

      await recordObservation(issue.thread_ts, issue.clickup_task_id, issue.sop_version ?? sop.version, 'stale_nudge', {
        actions: actions.map((a) => a.type),
        devNudgeCount: nextState.devNudgeCount ?? 0,
      })

      ticketsNudged++
      totalActions += actions.length
    } catch (err) {
      console.error('[stale-check] failed for', issue.thread_ts, err)
    }
  }

  return NextResponse.json({ ticketsNudged, totalActions, ticketsBackfilled, ticketsSkipped, ticketsClosed, inBusinessHours })
}

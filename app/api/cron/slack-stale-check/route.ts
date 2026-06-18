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
import { buildSlackClient } from '@/lib/slack/client'
import { getActiveSop } from '@/lib/issue-triage/sop'
import { recordObservation } from '@/lib/issue-triage/observations'
import { DEV_TEAM_IDS, devMention } from '@/lib/issue-triage/dev-team'
import {
  decideStaleActions,
  resolveStaleRules,
  isBusinessHours,
  type ResolvedStaleRules,
  type StaleAction,
  type ThreadState,
} from '@/lib/issue-triage/stale-nudge'
import type { NudgeState, SlackIssueMetadata, SlackIssueStatus } from '@/lib/issue-triage/types'

const OPEN_STATUSES = ['gathering', 'confirming', 'triaging'] as const
const FIX_PHRASE = /\b(try (it )?(now|again)|should (be working|work now)|fixed( now)?|deployed|pushed (a )?fix|is live|live now)\b/i

interface IssueRow {
  thread_ts: string
  channel_id: string
  reporter_id: string
  status: SlackIssueStatus
  sop_version: number | null
  clickup_task_id: string | null
  metadata: SlackIssueMetadata | null
}

function actionText(action: StaleAction, issue: IssueRow, rules: ResolvedStaleRules): string {
  switch (action.type) {
    case 'reporter_and_dev_nudge':
      return `<@${issue.reporter_id}> just checking in — are you still running into this? ${devMention()}, could we get a status update on this ticket?`
    case 'dev_renudge':
      return `${devMention()} this ticket is still open and unresolved — can we get an update? (We'll keep checking every ${rules.devNudgeRepeatHours}h until it's closed.)`
    case 'reaction_no_reply':
      return `<@${action.devId}> you reacted here but haven't posted an update yet — what's the status on this ticket?`
    case 'resolution_confirm':
      return `<@${action.devId}> looks like a fix may have gone out. Can you confirm this is resolved so we can close the ticket?`
    case 'overdue':
      return `⏰ ${devMention()} this ticket has been open more than ${rules.maxResolutionHours}h (our close target). Please prioritize or post an update.`
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
    .select('thread_ts, channel_id, reporter_id, status, sop_version, clickup_task_id, metadata')
    .in('status', OPEN_STATUSES)
  if (error) {
    console.error('[stale-check] query failed:', error)
    return NextResponse.json({ error: 'query failed' }, { status: 500 })
  }
  if (!openIssues?.length) return NextResponse.json({ ticketsNudged: 0, inBusinessHours })

  let ticketsNudged = 0
  let totalActions = 0

  for (const issue of openIssues as unknown as IssueRow[]) {
    try {
      // Gather thread state from Slack.
      const messages = await slack.getThreadReplies(issue.channel_id, issue.thread_ts).catch(() => [])
      const replies = messages.slice(1).filter((m) => !m.bot_id)
      const repliers = new Set(replies.map((m) => m.user).filter(Boolean) as string[])
      const hasDevReply = [...repliers].some((u) => DEV_TEAM_IDS.has(u))

      const fixReply = [...replies].reverse().find(
        (m) => m.user && DEV_TEAM_IDS.has(m.user) && FIX_PHRASE.test(m.text ?? ''),
      )
      const fixMessage = fixReply?.user
        ? { devId: fixReply.user, tsMs: Math.floor(parseFloat(fixReply.ts) * 1000) }
        : null

      const reactions = await slack.getReactions(issue.channel_id, issue.thread_ts)
      const reactors = new Set(reactions.flatMap((r) => r.users))
      const devReactorsWithoutReply = [...reactors].filter((u) => DEV_TEAM_IDS.has(u) && !repliers.has(u))

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
        await slack.postMessage(issue.channel_id, actionText(action, issue, rules), issue.thread_ts)
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

  return NextResponse.json({ ticketsNudged, totalActions, inBusinessHours })
}

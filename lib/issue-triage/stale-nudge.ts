// Pure decision logic for the stale-ticket nudging cron (slack-stale-check).
//
// Kept free of Slack/Supabase I/O so it can be unit-tested. The cron gathers
// thread state, calls decideStaleActions, then executes the returned actions and
// persists nextState into slack_issues.metadata.nudges.

import type { EscalationRules, NudgeState, SlackIssueStatus } from './types'

export interface ResolvedStaleRules {
  stalledTicketNudgeHours: number
  devNudgeRepeatHours: number
  maxResolutionHours: number
  businessHoursTimezone: string
  businessHoursStart: number
  businessHoursEnd: number
  abandonmentHours: number
}

export const DEFAULT_STALE_RULES: ResolvedStaleRules = {
  stalledTicketNudgeHours: 1,
  devNudgeRepeatHours: 12,
  maxResolutionHours: 24,
  businessHoursTimezone: 'America/Los_Angeles', // feedback referenced PST
  businessHoursStart: 8,
  businessHoursEnd: 16.5, // 4:30pm
  abandonmentHours: 72,
}

export function resolveStaleRules(rules?: Partial<EscalationRules>): ResolvedStaleRules {
  return {
    stalledTicketNudgeHours: rules?.stalledTicketNudgeHours ?? DEFAULT_STALE_RULES.stalledTicketNudgeHours,
    devNudgeRepeatHours: rules?.devNudgeRepeatHours ?? DEFAULT_STALE_RULES.devNudgeRepeatHours,
    maxResolutionHours: rules?.maxResolutionHours ?? DEFAULT_STALE_RULES.maxResolutionHours,
    businessHoursTimezone: rules?.businessHoursTimezone ?? DEFAULT_STALE_RULES.businessHoursTimezone,
    businessHoursStart: rules?.businessHoursStart ?? DEFAULT_STALE_RULES.businessHoursStart,
    businessHoursEnd: rules?.businessHoursEnd ?? DEFAULT_STALE_RULES.businessHoursEnd,
    abandonmentHours: rules?.abandonmentHours ?? DEFAULT_STALE_RULES.abandonmentHours,
  }
}

/** True if `now` falls on a weekday within [start, end) hours in the given timezone. */
export function isBusinessHours(
  now: Date,
  tz: string,
  startHour: number,
  endHour: number,
): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now)
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? ''
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10) % 24
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10)
  const hm = hour + minute / 60
  const isWeekday = weekday !== 'Sat' && weekday !== 'Sun'
  return isWeekday && hm >= startHour && hm < endHour
}

export interface ThreadState {
  openedAtMs: number
  /** Timestamp of the latest human (non-bot) message in the thread, or openedAtMs. */
  lastActivityMs: number
  hasDevReply: boolean
  /** Dev-team members who reacted to the ticket but never posted in the thread. */
  devReactorsWithoutReply: string[]
  /** Latest dev "try now / should be working" message, if any. */
  fixMessage: { devId: string; tsMs: number } | null
}

export type StaleAction =
  | { type: 'reporter_and_dev_nudge' }
  | { type: 'dev_renudge' }
  | { type: 'reaction_no_reply'; devId: string }
  | { type: 'resolution_confirm'; devId: string }
  | { type: 'overdue' }

const HOUR_MS = 3_600_000

export function decideStaleActions(args: {
  status: SlackIssueStatus
  thread: ThreadState
  state: NudgeState
  now: number
  rules: ResolvedStaleRules
  inBusinessHours: boolean
}): { actions: StaleAction[]; nextState: NudgeState } {
  const { status, thread, state, now, rules, inBusinessHours } = args
  const isOpen = status === 'gathering' || status === 'confirming' || status === 'triaging'
  if (!isOpen || !inBusinessHours) return { actions: [], nextState: state }

  // Abandoned: no human activity for too long — stop nudging into the void.
  if (now - thread.lastActivityMs >= rules.abandonmentHours * 3_600_000) {
    return { actions: [], nextState: state }
  }

  const actions: StaleAction[] = []
  const next: NudgeState = { ...state, reactionNudgedDevs: [...(state.reactionNudgedDevs ?? [])] }
  const iso = (ms: number) => new Date(ms).toISOString()
  const ageMs = now - thread.openedAtMs

  // 1. First escalation: no dev has replied and the ticket has been stale too long.
  if (!thread.hasDevReply && ageMs >= rules.stalledTicketNudgeHours * HOUR_MS && !next.devEscalatedAt) {
    actions.push({ type: 'reporter_and_dev_nudge' })
    next.reporterNudgedAt = iso(now)
    next.devEscalatedAt = iso(now)
    next.lastDevNudgeAt = iso(now)
    next.devNudgeCount = 1
  }
  // 2. Re-nudge the dev team every devNudgeRepeatHours while still unanswered.
  else if (
    !thread.hasDevReply &&
    next.devEscalatedAt &&
    next.lastDevNudgeAt &&
    now - Date.parse(next.lastDevNudgeAt) >= rules.devNudgeRepeatHours * HOUR_MS
  ) {
    actions.push({ type: 'dev_renudge' })
    next.lastDevNudgeAt = iso(now)
    next.devNudgeCount = (next.devNudgeCount ?? 1) + 1
  }

  // 3. Dev reacted (emoji) but never posted — ping that specific dev, once.
  if (ageMs >= rules.stalledTicketNudgeHours * HOUR_MS) {
    for (const dev of thread.devReactorsWithoutReply) {
      if (!next.reactionNudgedDevs!.includes(dev)) {
        actions.push({ type: 'reaction_no_reply', devId: dev })
        next.reactionNudgedDevs!.push(dev)
      }
    }
  }

  // 4. A fix was posted but the ticket is still open — nudge the dev to confirm/close (never auto-close).
  if (
    thread.fixMessage &&
    !next.resolutionNudgedAt &&
    now - thread.fixMessage.tsMs >= rules.stalledTicketNudgeHours * HOUR_MS
  ) {
    actions.push({ type: 'resolution_confirm', devId: thread.fixMessage.devId })
    next.resolutionNudgedAt = iso(now)
  }

  // 5. Past the close target.
  if (ageMs >= rules.maxResolutionHours * HOUR_MS && !next.overdueFlaggedAt) {
    actions.push({ type: 'overdue' })
    next.overdueFlaggedAt = iso(now)
  }

  return { actions, nextState: next }
}

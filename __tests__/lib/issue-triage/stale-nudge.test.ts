import {
  decideStaleActions,
  resolveStaleRules,
  isBusinessHours,
  DEFAULT_STALE_RULES,
  type ThreadState,
} from '../../../lib/issue-triage/stale-nudge'
import type { NudgeState } from '../../../lib/issue-triage/types'

const rules = DEFAULT_STALE_RULES
const HOUR = 3_600_000
const NOW = Date.parse('2026-06-18T18:00:00Z')

function thread(over: Partial<ThreadState> = {}): ThreadState {
  return {
    openedAtMs: NOW - 2 * HOUR,
    lastActivityMs: NOW - 2 * HOUR,
    hasDevReply: false,
    devReactorsWithoutReply: [],
    fixMessage: null,
    ...over,
  }
}

function decide(over: {
  status?: 'gathering' | 'complete' | 'passive'
  thread?: Partial<ThreadState>
  state?: NudgeState
  inBusinessHours?: boolean
} = {}) {
  return decideStaleActions({
    status: over.status ?? 'gathering',
    thread: thread(over.thread),
    state: over.state ?? {},
    now: NOW,
    rules,
    inBusinessHours: over.inBusinessHours ?? true,
  })
}

describe('decideStaleActions', () => {
  it('does nothing outside business hours', () => {
    expect(decide({ inBusinessHours: false }).actions).toEqual([])
  })

  it('does nothing for closed/duplicate tickets', () => {
    expect(decide({ status: 'complete' }).actions).toEqual([])
    expect(decide({ status: 'passive' }).actions).toEqual([])
  })

  it('does not nudge a fresh ticket still within the threshold', () => {
    const { actions } = decide({ thread: { openedAtMs: NOW - 0.5 * HOUR } })
    expect(actions).toEqual([])
  })

  it('does not nudge an abandoned ticket (no activity past the cutoff)', () => {
    const old = NOW - 80 * HOUR // > 72h idle
    const { actions } = decide({ thread: { openedAtMs: old, lastActivityMs: old } })
    expect(actions).toEqual([])
  })

  it('escalates once when no dev has replied past the threshold', () => {
    const { actions, nextState } = decide()
    expect(actions).toEqual([{ type: 'reporter_and_dev_nudge' }])
    expect(nextState.devEscalatedAt).toBeDefined()
    expect(nextState.devNudgeCount).toBe(1)
  })

  it('does not re-escalate before the repeat interval', () => {
    const state: NudgeState = {
      devEscalatedAt: new Date(NOW - 3 * HOUR).toISOString(),
      lastDevNudgeAt: new Date(NOW - 3 * HOUR).toISOString(),
      devNudgeCount: 1,
    }
    expect(decide({ state }).actions).toEqual([])
  })

  it('re-nudges the dev team after the repeat interval', () => {
    const state: NudgeState = {
      devEscalatedAt: new Date(NOW - 13 * HOUR).toISOString(),
      lastDevNudgeAt: new Date(NOW - 13 * HOUR).toISOString(),
      devNudgeCount: 1,
    }
    const { actions, nextState } = decide({ state })
    expect(actions).toContainEqual({ type: 'dev_renudge' })
    expect(nextState.devNudgeCount).toBe(2)
  })

  it('does not nudge for response once a dev has replied', () => {
    const { actions } = decide({ thread: { hasDevReply: true } })
    expect(actions).toEqual([])
  })

  it('pings a dev who reacted but never replied, only once', () => {
    const first = decide({ thread: { hasDevReply: true, devReactorsWithoutReply: ['UDEV1'] } })
    expect(first.actions).toContainEqual({ type: 'reaction_no_reply', devId: 'UDEV1' })
    // second run with the recorded state should not repeat
    const second = decide({
      thread: { hasDevReply: true, devReactorsWithoutReply: ['UDEV1'] },
      state: first.nextState,
    })
    expect(second.actions).toEqual([])
  })

  it('nudges to confirm resolution but never auto-closes', () => {
    const { actions } = decide({
      thread: { hasDevReply: true, fixMessage: { devId: 'UDEV1', tsMs: NOW - 2 * HOUR } },
    })
    expect(actions).toContainEqual({ type: 'resolution_confirm', devId: 'UDEV1' })
  })

  it('flags overdue past the resolution target, once', () => {
    const first = decide({ thread: { hasDevReply: true, openedAtMs: NOW - 25 * HOUR } })
    expect(first.actions).toContainEqual({ type: 'overdue' })
    const second = decide({
      thread: { hasDevReply: true, openedAtMs: NOW - 25 * HOUR },
      state: first.nextState,
    })
    expect(second.actions).not.toContainEqual({ type: 'overdue' })
  })
})

describe('resolveStaleRules', () => {
  it('fills defaults when fields are absent', () => {
    expect(resolveStaleRules({ maxTurns: 8 } as never)).toEqual(DEFAULT_STALE_RULES)
  })

  it('honors configured overrides', () => {
    const r = resolveStaleRules({ devNudgeRepeatHours: 6, maxResolutionHours: 48 } as never)
    expect(r.devNudgeRepeatHours).toBe(6)
    expect(r.maxResolutionHours).toBe(48)
    expect(r.stalledTicketNudgeHours).toBe(1)
  })
})

describe('isBusinessHours', () => {
  const tz = 'America/Los_Angeles'
  it('is true on a weekday mid-morning PT', () => {
    // 2026-06-18 is a Thursday; 17:00 UTC = 10:00 PDT
    expect(isBusinessHours(new Date('2026-06-18T17:00:00Z'), tz, 8, 16.5)).toBe(true)
  })
  it('is false late at night PT', () => {
    // 08:00 UTC = 01:00 PDT
    expect(isBusinessHours(new Date('2026-06-18T08:00:00Z'), tz, 8, 16.5)).toBe(false)
  })
  it('is false on the weekend', () => {
    // 2026-06-20 is a Saturday; 18:00 UTC = 11:00 PDT
    expect(isBusinessHours(new Date('2026-06-20T18:00:00Z'), tz, 8, 16.5)).toBe(false)
  })
})

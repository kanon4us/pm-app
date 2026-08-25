import { NextRequest } from 'next/server'

process.env.SLACK_BOT_TOKEN = 'xoxb-test'
delete process.env.CRON_SECRET
delete process.env.SLACK_DEV_USERGROUP_ID

// Thursday 2026-06-18 11:00 PDT (18:00 UTC) — a weekday business hour in PT.
const NOW = new Date('2026-06-18T18:00:00Z')
const OPENED_TS = String(Math.floor(NOW.getTime() / 1000) - 2 * 3600) // 2h before now

const mockPostMessage = jest.fn().mockResolvedValue('ts-nudge')
const mockGetThreadReplies = jest.fn()
const mockGetReactions = jest.fn().mockResolvedValue([])
const eqUpdate = jest.fn().mockResolvedValue({ error: null })

jest.mock('@/lib/slack/client', () => ({
  buildSlackClient: jest.fn(() => ({
    postMessage: mockPostMessage,
    getThreadReplies: mockGetThreadReplies,
    getReactions: mockGetReactions,
  })),
}))

jest.mock('@/lib/issue-triage/sop', () => ({
  getActiveSop: jest.fn().mockResolvedValue({
    version: 1,
    intake_prompt: '',
    escalation_rules: { maxTurns: 8, disengagementThreshold: 2, minConfidenceMovementPerTurn: 0.05 },
    duplicate_thresholds: {},
    manual_directives: [],
  }),
}))

const mockRecordObservation = jest.fn().mockResolvedValue(undefined)
jest.mock('@/lib/issue-triage/observations', () => ({
  recordObservation: (...args: unknown[]) => mockRecordObservation(...args),
}))

const mockCreateTicket = jest.fn()
jest.mock('@/lib/issue-triage/router', () => ({
  createTicket: (...args: unknown[]) => mockCreateTicket(...args),
}))

/** Mutable so a test can swap in an issue whose ticket was never created. */
let openIssues: Array<Record<string, unknown>> = []

function issueRow(overrides: Record<string, unknown> = {}) {
  return {
    thread_ts: OPENED_TS,
    channel_id: 'C_ISSUES',
    reporter_id: 'UREP',
    status: 'gathering',
    sop_version: 1,
    clickup_task_id: 'task-existing',
    last_msg_ts: OPENED_TS,
    ticket_data: { issue_summary: 'boards not loading' },
    metadata: null,
    ...overrides,
  }
}

/** Hoisted so tests can inspect the update payloads, not just that one happened. */
const mockUpdate = jest.fn(() => ({ eq: eqUpdate }))

/** Payloads passed to supabase .update(), which the mock's own signature hides. */
function updatePayloads(): Record<string, unknown>[] {
  return (mockUpdate.mock.calls as unknown as Array<[Record<string, unknown>]>).map(([payload]) => payload)
}

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({
    from: jest.fn(() => ({
      select: jest.fn(() => ({ in: jest.fn().mockResolvedValue({ data: openIssues, error: null }) })),
      update: mockUpdate,
    })),
  }),
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GET } = require('@/app/api/cron/slack-stale-check/route')

describe('GET /api/cron/slack-stale-check', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW)
    mockPostMessage.mockClear()
    eqUpdate.mockClear()
    mockRecordObservation.mockClear()
    mockUpdate.mockClear()
    mockCreateTicket.mockReset()
    mockCreateTicket.mockResolvedValue({ id: 'task-new', url: 'https://app.clickup.com/t/task-new' })
    openIssues = [issueRow()]
    // Reporter-only thread, no dev reply yet.
    mockGetThreadReplies.mockResolvedValue([
      { user: 'UREP', ts: OPENED_TS, text: 'help me' },
    ])
  })
  afterEach(() => jest.useRealTimers())

  it('nudges a stalled ticket with no dev response (tags reporter + dev)', async () => {
    const res = await GET(new NextRequest('http://localhost/api/cron/slack-stale-check'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.inBusinessHours).toBe(true)
    expect(body.ticketsNudged).toBe(1)
    expect(mockPostMessage).toHaveBeenCalledWith(
      'C_ISSUES',
      expect.stringContaining('<@UREP>'),
      OPENED_TS,
    )
    expect(mockPostMessage).toHaveBeenCalledWith('C_ISSUES', expect.stringContaining('status update'), OPENED_TS)
    expect(mockRecordObservation).toHaveBeenCalled()
    expect(eqUpdate).toHaveBeenCalled() // persisted nudge state
  })

  it('does nothing outside business hours', async () => {
    jest.setSystemTime(new Date('2026-06-18T08:00:00Z')) // 01:00 PDT
    const res = await GET(new NextRequest('http://localhost/api/cron/slack-stale-check'))
    const body = await res.json()
    expect(body.inBusinessHours).toBe(false)
    expect(body.ticketsNudged).toBe(0)
    expect(mockPostMessage).not.toHaveBeenCalled()
  })

  it('does not nudge once a dev has already replied', async () => {
    mockGetThreadReplies.mockResolvedValue([
      { user: 'UREP', ts: OPENED_TS, text: 'help me' },
      { user: 'U020PGH3RFW', ts: OPENED_TS, text: 'looking into it' }, // dev reply
    ])
    const res = await GET(new NextRequest('http://localhost/api/cron/slack-stale-check'))
    const body = await res.json()
    expect(body.ticketsNudged).toBe(0)
    expect(mockPostMessage).not.toHaveBeenCalled()
  })

  describe('backfilling a ticket intake could not create', () => {
    beforeEach(() => {
      openIssues = [issueRow({ clickup_task_id: null })]
    })

    it('opens the missing ClickUp ticket', async () => {
      await GET(new NextRequest('http://localhost/api/cron/slack-stale-check'))

      expect(mockCreateTicket).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: OPENED_TS, channel_id: 'C_ISSUES' }),
      )
    })

    it('records the new task id against the issue', async () => {
      await GET(new NextRequest('http://localhost/api/cron/slack-stale-check'))

      const updates = updatePayloads()
      expect(updates).toContainEqual(expect.objectContaining({ clickup_task_id: 'task-new' }))
    })

    it('posts the ticket link into the original thread', async () => {
      await GET(new NextRequest('http://localhost/api/cron/slack-stale-check'))

      expect(mockPostMessage).toHaveBeenCalledWith(
        'C_ISSUES',
        expect.stringContaining('https://app.clickup.com/t/task-new'),
        OPENED_TS,
      )
    })

    it('leaves the issue for the next run when ClickUp is still down', async () => {
      mockCreateTicket.mockRejectedValue(new Error('ClickUp API error: 401'))

      const res = await GET(new NextRequest('http://localhost/api/cron/slack-stale-check'))

      expect(res.status).toBe(200)
      const updates = updatePayloads()
      expect(updates).not.toContainEqual(expect.objectContaining({ clickup_task_id: expect.anything() }))
    })

    it('stays quiet outside business hours', async () => {
      jest.setSystemTime(new Date('2026-06-18T08:00:00Z')) // 01:00 PDT

      await GET(new NextRequest('http://localhost/api/cron/slack-stale-check'))

      expect(mockCreateTicket).not.toHaveBeenCalled()
      expect(mockPostMessage).not.toHaveBeenCalled()
    })
  })

  it('does not re-create a ticket for an issue that already has one', async () => {
    await GET(new NextRequest('http://localhost/api/cron/slack-stale-check'))

    expect(mockCreateTicket).not.toHaveBeenCalled()
  })
})

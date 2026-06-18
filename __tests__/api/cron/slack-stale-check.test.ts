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

const openIssues = [
  { thread_ts: OPENED_TS, channel_id: 'C_ISSUES', reporter_id: 'UREP', status: 'gathering', sop_version: 1, clickup_task_id: null, metadata: null },
]

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({
    from: jest.fn(() => ({
      select: jest.fn(() => ({ in: jest.fn().mockResolvedValue({ data: openIssues, error: null }) })),
      update: jest.fn(() => ({ eq: eqUpdate })),
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
})

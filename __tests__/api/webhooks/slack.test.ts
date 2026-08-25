import { POST } from '@/app/api/webhooks/slack/route'
import { NextRequest } from 'next/server'
import { STATUS_ACTION_ID } from '@/lib/issue-triage/ticket-actions'
import crypto from 'crypto'

const SIGNING_SECRET = 'test-signing-secret'
process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET
process.env.SLACK_ISSUES_CHANNEL_ID = 'C_ISSUES'
process.env.SLACK_BOT_TOKEN = 'xoxb-test'
process.env.SLACK_BOT_USER_ID = 'U_BOT'
process.env.SLACK_BOT_IMPROVEMENTS_CHANNEL_ID = 'C_IMPROVEMENTS'
process.env.SLACK_WORKSPACE_URL = 'https://test.slack.com'
process.env.CLICKUP_BOT_TOKEN = 'cu-test'
process.env.ANTHROPIC_API_KEY = 'anth-test'

// Capture after() callbacks so tests can flush them explicitly
const afterQueue: Array<() => unknown> = []
jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server')
  return { ...actual, after: jest.fn((fn: () => unknown) => { afterQueue.push(fn) }) }
})

/** Run all queued after() callbacks and wait for them to settle. */
async function flushAfter() {
  const fns = afterQueue.splice(0)
  await Promise.all(fns.map((fn) => fn()))
}

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: null }),
      insert: jest.fn().mockResolvedValue({ data: null, error: null }),
      update: jest.fn().mockReturnThis(),
    }),
  }),
}))

jest.mock('@/lib/issue-triage/sop', () => ({
  getActiveSop: jest.fn().mockResolvedValue({
    version: 1,
    intake_prompt: 'Gather info',
    manual_directives: [],
    escalation_rules: { maxTurns: 6, disengagementThreshold: 3, minConfidenceMovementPerTurn: 0.05 },
    duplicate_thresholds: { possible: 0.5, confirmed: 0.8, collisionWindowHours: 24, collisionCount: 3 },
  }),
}))

jest.mock('@/lib/issue-triage/conversation', () => ({
  runIntakeTurn: jest.fn().mockResolvedValue({
    updated_schema: {},
    bot_response: 'Tell me more',
    confidence: 0.2,
  }),
}))

jest.mock('@/lib/issue-triage/duplicate-detection', () => ({
  detectDuplicate: jest.fn().mockResolvedValue({
    duplicate_task_id: null,
    duplicate_confidence: 0,
    workaround_found: false,
    workaround_text: null,
    has_user_facing_docs: false,
    documentation_gap: false,
    routing_decision: 'new_tickets_with_workaround',
    routing_reasoning: '',
  }),
  checkUrgencyCollision: jest.fn().mockResolvedValue(false),
}))

jest.mock('@/lib/issue-triage/router', () => ({
  createTicket: jest.fn().mockResolvedValue({ id: 'task-123', url: 'https://app.clickup.com/t/task-123' }),
  updateTicketDescription: jest.fn().mockResolvedValue(undefined),
  appendToParentTicket: jest.fn().mockResolvedValue(undefined),
  notifyUrgencyCollision: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/issue-triage/observations', () => ({
  recordObservation: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/issue-triage/media', () => ({
  fetchSlackFile: jest.fn().mockResolvedValue(Buffer.from('img')),
  uploadToClickUp: jest.fn().mockResolvedValue('https://cdn.clickup.com/attachment.png'),
  generateVisualSummary: jest.fn().mockResolvedValue('User clicked export button'),
}))

jest.mock('@/lib/slack/client', () => ({
  buildSlackClient: jest.fn().mockReturnValue({
    postMessage: jest.fn().mockResolvedValue('ts-bot'),
    postBlocks: jest.fn().mockResolvedValue('ts-bot'),
    getThreadReplies: jest.fn().mockResolvedValue([]),
    getUserProfile: jest.fn().mockResolvedValue({ email: 'reporter@test.com', displayName: 'Reporter One' }),
    openDM: jest.fn().mockResolvedValue('D_DM'),
    addReaction: jest.fn().mockResolvedValue(undefined),
  }),
}))

function makeSlackRequest(body: object): NextRequest {
  const payload = JSON.stringify(body)
  const ts = String(Math.floor(Date.now() / 1000))
  const base = `v0:${ts}:${payload}`
  const sig = 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(base).digest('hex')

  return new NextRequest('http://localhost/api/webhooks/slack', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sig,
    },
    body: payload,
  })
}

/** Slack sends interactive payloads form-encoded, not as JSON. */
function makeSlackFormRequest(payloadJson: string): NextRequest {
  const body = `payload=${encodeURIComponent(payloadJson)}`
  const ts = String(Math.floor(Date.now() / 1000))
  const base = `v0:${ts}:${body}`
  const sig = 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(base).digest('hex')

  return new NextRequest('http://localhost/api/webhooks/slack', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sig,
    },
    body,
  })
}

/**
 * The Block Kit payload of a postBlocks call, flattened for substring checks.
 * postBlocks(channel, fallbackText, blocks, threadTs) — what the reporter
 * actually reads is the blocks, not the fallback text.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderedBlocks(call: any[]): string {
  return JSON.stringify(call[2])
}

describe('POST /api/webhooks/slack', () => {
  it('echoes the URL verification challenge', async () => {
    const req = makeSlackRequest({ type: 'url_verification', challenge: 'xyz-challenge' })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.challenge).toBe('xyz-challenge')
  })

  it('returns 401 for invalid signature', async () => {
    const req = new NextRequest('http://localhost/api/webhooks/slack', {
      method: 'POST',
      headers: {
        'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-slack-signature': 'v0=badsig',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'event_callback' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('returns 200 and ignores bot messages', async () => {
    const req = makeSlackRequest({
      type: 'event_callback',
      event: { type: 'message', bot_id: 'B123', channel: 'C_ISSUES', text: 'bot reply', ts: '1.1' },
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
  })

  it('returns 200 and ignores messages from other channels', async () => {
    const req = makeSlackRequest({
      type: 'event_callback',
      event: { type: 'message', user: 'U001', channel: 'C_OTHER', text: 'off-channel', ts: '1.2' },
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
  })

  it('creates a ticket and replies for a new issue message', async () => {
    const { createTicket } = jest.requireMock('@/lib/issue-triage/router')
    const { buildSlackClient } = jest.requireMock('@/lib/slack/client')
    const slack = buildSlackClient()

    const req = makeSlackRequest({
      type: 'event_callback',
      event: { type: 'message', user: 'U001', channel: 'C_ISSUES', text: 'CMS crashed!', ts: '1234567890.000001' },
    })
    const res = await POST(req)
    await flushAfter()

    expect(res.status).toBe(200)
    expect(createTicket).toHaveBeenCalled()
    expect(slack.postBlocks).toHaveBeenCalledWith(
      'C_ISSUES',
      expect.stringContaining('task-123'),
      expect.any(Array),
      '1234567890.000001',
    )
  })

  // ClickUp failing is recoverable and handled below; this covers a throw the
  // pipeline genuinely cannot serve the reporter through.
  it('warns the thread and alerts operators when the pipeline throws', async () => {
    const { getActiveSop } = jest.requireMock('@/lib/issue-triage/sop')
    const { buildSlackClient } = jest.requireMock('@/lib/slack/client')
    const slack = buildSlackClient()
    slack.postMessage.mockClear()
    getActiveSop.mockRejectedValueOnce(new Error('No active SOP found'))

    const req = makeSlackRequest({
      type: 'event_callback',
      event: { type: 'message', user: 'U001', channel: 'C_ISSUES', text: 'everything is broken', ts: '1234567890.000009' },
    })
    const res = await POST(req)
    await flushAfter()

    expect(res.status).toBe(200)

    const calls = slack.postMessage.mock.calls
    const threadWarning = calls.find(([channel]: [string]) => channel === 'C_ISSUES')
    expect(threadWarning).toBeDefined()
    expect(threadWarning[2]).toBe('1234567890.000009')

    const opsAlert = calls.find(([channel]: [string]) => channel === 'C_IMPROVEMENTS')
    expect(opsAlert).toBeDefined()
    expect(opsAlert[1]).toContain('No active SOP found')
  })

  it('stays quiet when intake succeeds', async () => {
    const { buildSlackClient } = jest.requireMock('@/lib/slack/client')
    const slack = buildSlackClient()
    slack.postMessage.mockClear()

    const req = makeSlackRequest({
      type: 'event_callback',
      event: { type: 'message', user: 'U001', channel: 'C_ISSUES', text: 'a normal report', ts: '1234567890.000010' },
    })
    await POST(req)
    await flushAfter()

    const opsAlerts = slack.postMessage.mock.calls.filter(([channel]: [string]) => channel === 'C_IMPROVEMENTS')
    expect(opsAlerts).toHaveLength(0)
  })

  it('alerts operators when an interactive action throws', async () => {
    const { buildSlackClient } = jest.requireMock('@/lib/slack/client')
    const slack = buildSlackClient()
    slack.postMessage.mockClear()
    const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')
    getSupabaseServiceClient.mockRejectedValueOnce(new Error('supabase unreachable'))

    const payload = JSON.stringify({
      type: 'block_actions',
      trigger_id: 'T1',
      channel: { id: 'C_ISSUES' },
      message: { ts: '1234567890.000011', thread_ts: '1234567890.000011' },
      user: { id: 'U_DEV' },
      actions: [{ action_id: STATUS_ACTION_ID, selected_option: { value: 'done' } }],
    })
    const res = await POST(makeSlackFormRequest(payload))
    await flushAfter()

    expect(res.status).toBe(200)
    const opsAlert = slack.postMessage.mock.calls.find(([channel]: [string]) => channel === 'C_IMPROVEMENTS')
    expect(opsAlert).toBeDefined()
  })

  describe('when ClickUp is down at intake', () => {
    async function runDegradedIntake(ts: string) {
      const { createTicket } = jest.requireMock('@/lib/issue-triage/router')
      const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')
      const { buildSlackClient } = jest.requireMock('@/lib/slack/client')
      const slack = buildSlackClient()
      const supabase = await getSupabaseServiceClient()

      slack.postMessage.mockClear()
      slack.postBlocks.mockClear()
      slack.addReaction.mockClear()
      supabase.from().insert.mockClear()
      createTicket.mockRejectedValueOnce(
        new Error('ClickUp API error: 401 {"err":"Token invalid","ECODE":"OAUTH_025"}'),
      )

      const req = makeSlackRequest({
        type: 'event_callback',
        event: { type: 'message', user: 'U001', channel: 'C_ISSUES', text: 'boards not loading', ts },
      })
      const res = await POST(req)
      await flushAfter()
      return { res, slack, insert: supabase.from().insert }
    }

    it('still records the issue, with no ticket id yet', async () => {
      const { insert } = await runDegradedIntake('1234567890.000020')

      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: '1234567890.000020', clickup_task_id: null, status: 'gathering' }),
      )
    })

    it('still answers the reporter with the intake question', async () => {
      const { slack } = await runDegradedIntake('1234567890.000021')

      const reply = slack.postBlocks.mock.calls.find(([channel]: [string]) => channel === 'C_ISSUES')
      expect(reply).toBeDefined()
      expect(renderedBlocks(reply)).toContain('Tell me more')
    })

    it('promises no ticket link it cannot deliver', async () => {
      const { slack } = await runDegradedIntake('1234567890.000022')

      const reply = slack.postBlocks.mock.calls.find(([channel]: [string]) => channel === 'C_ISSUES')
      expect(renderedBlocks(reply)).not.toContain('app.clickup.com')
      expect(renderedBlocks(reply)).not.toContain('View in ClickUp')
    })

    it('does not react as though a ticket was created', async () => {
      const { slack } = await runDegradedIntake('1234567890.000023')

      expect(slack.addReaction).not.toHaveBeenCalledWith(
        expect.anything(), expect.anything(), 'admission_tickets',
      )
    })

    it('alerts operators without telling the thread a human is needed', async () => {
      const { slack } = await runDegradedIntake('1234567890.000024')

      const opsAlert = slack.postMessage.mock.calls.find(([channel]: [string]) => channel === 'C_IMPROVEMENTS')
      expect(opsAlert).toBeDefined()
      expect(opsAlert[1]).toContain('Token invalid')

      // The reporter was served, so this is infrastructure noise, not an abandoned request.
      expect(slack.postMessage.mock.calls.some(([channel]: [string]) => channel === 'C_ISSUES')).toBe(false)
    })

    it('returns 200 so Slack does not retry', async () => {
      const { res } = await runDegradedIntake('1234567890.000025')
      expect(res.status).toBe(200)
    })
  })

  it('alerts operators when SLACK_ISSUES_CHANNEL_ID is missing', async () => {
    const { buildSlackClient } = jest.requireMock('@/lib/slack/client')
    const slack = buildSlackClient()
    slack.postMessage.mockClear()
    const saved = process.env.SLACK_ISSUES_CHANNEL_ID
    delete process.env.SLACK_ISSUES_CHANNEL_ID

    try {
      const req = makeSlackRequest({
        type: 'event_callback',
        event: { type: 'message', user: 'U001', channel: 'C_ANYWHERE', text: 'anyone home?', ts: '1234567890.000012' },
      })
      const res = await POST(req)
      await flushAfter()

      expect(res.status).toBe(200)
      const calls = slack.postMessage.mock.calls
      const opsAlert = calls.find(([channel]: [string]) => channel === 'C_IMPROVEMENTS')
      expect(opsAlert).toBeDefined()
      expect(opsAlert[1]).toContain('SLACK_ISSUES_CHANNEL_ID')

      // The bot must not speak into a channel it cannot confirm is the support channel.
      expect(calls.some(([channel]: [string]) => channel === 'C_ANYWHERE')).toBe(false)
    } finally {
      process.env.SLACK_ISSUES_CHANNEL_ID = saved
    }
  })

  it('returns 200 for a reaction_added event', async () => {
    const req = makeSlackRequest({
      type: 'event_callback',
      event: {
        type: 'reaction_added',
        user: 'U_DEV',
        reaction: 'white_check_mark',
        item: { type: 'message', channel: 'C_ISSUES', ts: '1.5' },
        item_user: 'U_BOT',
      },
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
  })
})

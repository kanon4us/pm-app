import { POST } from '@/app/api/webhooks/slack/route'
import { NextRequest } from 'next/server'
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
    getThreadReplies: jest.fn().mockResolvedValue([]),
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
    expect(slack.postMessage).toHaveBeenCalledWith(
      'C_ISSUES',
      expect.stringContaining('task-123'),
      '1234567890.000001',
    )
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

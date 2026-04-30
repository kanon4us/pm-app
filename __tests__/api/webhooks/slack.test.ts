import { POST } from '@/app/api/webhooks/slack/route'
import { NextRequest } from 'next/server'
import crypto from 'crypto'

const SIGNING_SECRET = 'test-signing-secret'
process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET
process.env.SLACK_ISSUES_CHANNEL_ID = 'C_ISSUES'
process.env.SLACK_BOT_TOKEN = 'xoxb-test'
process.env.CLICKUP_BOT_TOKEN = 'cu-test'
process.env.ANTHROPIC_API_KEY = 'anth-test'
process.env.GITHUB_TOKEN = 'gh-test'
process.env.CLICKUP_NEW_TICKETS_LIST_ID = 'list-new'
process.env.CLICKUP_KNOWN_ISSUES_LIST_ID = 'list-known'
process.env.CLICKUP_NEEDS_TUTORIAL_LIST_ID = 'list-tutorial'
process.env.CLICKUP_PLANNING_LIST_ID = 'list-planning'

// Mock next/server after() to run synchronously in tests
jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server')
  return { ...actual, after: jest.fn((fn: () => unknown) => fn()) }
})

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

jest.mock('@/lib/issue-triage/conversation', () => ({
  runIntakeTurn: jest.fn().mockResolvedValue({
    updated_schema: {},
    bot_response: 'Tell me more',
    confidence: 0.2,
  }),
}))

jest.mock('@/lib/slack/client', () => ({
  buildSlackClient: jest.fn().mockReturnValue({
    postMessage: jest.fn().mockResolvedValue('ts-bot'),
    getThreadReplies: jest.fn().mockResolvedValue([]),
  }),
}))

// Stub out the triage pipeline (not exercised in these tests)
jest.mock('@/lib/issue-triage/duplicate-detection', () => ({ detectDuplicate: jest.fn() }))
jest.mock('@/lib/issue-triage/workaround-search', () => ({ searchForWorkaround: jest.fn() }))
jest.mock('@/lib/issue-triage/router', () => ({ routeTicket: jest.fn() }))

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

  it('returns 200 for a valid new issue message', async () => {
    const req = makeSlackRequest({
      type: 'event_callback',
      event: { type: 'message', user: 'U001', channel: 'C_ISSUES', text: 'CMS crashed!', ts: '1234567890.000001' },
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
  })
})

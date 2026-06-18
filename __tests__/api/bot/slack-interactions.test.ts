// __tests__/api/bot/slack-interactions.test.ts
//
// TDD test for the Slack interactions webhook (Task 15).
// Mirrors the signature-building approach from __tests__/api/webhooks/slack.test.ts.

// ── env setup ────────────────────────────────────────────────────────────────
const SIGNING_SECRET = 'test-interactions-secret'
process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET
process.env.SLACK_BOT_TOKEN = 'xoxb-test'
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
process.env.VAULT_APP_BASE_URL = 'https://pm-app.example.com'

import { POST } from '@/app/api/bot/slack/interactions/route'
import { NextRequest } from 'next/server'
import crypto from 'crypto'

// ── mocks ─────────────────────────────────────────────────────────────────────

let mockEnqueue: jest.Mock
jest.mock('@/lib/queue/client', () => ({
  enqueue: (...args: unknown[]) => mockEnqueue(...args),
}))

let mockOpenModal: jest.Mock
jest.mock('@/lib/slack/client', () => ({
  buildSlackClient: jest.fn().mockImplementation(() => ({
    openModal: (...args: unknown[]) => mockOpenModal(...args),
  })),
}))

let mockSupabaseFrom: jest.Mock
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockImplementation(() =>
    Promise.resolve({ from: (...args: unknown[]) => mockSupabaseFrom(...args) })
  ),
}))

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a valid signed form-encoded request containing a Slack interactions payload. */
function makeInteractionRequest(payload: object): NextRequest {
  const payloadStr = JSON.stringify(payload)
  const body = `payload=${encodeURIComponent(payloadStr)}`
  const ts = String(Math.floor(Date.now() / 1000))
  const base = `v0:${ts}:${body}`
  const sig = 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(base).digest('hex')

  return new NextRequest('http://localhost/api/bot/slack/interactions', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sig,
    },
    body,
  })
}

// Shared test block_id encodes: runId|docPath|questionId
const RUN_ID = 'run-abc-123'
const DOC_PATH = 'docs/style-guide.md'
const QUESTION_ID = 'q-001'
const BLOCK_ID = `${RUN_ID}|${DOC_PATH}|${QUESTION_ID}`
const SESSION_ID = 'session-uuid-999'
const RESPONSE_URL = 'https://hooks.slack.com/actions/T00/B00/xxxyyy'
const TRIGGER_ID = 'trigger-abc.123.def'

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  mockEnqueue = jest.fn().mockResolvedValue(undefined)
  mockOpenModal = jest.fn().mockResolvedValue({ ok: true })

  // Supabase from() returns a chain that resolves a session row
  mockSupabaseFrom = jest.fn().mockReturnValue({
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({
      data: { id: SESSION_ID, run_id: RUN_ID, doc_path: DOC_PATH },
      error: null,
    }),
  })
})

// ── tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/bot/slack/interactions', () => {
  // ── T1: invalid signature → 401, enqueue NOT called ──────────────────────
  it('returns 401 and does not enqueue when signature is invalid', async () => {
    const payloadStr = JSON.stringify({
      type: 'block_actions',
      trigger_id: TRIGGER_ID,
      user: { id: 'U_ALICE' },
      actions: [{ action_id: 'archive', block_id: BLOCK_ID, value: 'keep' }],
      response_url: RESPONSE_URL,
    })
    const body = `payload=${encodeURIComponent(payloadStr)}`

    const req = new NextRequest('http://localhost/api/bot/slack/interactions', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-slack-signature': 'v0=badsignature',
      },
      body,
    })

    const res = await POST(req)
    expect(res.status).toBe(401)
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockOpenModal).not.toHaveBeenCalled()
  })

  // ── T2: valid 'archive' action → 200, enqueue called, openModal NOT called ─
  it('returns 200 and enqueues write for a non-merge action (archive)', async () => {
    const req = makeInteractionRequest({
      type: 'block_actions',
      trigger_id: TRIGGER_ID,
      user: { id: 'U_ALICE' },
      actions: [{ action_id: 'archive', block_id: BLOCK_ID, value: 'archive' }],
      response_url: RESPONSE_URL,
    })

    const res = await POST(req)
    expect(res.status).toBe(200)

    // enqueue must have been called exactly once
    expect(mockEnqueue).toHaveBeenCalledTimes(1)

    // destination URL ends with /api/vault/consolidation/write
    const [destUrl, body] = mockEnqueue.mock.calls[0] as [string, Record<string, unknown>]
    expect(destUrl).toMatch(/\/api\/vault\/consolidation\/write$/)

    // body contains sessionId, actionId, and responseUrl
    expect(body).toMatchObject({
      sessionId: SESSION_ID,
      actionId: 'archive',
      responseUrl: RESPONSE_URL,
    })

    // openModal must NOT have been called (no GitHub write happening here either)
    expect(mockOpenModal).not.toHaveBeenCalled()
  })

  // ── T3: 'merge-canonical' → 200, openModal called, enqueue NOT called ────
  it('returns 200 and opens modal for merge-canonical action', async () => {
    const req = makeInteractionRequest({
      type: 'block_actions',
      trigger_id: TRIGGER_ID,
      user: { id: 'U_ALICE' },
      actions: [{ action_id: 'merge-canonical', block_id: BLOCK_ID, value: 'merge' }],
      response_url: RESPONSE_URL,
    })

    const res = await POST(req)
    expect(res.status).toBe(200)

    // openModal called with the trigger_id and a valid view object
    expect(mockOpenModal).toHaveBeenCalledTimes(1)
    const [triggerId, view] = mockOpenModal.mock.calls[0] as [string, Record<string, unknown>]
    expect(triggerId).toBe(TRIGGER_ID)
    expect(view).toMatchObject({
      type: 'modal',
      title: expect.objectContaining({ text: expect.any(String) }),
    })

    // enqueue must NOT be called for modal path
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  // ── T4: 'distinct' → 200, openModal called, enqueue NOT called ───────────
  it('returns 200 and opens modal for distinct action', async () => {
    const req = makeInteractionRequest({
      type: 'block_actions',
      trigger_id: TRIGGER_ID,
      user: { id: 'U_ALICE' },
      actions: [{ action_id: 'distinct', block_id: BLOCK_ID, value: 'distinct' }],
      response_url: RESPONSE_URL,
    })

    const res = await POST(req)
    expect(res.status).toBe(200)

    expect(mockOpenModal).toHaveBeenCalledTimes(1)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  // ── T5: unknown action type → 200, enqueue called (generic write path) ───
  it('returns 200 and enqueues write for an unknown action (keep)', async () => {
    const req = makeInteractionRequest({
      type: 'block_actions',
      trigger_id: TRIGGER_ID,
      user: { id: 'U_ALICE' },
      actions: [{ action_id: 'keep', block_id: BLOCK_ID, value: 'keep' }],
      response_url: RESPONSE_URL,
    })

    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockOpenModal).not.toHaveBeenCalled()
  })
})

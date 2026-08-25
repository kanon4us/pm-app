// __tests__/api/vault/write.test.ts
//
// The serialized git-write consumer. Everything here is driven by QStash, so
// the governing constraint is: a non-2xx means the whole message is redelivered
// and the git write is REPLAYED. Any step after the commit must therefore be
// unable to fail the request, and a replay must not corrupt the session.

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
process.env.QSTASH_CURRENT_SIGNING_KEY = 'sig-current'
process.env.QSTASH_NEXT_SIGNING_KEY = 'sig-next'
process.env.SLACK_BOT_TOKEN = 'xoxb-test'
process.env.GITHUB_TOKEN = 'gh-test-token'

import { NextRequest } from 'next/server'
import { POST } from '@/app/api/vault/consolidation/write/route'
import { SlackApiError } from '@/lib/slack/client'

// ── mocks ─────────────────────────────────────────────────────────────────────
// jest.mock factories are hoisted above declarations, so outer variables are
// referenced through lambdas that close over them at call time.

let mockVerifyQstashSignature: jest.Mock
jest.mock('@/lib/queue/client', () => ({
  verifyQstashSignature: (...args: unknown[]) => mockVerifyQstashSignature(...args),
}))

let mockApplyAction: jest.Mock
jest.mock('@/lib/vault/git-writes', () => ({
  applyAction: (...args: unknown[]) => mockApplyAction(...args),
}))

jest.mock('@/lib/github/vault', () => ({
  readVaultFile: jest.fn().mockResolvedValue({ content: '', sha: 'sha-1' }),
  writeVaultFile: jest.fn().mockResolvedValue({}),
  getBranchSha: jest.fn().mockResolvedValue('branch-sha'),
  createBranch: jest.fn().mockResolvedValue(true),
}))

let mockUpdateViaResponseUrl: jest.Mock
jest.mock('@/lib/slack/client', () => ({
  ...jest.requireActual('@/lib/slack/client'),
  buildSlackClient: jest.fn().mockImplementation(() => ({
    updateViaResponseUrl: (...args: unknown[]) => mockUpdateViaResponseUrl(...args),
  })),
}))

let mockSession: Record<string, unknown> | null
let mockStatusUpdate: jest.Mock
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockImplementation(() =>
    Promise.resolve({
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({ data: mockSession, error: mockSession ? null : { message: 'not found' } }),
          }),
        }),
        update: (...args: unknown[]) => {
          mockStatusUpdate(...args)
          return { eq: async () => ({ error: null }) }
        },
      }),
    })
  ),
}))

// ── fixtures ──────────────────────────────────────────────────────────────────

const SESSION = {
  id: 'sess-1',
  run_id: '2026-W25',
  doc_path: 'docs/stable-doc.md',
  branch: 'vault-consolidation/2026-W25',
  base_blob_sha: 'sha-stable',
  status: 'open',
}

function makeRequest(body: object) {
  return new NextRequest('https://app.example.com/api/vault/consolidation/write', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'upstash-signature': 'valid-sig' },
    body: JSON.stringify(body),
  })
}

const MESSAGE = {
  sessionId: 'sess-1',
  actionId: 'mark-legacy',
  responseUrl: 'https://hooks.slack.com/actions/T1/B1/XYZ',
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/vault/consolidation/write', () => {
  beforeEach(() => {
    mockVerifyQstashSignature = jest.fn().mockResolvedValue(true)
    mockApplyAction = jest.fn().mockResolvedValue({ aborted: false })
    mockUpdateViaResponseUrl = jest.fn().mockResolvedValue(undefined)
    mockStatusUpdate = jest.fn()
    mockSession = { ...SESSION }
  })

  it('applies the action and marks the session answered', async () => {
    const res = await POST(makeRequest(MESSAGE))

    expect(res.status).toBe(200)
    expect(mockApplyAction).toHaveBeenCalledTimes(1)
    expect(mockStatusUpdate).toHaveBeenCalledWith({ status: 'answered' })
  })

  it('marks the session aborted when the optimistic lock rejects the write', async () => {
    mockApplyAction.mockResolvedValue({ aborted: true, reason: 'stale' })

    const res = await POST(makeRequest(MESSAGE))

    expect(res.status).toBe(200)
    expect(mockStatusUpdate).toHaveBeenCalledWith({ status: 'aborted' })
  })

  // ── replay safety ───────────────────────────────────────────────────────────

  it('does not re-apply the write when the session was already answered', async () => {
    // A redelivery after a successful run. Re-applying would find the blob SHA
    // it changed itself, abort as 'stale', and downgrade a completed review.
    mockSession = { ...SESSION, status: 'answered' }

    const res = await POST(makeRequest(MESSAGE))

    expect(res.status).toBe(200)
    expect(mockApplyAction).not.toHaveBeenCalled()
  })

  it('does not downgrade an answered session on redelivery', async () => {
    mockSession = { ...SESSION, status: 'answered' }

    await POST(makeRequest(MESSAGE))

    expect(mockStatusUpdate).not.toHaveBeenCalled()
  })

  it('does not re-apply the write when the session was already aborted', async () => {
    mockSession = { ...SESSION, status: 'aborted' }

    const res = await POST(makeRequest(MESSAGE))

    expect(res.status).toBe(200)
    expect(mockApplyAction).not.toHaveBeenCalled()
  })

  it('still processes a session that is merely open', async () => {
    mockSession = { ...SESSION, status: 'open' }

    await POST(makeRequest(MESSAGE))

    expect(mockApplyAction).toHaveBeenCalledTimes(1)
  })

  // ── the card update must never fail the request ──────────────────────────────

  it('acks when the Slack card update fails, because the commit already landed', async () => {
    mockUpdateViaResponseUrl.mockRejectedValue(new SlackApiError('expired_url', 'response_url'))

    const res = await POST(makeRequest(MESSAGE))

    expect(res.status).toBe(200)
  })

  it('keeps the session answered when only the card update failed', async () => {
    mockUpdateViaResponseUrl.mockRejectedValue(new SlackApiError('expired_url', 'response_url'))

    await POST(makeRequest(MESSAGE))

    expect(mockStatusUpdate).toHaveBeenCalledWith({ status: 'answered' })
  })

  it('acks when the card update fails after an aborted write', async () => {
    mockApplyAction.mockResolvedValue({ aborted: true, reason: 'stale' })
    mockUpdateViaResponseUrl.mockRejectedValue(new Error('network down'))

    const res = await POST(makeRequest(MESSAGE))

    expect(res.status).toBe(200)
  })
})

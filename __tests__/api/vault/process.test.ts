// __tests__/api/vault/process.test.ts

// ── env setup ─────────────────────────────────────────────────────────────────
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
process.env.QSTASH_CURRENT_SIGNING_KEY = 'sig-current'
process.env.QSTASH_NEXT_SIGNING_KEY = 'sig-next'
process.env.SLACK_BOT_TOKEN = 'xoxb-test'
process.env.VAULT_AUTHOR_SLACK_MAP = JSON.stringify({ 'alice@viscap.com': 'U_ALICE' })
process.env.PM_SLACK_ID = 'U_PM'

import { NextRequest } from 'next/server'
import { POST } from '@/app/api/vault/consolidation/process/route'

// ── mock helpers ──────────────────────────────────────────────────────────────
// IMPORTANT: jest.mock factories are hoisted above all declarations, so outer
// variables cannot be referenced directly inside the factory. Use lambdas.

let mockVerifyQstashSignature: jest.Mock
jest.mock('@/lib/queue/client', () => ({
  verifyQstashSignature: (...args: unknown[]) => mockVerifyQstashSignature(...args),
}))

let mockLoadSnapshot: jest.Mock
jest.mock('@/lib/vault/snapshot', () => ({
  loadSnapshot: (...args: unknown[]) => mockLoadSnapshot(...args),
}))

let mockPhraseQuestionText: jest.Mock
jest.mock('@/lib/vault/llm', () => ({
  phraseQuestionText: (...args: unknown[]) => mockPhraseQuestionText(...args),
}))

let mockDm: jest.Mock
jest.mock('@/lib/slack/client', () => ({
  buildSlackClient: jest.fn().mockImplementation(() => ({
    dm: (...args: unknown[]) => mockDm(...args),
  })),
}))

let mockSelectChain: jest.Mock
let mockInsertChain: jest.Mock
let mockSupabaseFrom: jest.Mock
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockImplementation(() =>
    Promise.resolve({ from: (...args: unknown[]) => mockSupabaseFrom(...args) })
  ),
}))

// ── fixture data ──────────────────────────────────────────────────────────────

const MOCK_DOC = {
  path: 'docs/stable-doc.md',
  content: '# Doc',
  blobSha: 'sha-stable',
  lastCommitISO: '2026-05-01T00:00:00Z',
  lastCommitterEmail: 'alice@viscap.com',
  frontmatter: {},
}

const MOCK_SNAPSHOT = {
  runId: '2026-W25',
  generatedAt: '2026-06-17T00:00:00Z',
  docs: [MOCK_DOC],
  backlinks: [] as Array<[string, string[]]>,
}

// The doc has no backlinks (orphan) + no source/status (no-provenance) → 2 questions
// The first question that buildQuestions produces for an orphan is 'orphan'

function makeRequest(body: object, signature = 'valid-sig') {
  const bodyStr = JSON.stringify(body)
  return new NextRequest('https://app.example.com/api/vault/consolidation/process', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'upstash-signature': signature,
    },
    body: bodyStr,
  })
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/vault/consolidation/process', () => {
  beforeEach(() => {
    mockVerifyQstashSignature = jest.fn().mockResolvedValue(true)
    mockLoadSnapshot = jest.fn().mockResolvedValue(MOCK_SNAPSHOT)
    mockPhraseQuestionText = jest.fn().mockImplementation((q: { text: string }) =>
      Promise.resolve(q.text)
    )
    mockDm = jest.fn().mockResolvedValue({ ok: true, ts: 'ts-123', channel: 'D_CHAN' })

    // Default Supabase mock: count = 0 (no existing sessions), insert succeeds
    const insertResult = { error: null }
    mockInsertChain = jest.fn().mockResolvedValue(insertResult)

    // select chain for counting: .select('*', { count: 'exact', head: true }).eq(...).eq(...)
    mockSelectChain = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ count: 0, error: null }),
      }),
    })

    mockSupabaseFrom = jest.fn().mockImplementation((table: string) => {
      if (table === 'vault_review_sessions') {
        return {
          select: mockSelectChain,
          insert: mockInsertChain,
        }
      }
      return { select: mockSelectChain, insert: mockInsertChain }
    })
  })

  // ── invalid signature ───────────────────────────────────────────────────────

  it('returns 401 when QStash signature is invalid', async () => {
    mockVerifyQstashSignature.mockResolvedValue(false)
    const res = await POST(makeRequest({ runId: '2026-W25', docPath: 'docs/stable-doc.md' }))
    expect(res.status).toBe(401)
    expect(mockDm).not.toHaveBeenCalled()
    expect(mockInsertChain).not.toHaveBeenCalled()
  })

  // ── doc not in snapshot ─────────────────────────────────────────────────────

  it('returns 200 and does nothing when doc is not in snapshot', async () => {
    const res = await POST(makeRequest({ runId: '2026-W25', docPath: 'docs/missing.md' }))
    expect(res.status).toBe(200)
    expect(mockDm).not.toHaveBeenCalled()
    expect(mockInsertChain).not.toHaveBeenCalled()
  })

  // ── happy path: stable doc with questions ───────────────────────────────────

  it('sends a DM and inserts session row with status open when doc has questions', async () => {
    const res = await POST(makeRequest({ runId: '2026-W25', docPath: 'docs/stable-doc.md' }))
    expect(res.status).toBe(200)

    // DM must be sent once (for the primary question)
    expect(mockDm).toHaveBeenCalledTimes(1)
    // DM first arg is the author's Slack ID
    expect(mockDm).toHaveBeenCalledWith('U_ALICE', expect.any(Array), expect.any(String))

    // Insert must be called with status: 'open' and base_blob_sha
    expect(mockInsertChain).toHaveBeenCalledTimes(1)
    expect(mockInsertChain).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'open',
        base_blob_sha: 'sha-stable',
      })
    )
  })

  // ── DM cap: >= 5 existing sessions → digest ─────────────────────────────────

  it('skips DM and inserts digest row when author already has 5 sessions this run', async () => {
    // Override the count mock to return 5
    mockSelectChain = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ count: 5, error: null }),
      }),
    })
    mockSupabaseFrom = jest.fn().mockImplementation(() => ({
      select: mockSelectChain,
      insert: mockInsertChain,
    }))

    const res = await POST(makeRequest({ runId: '2026-W25', docPath: 'docs/stable-doc.md' }))
    expect(res.status).toBe(200)

    // No DM sent
    expect(mockDm).not.toHaveBeenCalled()

    // Session row inserted with status: 'digest'
    expect(mockInsertChain).toHaveBeenCalledTimes(1)
    expect(mockInsertChain).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'digest',
      })
    )
  })
})

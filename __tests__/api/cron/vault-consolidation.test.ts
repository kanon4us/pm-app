// __tests__/api/cron/vault-consolidation.test.ts
import { GET } from '@/app/api/cron/vault-consolidation/route'
import { NextRequest } from 'next/server'

// ── env setup ────────────────────────────────────────────────────────────────
process.env.CRON_SECRET = 'test-cron-secret'
process.env.GITHUB_VAULT_TOKEN = 'gh-test-token'
process.env.SLACK_BOT_TOKEN = 'xoxb-test'
process.env.VAULT_CONSOLIDATION_SLACK_CHANNEL = 'C_VAULT'
process.env.VAULT_APP_BASE_URL = 'https://app.example.com'
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
process.env.QSTASH_TOKEN = 'qstash-test-token'

// ── mock helpers ──────────────────────────────────────────────────────────────
// IMPORTANT: jest.mock factories are hoisted above all `const`/`let` declarations,
// so factories CANNOT reference outer module-scope variables directly — the
// bindings don't exist yet at factory-evaluation time. All outer-variable
// references must be wrapped in lambdas that close over them at *call* time.

let mockBuildSnapshot: jest.Mock
let mockStoreSnapshot: jest.Mock
jest.mock('@/lib/vault/snapshot', () => ({
  buildSnapshot: (...args: unknown[]) => mockBuildSnapshot(...args),
  storeSnapshot: (...args: unknown[]) => mockStoreSnapshot(...args),
}))

let mockEnqueue: jest.Mock
jest.mock('@/lib/queue/client', () => ({
  enqueue: (...args: unknown[]) => mockEnqueue(...args),
}))

let mockPostMessage: jest.Mock
jest.mock('@/lib/slack/client', () => ({
  buildSlackClient: jest.fn().mockReturnValue({
    postMessage: (...args: unknown[]) => mockPostMessage(...args),
  }),
}))

let mockSupabaseFrom: jest.Mock
let mockSupabaseClient: { from: jest.Mock }
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockImplementation(() =>
    Promise.resolve(mockSupabaseClient)
  ),
}))

// ── fixture data ──────────────────────────────────────────────────────────────

// 3 docs: 2 stable (>7 days old), 1 recent. Dates are relative to now so the
// isStable 7-day window holds no matter when the suite runs.
const DAY_MS = 86_400_000
const STABLE_DATE = new Date(Date.now() - 30 * DAY_MS).toISOString() // well over 7 days ago
const RECENT_DATE = new Date(Date.now() - 1 * DAY_MS).toISOString()  // 1 day ago

const MOCK_SNAPSHOT = {
  runId: '2026-W25',
  generatedAt: new Date().toISOString(),
  docs: [
    {
      path: 'stable-doc-a.md',
      content: '# Doc A',
      blobSha: 'sha-a',
      lastCommitISO: STABLE_DATE,
      lastCommitterEmail: 'alice@viscap.com',
      frontmatter: {},
    },
    {
      path: 'stable-doc-b.md',
      content: '# Doc B',
      blobSha: 'sha-b',
      lastCommitISO: STABLE_DATE,
      lastCommitterEmail: 'bob@viscap.com',
      frontmatter: {},
    },
    {
      path: 'recent-doc.md',
      content: '# Recent',
      blobSha: 'sha-r',
      lastCommitISO: RECENT_DATE,
      lastCommitterEmail: 'carol@viscap.com',
      frontmatter: {},
    },
  ],
  backlinks: [] as Array<[string, string[]]>,
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeRequest(token = 'test-cron-secret') {
  return new NextRequest('https://app.example.com/api/cron/vault-consolidation', {
    headers: { authorization: `Bearer ${token}` },
  })
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/cron/vault-consolidation', () => {
  beforeEach(() => {
    // Initialize all mocks before each test
    mockBuildSnapshot = jest.fn().mockResolvedValue(MOCK_SNAPSHOT)
    mockStoreSnapshot = jest.fn().mockResolvedValue(undefined)
    mockEnqueue = jest.fn().mockResolvedValue(undefined)
    mockPostMessage = jest.fn().mockResolvedValue('ts-123')

    const insertFn = jest.fn().mockResolvedValue({ error: null })
    mockSupabaseFrom = jest.fn().mockReturnValue({ insert: insertFn })
    mockSupabaseClient = { from: mockSupabaseFrom }
  })

  // ── auth guard ──────────────────────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const req = new NextRequest('https://app.example.com/api/cron/vault-consolidation')
    const res = await GET(req)
    expect(res.status).toBe(401)

    // None of the side-effects should have fired
    expect(mockStoreSnapshot).not.toHaveBeenCalled()
    expect(mockPostMessage).not.toHaveBeenCalled()
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockSupabaseFrom).not.toHaveBeenCalled()
  })

  it('returns 401 when cron secret is wrong', async () => {
    const res = await GET(makeRequest('wrong-secret'))
    expect(res.status).toBe(401)

    expect(mockStoreSnapshot).not.toHaveBeenCalled()
    expect(mockPostMessage).not.toHaveBeenCalled()
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockSupabaseFrom).not.toHaveBeenCalled()
  })

  // ── happy path ──────────────────────────────────────────────────────────────

  it('stores the snapshot exactly once', async () => {
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    expect(mockStoreSnapshot).toHaveBeenCalledTimes(1)
    expect(mockStoreSnapshot).toHaveBeenCalledWith(mockSupabaseClient, MOCK_SNAPSHOT)
  })

  it('posts a Slack change-report message', async () => {
    await GET(makeRequest())
    expect(mockPostMessage).toHaveBeenCalledTimes(1)
    expect(mockPostMessage).toHaveBeenCalledWith(
      'C_VAULT',
      expect.any(String),
    )
  })

  it('inserts a vault_review_runs row with run_id and snapshot_ref', async () => {
    const insertMock = jest.fn().mockResolvedValue({ error: null })
    mockSupabaseFrom.mockReturnValue({ insert: insertMock })

    await GET(makeRequest())

    expect(mockSupabaseFrom).toHaveBeenCalledWith('vault_review_runs')
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        run_id: expect.stringMatching(/^\d{4}-W\d{2}$/),
        snapshot_ref: expect.stringMatching(/^\d{4}-W\d{2}$/),
      }),
    )
  })

  it('enqueues only stable docs — 2 of 3 fixture docs', async () => {
    await GET(makeRequest())
    expect(mockEnqueue).toHaveBeenCalledTimes(2)
  })

  it('enqueue payloads contain only runId + docPath (no backlinks or docs fields)', async () => {
    await GET(makeRequest())

    for (const call of mockEnqueue.mock.calls) {
      const [url, payload] = call as [string, Record<string, unknown>]
      expect(url).toBe('https://app.example.com/api/vault/consolidation/process')
      expect(payload).toHaveProperty('runId')
      expect(payload).toHaveProperty('docPath')
      expect(payload).not.toHaveProperty('backlinks')
      expect(payload).not.toHaveProperty('docs')
      expect(payload).not.toHaveProperty('content')
    }
  })

  it('enqueues the two stable docs, not the recent one', async () => {
    await GET(makeRequest())

    const enqueuedPaths = mockEnqueue.mock.calls.map(
      ([, payload]: [string, { docPath: string }]) => payload.docPath,
    )
    expect(enqueuedPaths).toContain('stable-doc-a.md')
    expect(enqueuedPaths).toContain('stable-doc-b.md')
    expect(enqueuedPaths).not.toContain('recent-doc.md')
  })

  it('returns 200 with a summary body on success', async () => {
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      result: 'ok',
      runId: expect.stringMatching(/^\d{4}-W\d{2}$/),
      enqueued: 2,
    })
  })

  // ── dry-run + limit (validation controls) ─────────────────────────────────

  function makeRequestWithQuery(query: string, token = 'test-cron-secret') {
    return new NextRequest(
      `https://app.example.com/api/cron/vault-consolidation?${query}`,
      { headers: { authorization: `Bearer ${token}` } },
    )
  }

  it('dryRun=1 returns a report with ZERO side effects', async () => {
    const res = await GET(makeRequestWithQuery('dryRun=1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ dryRun: true, totalDocs: 3, stableDocs: 2 })
    expect(body.docs).toHaveLength(2)
    expect(body.docs[0]).toHaveProperty('signals')
    expect(body.docs[0]).toHaveProperty('questions')
    expect(body.docs[0].author).toHaveProperty('slackId')
    // No writes, no Slack, no enqueue
    expect(mockStoreSnapshot).not.toHaveBeenCalled()
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockPostMessage).not.toHaveBeenCalled()
    expect(mockSupabaseFrom).not.toHaveBeenCalled()
  })

  it('limit=1 caps the live fan-out to a single stable doc', async () => {
    const res = await GET(makeRequestWithQuery('limit=1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ result: 'ok', enqueued: 1 })
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
  })
})

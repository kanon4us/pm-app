// __tests__/api/cron/closeout.test.ts
import { NextRequest } from 'next/server'

// ── env setup ──────────────────────────────────────────────────────────────────
process.env.CRON_SECRET = 'test-cron-secret'
process.env.GITHUB_VAULT_TOKEN = 'gh-test-token'
process.env.GITHUB_VAULT_REPO = 'ViscapMedia/documentation'
process.env.SLACK_BOT_TOKEN = 'xoxb-test'
process.env.PM_SLACK_ID = 'U_PM_123'
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'

// ── mock helpers ───────────────────────────────────────────────────────────────
// IMPORTANT: jest.mock factories are hoisted above all `const`/`let` declarations,
// so factories CANNOT reference outer module-scope variables directly — the
// bindings don't exist yet at factory-evaluation time. All outer-variable
// references must be wrapped in lambdas that close over them at *call* time.

let mockMaybeSingle: jest.Mock
let mockGetSessionsSelect: jest.Mock
let mockUpdateEq: jest.Mock
let mockSupabaseClient: { from: jest.Mock }

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockImplementation(() =>
    Promise.resolve(mockSupabaseClient)
  ),
}))

let mockDm: jest.Mock
jest.mock('@/lib/slack/client', () => ({
  buildSlackClient: jest.fn().mockReturnValue({
    dm: (...args: unknown[]) => mockDm(...args),
  }),
}))

// ── fixture data ──────────────────────────────────────────────────────────────

const MOCK_SESSIONS_ANSWERED = [
  {
    doc_path: 'docs/process/onboarding.md',
    author_email: 'alice@viscap.com',
    status: 'answered',
  },
  {
    doc_path: 'docs/process/offboarding.md',
    author_email: 'bob@viscap.com',
    status: 'answered',
  },
]

const MOCK_PR_URL = 'https://github.com/ViscapMedia/documentation/pull/42'

// ── helpers ───────────────────────────────────────────────────────────────────

function makeRequest(token = 'test-cron-secret') {
  return new NextRequest('https://app.example.com/api/cron/vault-consolidation-closeout', {
    headers: { authorization: `Bearer ${token}` },
  })
}

type SessionRow = {
  doc_path: string
  author_email: string
  status: string
  audience?: string
}

function setupSupabaseMocks({
  prUrl = null,
  sessions = MOCK_SESSIONS_ANSWERED as SessionRow[],
}: {
  prUrl?: string | null
  sessions?: SessionRow[]
} = {}) {
  // maybeSingle() returns a single object (not array) or null
  mockMaybeSingle = jest.fn().mockResolvedValue({
    data: prUrl !== undefined ? { run_id: '2026-W25', pr_url: prUrl } : null,
    error: null,
  })

  const sessionsResult = { data: sessions, error: null }
  mockGetSessionsSelect = jest.fn().mockReturnValue(Promise.resolve(sessionsResult))

  // update().eq() is awaited directly
  mockUpdateEq = jest.fn().mockResolvedValue({ error: null })

  mockSupabaseClient = {
    from: jest.fn().mockImplementation((table: string) => {
      if (table === 'vault_review_runs') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: mockMaybeSingle,
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: mockUpdateEq,
          }),
        }
      }
      if (table === 'vault_review_sessions') {
        return {
          // select().eq() is awaited directly — eq must return a Promise
          select: jest.fn().mockReturnValue({
            eq: mockGetSessionsSelect,
          }),
        }
      }
      return {}
    }),
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/cron/vault-consolidation-closeout', () => {
  let GET: (req: NextRequest) => Promise<Response>

  beforeAll(async () => {
    // Import after mocks are set up so they take effect
    ;({ GET } = await import('@/app/api/cron/vault-consolidation-closeout/route'))
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockDm = jest.fn().mockResolvedValue({ ok: true })

    // Default fetch mock returns a successful PR creation response
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ html_url: MOCK_PR_URL, number: 42 }),
      text: async () => '',
    } as Response)
  })

  // ── auth guard ─────────────────────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    setupSupabaseMocks()
    const req = new NextRequest('https://app.example.com/api/cron/vault-consolidation-closeout')
    const res = await GET(req)
    expect(res.status).toBe(401)
    expect(global.fetch).not.toHaveBeenCalled()
    expect(mockDm).not.toHaveBeenCalled()
  })

  it('returns 401 when cron secret is wrong', async () => {
    setupSupabaseMocks()
    const res = await GET(makeRequest('wrong-secret'))
    expect(res.status).toBe(401)
    expect(global.fetch).not.toHaveBeenCalled()
    expect(mockDm).not.toHaveBeenCalled()
  })

  // ── happy path: PR not yet open ────────────────────────────────────────────

  it('creates a PR exactly once when pr_url is not yet set', async () => {
    setupSupabaseMocks({ prUrl: null, sessions: MOCK_SESSIONS_ANSWERED })
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    // fetch was called for the PR creation
    const prCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([url]: [string]) => typeof url === 'string' && url.includes('/pulls')
    )
    expect(prCalls).toHaveLength(1)

    const [prUrl, prInit] = prCalls[0] as [string, RequestInit]
    expect(prUrl).toContain('/repos/ViscapMedia/documentation/pulls')
    const body = JSON.parse(prInit.body as string)
    expect(body.head).toMatch(/^vault-consolidation\/\d{4}-W\d{2}$/)
    expect(body.base).toBe('main')
    expect(body.title).toMatch(/Weekly vault consolidation/)
  })

  it('saves pr_url to the run row after PR is created', async () => {
    setupSupabaseMocks({ prUrl: null, sessions: MOCK_SESSIONS_ANSWERED })
    await GET(makeRequest())

    // update().eq('run_id', runId) is called with the field name and runId value
    expect(mockUpdateEq).toHaveBeenCalledWith(
      'run_id',
      expect.stringMatching(/^\d{4}-W\d{2}$/)
    )
  })

  it('returns 200 with prUrl in the response body', async () => {
    setupSupabaseMocks({ prUrl: null, sessions: MOCK_SESSIONS_ANSWERED })
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ prUrl: MOCK_PR_URL })
  })

  // ── idempotency: PR already open ───────────────────────────────────────────

  it('returns 200 with alreadyOpen:true when pr_url is already set', async () => {
    setupSupabaseMocks({ prUrl: MOCK_PR_URL, sessions: MOCK_SESSIONS_ANSWERED })
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ alreadyOpen: true })
  })

  it('does NOT create a PR when pr_url is already set', async () => {
    setupSupabaseMocks({ prUrl: MOCK_PR_URL, sessions: MOCK_SESSIONS_ANSWERED })
    await GET(makeRequest())

    const prCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([url]: [string]) => typeof url === 'string' && url.includes('/pulls')
    )
    expect(prCalls).toHaveLength(0)
  })

  // ── stale support items → PM ping ─────────────────────────────────────────

  it('does NOT ping PM when no sessions have audience=support + unanswered', async () => {
    // Open session but no audience column → audience is undefined → NOT support
    setupSupabaseMocks({
      prUrl: null,
      sessions: [
        {
          doc_path: 'support/ticket-handling.md',
          author_email: 'carol@viscap.com',
          status: 'open',
          // No audience field — route maps to audience: undefined
        },
      ],
    })
    await GET(makeRequest())
    // audience is undefined (not 'support'), so no PM ping
    expect(mockDm).not.toHaveBeenCalled()
  })

  it('pings the PM when a session row carries audience=support and status is open (unanswered)', async () => {
    // The vault_review_sessions schema does not currently include an 'audience'
    // column. The route reads it as a dynamic property if present on the row
    // (forward-compatible). This test verifies the plumbing fires when the
    // property is present (e.g. after a future schema migration).
    setupSupabaseMocks({
      prUrl: null,
      sessions: [
        {
          doc_path: 'support/stale-doc.md',
          author_email: 'alice@viscap.com',
          status: 'open',
          audience: 'support',
        },
      ],
    })

    await GET(makeRequest())

    expect(mockDm).toHaveBeenCalledWith(
      'U_PM_123',
      expect.any(Array),
      expect.any(String),
    )
  })
})

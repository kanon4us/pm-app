// Covers the GitHub client behind the weekly vault snapshot: bounded fan-out,
// backoff when GitHub throttles, and the fail-safe direction of the
// last-commit fallback.
//
// Regression context: `lastCommit` is one API call per doc and used to be
// issued via an unbounded `Promise.all`, which trips GitHub's secondary
// (burst/concurrency) rate limit and turns a run into hundreds of failed
// requests. The old failure fallback then stamped the doc with the epoch —
// maximally old — so every throttled doc was reported as *stable* and fanned
// out for review, with 'unknown' as its committer email.

process.env.GITHUB_VAULT_REPO = 'ViscapMedia/documentation'
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
process.env.QSTASH_TOKEN = 'qstash-test-token'

jest.mock('@/lib/supabase/server', () => ({ getSupabaseServiceClient: jest.fn() }))
jest.mock('@/lib/queue/client', () => ({ enqueue: jest.fn() }))
jest.mock('@/lib/slack/client', () => ({ buildSlackClient: jest.fn() }))
jest.mock('@/lib/github/vault', () => ({ readVaultFile: jest.fn(), writeVaultFile: jest.fn() }))

import { buildGithubDeps } from '@/app/api/cron/vault-consolidation/route'
import { isStable } from '@/lib/vault/changes'

type FakeResponse = Pick<Response, 'ok' | 'status' | 'headers' | 'json' | 'text'>

function res(status: number, body: unknown, headers: Record<string, string> = {}): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

/** A `contents` API payload for a doc with the given body. */
function contentsRes(body: string): FakeResponse {
  return res(200, { type: 'file', content: Buffer.from(body, 'utf-8').toString('base64') })
}

const TREE = (paths: string[]) =>
  res(200, { tree: paths.map((path) => ({ path, type: 'blob', sha: `sha-${path}` })) })

let fetchMock: jest.Mock
beforeEach(() => {
  fetchMock = jest.fn()
  global.fetch = fetchMock as unknown as typeof fetch
})

describe('buildGithubDeps.lastCommit', () => {
  it('returns the real commit metadata on success', async () => {
    fetchMock.mockResolvedValueOnce(
      res(200, [{ commit: { committer: { date: '2026-05-01T00:00:00Z' }, author: { email: 'a@viscap.co' } } }])
    )

    const deps = buildGithubDeps('tok')
    expect(await deps.lastCommit('a.md')).toEqual({
      iso: '2026-05-01T00:00:00Z',
      email: 'a@viscap.co',
    })
    expect(deps.stats.commitFailures).toBe(0)
  })

  it('retries when GitHub reports a secondary rate limit, then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(res(403, {}, { 'retry-after': '0', 'x-ratelimit-remaining': '0' }))
      .mockResolvedValueOnce(
        res(200, [{ commit: { committer: { date: '2026-05-01T00:00:00Z' }, author: { email: 'a@viscap.co' } } }])
      )

    const deps = buildGithubDeps('tok')
    const out = await deps.lastCommit('a.md')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(out.email).toBe('a@viscap.co')
    expect(deps.stats.commitFailures).toBe(0)
  })

  it('treats 429 as throttling, not as a hard failure', async () => {
    fetchMock
      .mockResolvedValueOnce(res(429, {}, { 'retry-after': '0' }))
      .mockResolvedValueOnce(
        res(200, [{ commit: { committer: { date: '2026-05-01T00:00:00Z' }, author: { email: 'a@viscap.co' } } }])
      )

    const deps = buildGithubDeps('tok')
    expect((await deps.lastCommit('a.md')).email).toBe('a@viscap.co')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a genuine error (403 without rate-limit headers)', async () => {
    fetchMock.mockResolvedValue(res(403, {}))

    const deps = buildGithubDeps('tok')
    await deps.lastCommit('a.md')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to "now" — never the epoch — so an unreadable doc is not reported as stable', async () => {
    fetchMock.mockResolvedValue(res(500, {}))

    const deps = buildGithubDeps('tok')
    const out = await deps.lastCommit('a.md')

    expect(deps.stats.commitFailures).toBe(1)
    expect(out.email).toBe('unknown')
    // The regression: epoch would make isStable() true, fanning out a DM about
    // a doc we could not actually read, routed to the PM fallback.
    expect(out.iso).not.toBe(new Date(0).toISOString())
    expect(isStable(out.iso, new Date())).toBe(false)
  })

  it('counts an empty commit list as a failure and applies the same fallback', async () => {
    fetchMock.mockResolvedValue(res(200, []))

    const deps = buildGithubDeps('tok')
    const out = await deps.lastCommit('a.md')

    expect(deps.stats.commitFailures).toBe(1)
    expect(isStable(out.iso, new Date())).toBe(false)
  })
})

describe('buildGithubDeps.listDocs', () => {
  it('bounds concurrent content reads', async () => {
    const paths = Array.from({ length: 40 }, (_, i) => `doc-${i}.md`)
    let inFlight = 0
    let peak = 0

    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/git/trees/')) return TREE(paths)
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return contentsRes('body')
    })

    const docs = await buildGithubDeps('tok').listDocs()

    expect(docs).toHaveLength(paths.length)
    expect(peak).toBeLessThanOrEqual(8)
  })

  it('drops unreadable docs but counts them instead of failing silently', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/git/trees/')) return TREE(['ok.md', 'bad.md'])
      if (url.includes('bad.md')) return res(500, {})
      return contentsRes('# ok')
    })

    const deps = buildGithubDeps('tok')
    const docs = await deps.listDocs()

    expect(docs.map((d) => d.path)).toEqual(['ok.md'])
    expect(deps.stats.contentFailures).toBe(1)
  })

  it('preserves tree order across the worker pool', async () => {
    const paths = ['c.md', 'a.md', 'b.md']
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/git/trees/')) return TREE(paths)
      // Reverse-ish completion order.
      await new Promise((r) => setTimeout(r, url.includes('c.md') ? 5 : 1))
      return contentsRes('body')
    })

    const docs = await buildGithubDeps('tok').listDocs()
    expect(docs.map((d) => d.path)).toEqual(paths)
  })

  it('still throws when the tree listing itself fails (nothing to snapshot)', async () => {
    fetchMock.mockResolvedValue(res(404, {}))
    await expect(buildGithubDeps('tok').listDocs()).rejects.toThrow('git trees fetch failed')
  })
})

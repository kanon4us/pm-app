import { buildSnapshot, serializeBacklinks, LAST_COMMIT_CONCURRENCY } from '@/lib/vault/snapshot'

describe('buildSnapshot', () => {
  const deps = {
    listDocs: async () => [
      { path: 'A.md', content: 'links to [[B]]', blobSha: 'sha-a' },
      { path: 'B.md', content: 'no links', blobSha: 'sha-b' },
    ],
    lastCommit: async (path: string) => ({
      iso: path === 'A.md' ? '2026-05-01T00:00:00Z' : '2026-04-01T00:00:00Z',
      email: 'author@viscap.co',
    }),
  }

  it('assembles VaultDoc[] with commit metadata and parsed frontmatter', async () => {
    const snap = await buildSnapshot('2026-W25', deps)
    expect(snap.runId).toBe('2026-W25')
    expect(snap.docs).toHaveLength(2)
    const a = snap.docs.find((d) => d.path === 'A.md')!
    expect(a.blobSha).toBe('sha-a')
    expect(a.lastCommitISO).toBe('2026-05-01T00:00:00Z')
    expect(a.lastCommitterEmail).toBe('author@viscap.co')
  })

  it('includes a serialized backlink map that resolves a known link', async () => {
    const snap = await buildSnapshot('2026-W25', deps)
    const bEntry = snap.backlinks.find(([target]) => target === 'B.md')
    expect(bEntry).toBeDefined()
    expect(bEntry![1]).toContain('A.md')
  })

  it('strips NUL characters from doc content (Postgres jsonb rejects them)', async () => {
    const nulDeps = {
      ...deps,
      listDocs: async () => [
        { path: 'C.md', content: 'control range `\u0000–\u0000` pasted', blobSha: 'sha-c' },
      ],
    }
    const snap = await buildSnapshot('2026-W25', nulDeps)
    expect(snap.docs[0].content).toBe('control range `–` pasted')
    expect(snap.docs[0].content.includes('\u0000')).toBe(false)
  })
})

describe('serializeBacklinks', () => {
  it('round-trips a Map to array form', () => {
    const m = new Map([['B.md', new Set(['A.md'])]])
    expect(serializeBacklinks(m)).toEqual([['B.md', ['A.md']]])
  })
})

describe('buildSnapshot commit-lookup fan-out', () => {
  it('bounds concurrent lastCommit calls (unbounded bursts trip GitHub secondary rate limits)', async () => {
    const paths = Array.from({ length: 60 }, (_, i) => `doc-${i}.md`)
    let inFlight = 0
    let peak = 0

    const snap = await buildSnapshot('2026-W25', {
      listDocs: async () => paths.map((path) => ({ path, content: '', blobSha: `sha-${path}` })),
      lastCommit: async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 1))
        inFlight--
        return { iso: '2026-05-01T00:00:00Z', email: 'author@viscap.co' }
      },
    })

    expect(peak).toBeLessThanOrEqual(LAST_COMMIT_CONCURRENCY)
    expect(snap.docs).toHaveLength(paths.length)
  })

  it('pairs each doc with its own commit metadata under the bounded pool', async () => {
    const paths = Array.from({ length: 25 }, (_, i) => `doc-${i}.md`)
    const snap = await buildSnapshot('2026-W25', {
      listDocs: async () => paths.map((path) => ({ path, content: '', blobSha: `sha-${path}` })),
      // Deliberately out-of-order completion: later docs resolve first.
      lastCommit: async (path) => {
        const n = Number(path.match(/\d+/)![0])
        await new Promise((r) => setTimeout(r, (25 - n) % 5))
        return { iso: `2026-05-01T00:00:0${n % 10}Z`, email: `${path}@viscap.co` }
      },
    })

    for (const doc of snap.docs) {
      expect(doc.lastCommitterEmail).toBe(`${doc.path}@viscap.co`)
    }
  })
})

import { buildSnapshot, serializeBacklinks } from '@/lib/vault/snapshot'

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
})

describe('serializeBacklinks', () => {
  it('round-trips a Map to array form', () => {
    const m = new Map([['B.md', new Set(['A.md'])]])
    expect(serializeBacklinks(m)).toEqual([['B.md', ['A.md']]])
  })
})

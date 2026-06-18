import { isStable, changeReport, type VaultCommit } from '@/lib/vault/changes'

describe('isStable', () => {
  const now = new Date('2026-06-16T00:00:00Z')
  it('is true when the last commit is older than the window', () => {
    expect(isStable('2026-06-01T00:00:00Z', now, 7)).toBe(true) // 15 days old
  })
  it('is false when the last commit is within the window', () => {
    expect(isStable('2026-06-14T00:00:00Z', now, 7)).toBe(false) // 2 days old
  })
  it('uses a 7-day default window', () => {
    expect(isStable('2026-06-01T00:00:00Z', now)).toBe(true)
    expect(isStable('2026-06-12T00:00:00Z', now)).toBe(false)
  })
})

describe('changeReport', () => {
  const commits: VaultCommit[] = [
    { path: 'A.md', changeType: 'added' },
    { path: 'B.md', changeType: 'modified' },
    { path: 'C.md', changeType: 'deleted' },
    { path: 'New.md', changeType: 'renamed', oldPath: 'Old.md' },
    { path: 'B.md', changeType: 'modified' }, // duplicate modify -> deduped
  ]
  it('buckets commits by change type and dedupes', () => {
    const r = changeReport(commits)
    expect(r.added).toEqual(['A.md'])
    expect(r.modified).toEqual(['B.md'])
    expect(r.deleted).toEqual(['C.md'])
    expect(r.renamed).toEqual([{ from: 'Old.md', to: 'New.md' }])
  })
})

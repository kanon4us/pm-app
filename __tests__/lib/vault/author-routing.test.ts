// __tests__/lib/vault/author-routing.test.ts
import { resolveAuthor } from '@/lib/vault/author-routing'
import type { VaultDoc } from '@/lib/vault/types'

function makeDoc(overrides: Partial<VaultDoc> = {}): VaultDoc {
  return {
    path: 'docs/example.md',
    content: '# Example',
    lastCommitISO: '2026-05-01T00:00:00Z',
    lastCommitterEmail: 'committer@viscap.com',
    blobSha: 'sha-abc',
    frontmatter: {},
    ...overrides,
  }
}

const SLACK_MAP: Record<string, string> = {
  'owner@viscap.com': 'U_OWNER',
  'committer@viscap.com': 'U_COMMITTER',
}
const PM_FALLBACK = 'U_PM'

describe('resolveAuthor', () => {
  it('uses owner frontmatter as the key when present', () => {
    const doc = makeDoc({ frontmatter: { owner: 'owner@viscap.com' } })
    const route = resolveAuthor(doc, SLACK_MAP, PM_FALLBACK)
    expect(route.key).toBe('owner@viscap.com')
    expect(route.slackId).toBe('U_OWNER')
  })

  it('falls back to lastCommitterEmail as key when owner frontmatter is absent', () => {
    const doc = makeDoc({ frontmatter: {} })
    const route = resolveAuthor(doc, SLACK_MAP, PM_FALLBACK)
    expect(route.key).toBe('committer@viscap.com')
    expect(route.slackId).toBe('U_COMMITTER')
  })

  it('falls back to slackMap[lastCommitterEmail] when key not in map', () => {
    // owner is set but not in map; committer IS in map
    const doc = makeDoc({ frontmatter: { owner: 'unknown@viscap.com' } })
    const route = resolveAuthor(doc, SLACK_MAP, PM_FALLBACK)
    expect(route.key).toBe('unknown@viscap.com')
    // key not in map → try committer
    expect(route.slackId).toBe('U_COMMITTER')
  })

  it('uses PM fallback when neither key nor committer is in the map', () => {
    const doc = makeDoc({
      frontmatter: { owner: 'nobody@external.com' },
      lastCommitterEmail: 'also-nobody@external.com',
    })
    const route = resolveAuthor(doc, SLACK_MAP, PM_FALLBACK)
    expect(route.key).toBe('nobody@external.com')
    expect(route.slackId).toBe(PM_FALLBACK)
  })
})

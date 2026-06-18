import { auditDoc, SUPPORT_CRITICAL_PATHS_DEFAULT } from '@/lib/vault/audit'
import { buildBacklinkMap } from '@/lib/vault/backlinks'
import type { VaultDoc } from '@/lib/vault/types'

const mk = (over: Partial<VaultDoc> & { path: string }): VaultDoc => ({
  content: 'Some real content here.', lastCommitISO: '2026-05-01T00:00:00Z',
  lastCommitterEmail: 'a@b.co', blobSha: 'sha', frontmatter: { status: 'current', source: 'x' }, ...over,
})

describe('auditDoc', () => {
  const files = { 'SOPs/Refunds.md': 'content', 'Dev Docs/x.md': '[[SOPs/Refunds]]' }
  const links = buildBacklinkMap(files)

  it('flags an orphan (no inbound links)', () => {
    const r = auditDoc(mk({ path: '01_Inbox/Loose.md' }), links, SUPPORT_CRITICAL_PATHS_DEFAULT)
    expect(r.signals).toContain('orphan')
  })
  it('flags empty docs', () => {
    const r = auditDoc(mk({ path: 'Dev Docs/Empty.md', content: '   \n' }), links, SUPPORT_CRITICAL_PATHS_DEFAULT)
    expect(r.signals).toContain('empty')
  })
  it('flags missing provenance', () => {
    const r = auditDoc(mk({ path: 'Dev Docs/x.md', frontmatter: {} }), links, SUPPORT_CRITICAL_PATHS_DEFAULT)
    expect(r.signals).toContain('no-provenance')
  })
  it('marks SOPs/ docs support-critical', () => {
    const r = auditDoc(mk({ path: 'SOPs/Refunds.md' }), links, SUPPORT_CRITICAL_PATHS_DEFAULT)
    expect(r.supportCritical).toBe(true)
  })
  it('flags untagged audience only for support-critical docs', () => {
    const r = auditDoc(mk({ path: 'SOPs/Refunds.md', frontmatter: { status: 'current', source: 'x' } }), links, SUPPORT_CRITICAL_PATHS_DEFAULT)
    expect(r.signals).toContain('untagged-audience')
    const r2 = auditDoc(mk({ path: 'Dev Docs/x.md' }), links, SUPPORT_CRITICAL_PATHS_DEFAULT)
    expect(r2.signals).not.toContain('untagged-audience')
  })
})

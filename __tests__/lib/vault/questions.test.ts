import { buildQuestions } from '@/lib/vault/questions'
import type { AuditResult } from '@/lib/vault/types'

const base: AuditResult = { path: 'p.md', signals: [], supportCritical: false, suggestedHome: null, overlapsPath: null }

describe('buildQuestions', () => {
  it('asks an orphan question with archive/keep actions', () => {
    const qs = buildQuestions({ ...base, signals: ['orphan'] })
    const q = qs.find((q) => q.id === 'orphan')!
    expect(q.actions.map((a) => a.id)).toEqual(expect.arrayContaining(['archive', 'keep']))
  })
  it('uses support-framed phrasing for stale support-critical docs', () => {
    const qs = buildQuestions({ ...base, signals: ['stale'], supportCritical: true })
    expect(qs.find((q) => q.id === 'stale')!.text).toMatch(/live support tickets/i)
  })
  it('forces a merge question for support-critical duplicates', () => {
    const qs = buildQuestions({ ...base, signals: ['duplicate'], supportCritical: true, overlapsPath: 'X.md' })
    expect(qs.find((q) => q.id === 'merge')!.actions.some((a) => a.id === 'merge-canonical')).toBe(true)
  })
  it('emits a required audience tag question', () => {
    const qs = buildQuestions({ ...base, signals: ['untagged-audience'] })
    const q = qs.find((q) => q.id === 'tag-audience')!
    expect(q.actions.map((a) => a.id)).toEqual(['tag-support', 'tag-engineering'])
  })
})

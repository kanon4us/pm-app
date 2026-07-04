// __tests__/lib/vault/manifest.test.ts
import {
  buildManifest,
  extractSummary,
  ROOT_DOMAIN,
} from '@/lib/vault/manifest'
import type { RunSnapshot, VaultDoc } from '@/lib/vault/types'

function doc(path: string, content: string, overrides: Partial<VaultDoc> = {}): VaultDoc {
  return {
    path,
    content,
    blobSha: `sha-${path}`,
    lastCommitISO: '2026-06-01T12:00:00Z',
    lastCommitterEmail: 'test@viscap.ai',
    frontmatter: {},
    ...overrides,
  }
}

function snap(docs: VaultDoc[], backlinks: Array<[string, string[]]> = []): RunSnapshot {
  return { runId: '2026-W27', generatedAt: '2026-07-03T00:00:00Z', docs, backlinks }
}

const FM_DOC = `---
title: Sprint Planner
tags: [reference, sprint]
status: current
updated: 2026-05-29
---
Body text here.`

describe('buildManifest — grouping and file entries', () => {
  it('groups by top-level directory and sorts domains and files by path', () => {
    const m = buildManifest(
      snap([
        doc('Dev Docs/Zeta.md', 'z'),
        doc('Dev Docs/Alpha.md', 'a'),
        doc('SOPs/Onboarding.md', 'o'),
      ])
    )
    expect(Object.keys(m.domains)).toEqual(['Dev Docs', 'SOPs'])
    expect(m.domains['Dev Docs'].files.map((f) => f.path)).toEqual([
      'Dev Docs/Alpha.md',
      'Dev Docs/Zeta.md',
    ])
    expect(m.domains['Dev Docs'].file_count).toBe(2)
  })

  it('puts root-level docs under the Global Foundations domain', () => {
    const m = buildManifest(snap([doc('README.md', 'hello')]))
    expect(Object.keys(m.domains)).toEqual([ROOT_DOMAIN])
    expect(ROOT_DOMAIN).toBe('Global Foundations')
  })

  it('excludes dot-directories and scripts/', () => {
    const m = buildManifest(
      snap([
        doc('.obsidian/workspace.md', 'x'),
        doc('.claude/notes.md', 'x'),
        doc('scripts/README.md', 'x'),
        doc('SOPs/Real.md', 'x'),
      ])
    )
    expect(Object.keys(m.domains)).toEqual(['SOPs'])
  })

  it('builds file entries from frontmatter with filename/commit fallbacks', () => {
    const m = buildManifest(
      snap([
        doc('Dev Docs/Sprint Planner.md', FM_DOC, {
          frontmatter: { title: 'Sprint Planner', tags: '[reference, sprint]', status: 'current', updated: '2026-05-29' },
        }),
        doc('Dev Docs/No Frontmatter.md', 'Just prose.'),
      ])
    )
    const [noFm, withFm] = m.domains['Dev Docs'].files
    expect(withFm).toMatchObject({
      path: 'Dev Docs/Sprint Planner.md',
      title: 'Sprint Planner',
      tags: ['reference', 'sprint'],
      status: 'current',
      updated: '2026-05-29',
    })
    expect(noFm).toMatchObject({
      path: 'Dev Docs/No Frontmatter.md',
      title: 'No Frontmatter',
      tags: [],
      status: null,
      updated: '2026-06-01', // lastCommitISO date part
    })
  })

  it('parses block-list tags (Obsidian style) from raw frontmatter', () => {
    const content = `---\ntags:\n  - meta\n  - reference\nstatus: current\n---\nBody.`
    const m = buildManifest(
      snap([doc('00_Meta/Doc Standards.md', content, { frontmatter: { status: 'current' } })])
    )
    expect(m.domains['00_Meta'].files[0].tags).toEqual(['meta', 'reference'])
  })

  it('rolls up top_tags by frequency (alpha tiebreak, max 8) and hub_docs by backlinks (max 5)', () => {
    const tagged = (p: string, tags: string) =>
      doc(p, `---\ntags: [${tags}]\n---\nx`, { frontmatter: { tags: `[${tags}]` } })
    const m = buildManifest(
      snap(
        [
          tagged('SOPs/A.md', 'sop, video'),
          tagged('SOPs/B.md', 'sop, editing'),
          tagged('SOPs/C.md', 'sop'),
        ],
        [
          ['SOPs/B.md', ['SOPs/A.md', 'SOPs/C.md']],
          ['SOPs/A.md', ['SOPs/C.md']],
        ]
      )
    )
    expect(m.domains['SOPs'].top_tags[0]).toBe('sop')
    expect(m.domains['SOPs'].top_tags.slice(1)).toEqual(['editing', 'video'])
    expect(m.domains['SOPs'].hub_docs).toEqual(['SOPs/B.md', 'SOPs/A.md'])
  })

  it('carries version/run metadata from the snapshot', () => {
    const m = buildManifest(snap([doc('SOPs/A.md', 'x')]))
    expect(m.version).toBe(1)
    expect(m.run_id).toBe('2026-W27')
    expect(m.generated_at).toBe('2026-07-03T00:00:00Z')
  })
})

describe('extractSummary', () => {
  it('prefers the [!abstract] callout body', () => {
    const content = `---\nstatus: current\n---\n# Heading\n\n> [!abstract] Abstract\n> This vault is read by coding agents.\n> It defines provenance rules.\n\nFirst paragraph prose.`
    expect(extractSummary(content, { status: 'current' })).toBe(
      'This vault is read by coding agents. It defines provenance rules.'
    )
  })

  it('falls back to frontmatter description, then first paragraph', () => {
    expect(extractSummary('Body prose only.', { description: 'From meta.' })).toBe('From meta.')
    expect(extractSummary('# H1\n\nActual first paragraph.\n\nSecond.', {})).toBe('Actual first paragraph.')
  })

  it('skips code fences and callouts when finding the first paragraph', () => {
    const content = '```bash\nnot prose\n```\n> [!note] skip me\n> callout body\n\nReal prose here.'
    expect(extractSummary(content, {})).toBe('Real prose here.')
  })

  it('flattens wikilinks and caps at 200 chars', () => {
    expect(extractSummary('See [[RAG|Retrieval Augmented Generation]] and [[Sprint Planner]].', {})).toBe(
      'See Retrieval Augmented Generation and Sprint Planner.'
    )
    const long = 'word '.repeat(100)
    const out = extractSummary(long, {})
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out.endsWith('…')).toBe(true)
  })

  it('returns empty string for docs with no prose', () => {
    expect(extractSummary('---\nstatus: stub\n---\n# Only a heading', { status: 'stub' })).toBe('')
  })
})

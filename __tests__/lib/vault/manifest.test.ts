// __tests__/lib/vault/manifest.test.ts
import {
  buildManifest,
  extractSummary,
  serializeManifest,
  manifestContentEquals,
  selectVaultDocs,
  truncateDocSyntaxSafe,
  ROOT_DOMAIN,
  MIN_SCORE,
  MAX_PICKS,
  DOC_CHAR_LIMIT,
} from '@/lib/vault/manifest'
import type { VaultManifest, ManifestFile } from '@/lib/vault/manifest'
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

  it('strips wrapping quotes from block-list tags to match inline parsing', () => {
    const content = `---\ntags:\n  - "reference"\n  - meta\nstatus: current\n---\nBody.`
    const m = buildManifest(
      snap([doc('00_Meta/Quoted.md', content, { frontmatter: { status: 'current' } })])
    )
    expect(m.domains['00_Meta'].files[0].tags).toEqual(['reference', 'meta'])
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

describe('serializeManifest / manifestContentEquals', () => {
  const base = () => snap([doc('SOPs/A.md', 'Alpha prose.')])

  it('is byte-identical across runs on identical content', () => {
    expect(serializeManifest(buildManifest(base()))).toBe(serializeManifest(buildManifest(base())))
  })

  it('ignores generated_at and run_id but catches content changes', () => {
    const a = buildManifest(base())
    const b = buildManifest({ ...base(), runId: '2026-W28', generatedAt: '2026-07-10T00:00:00Z' })
    expect(manifestContentEquals(a, b)).toBe(true)

    const c = buildManifest(snap([doc('SOPs/A.md', 'Changed prose.')]))
    expect(manifestContentEquals(a, c)).toBe(false)
  })

  it('returns false (never throws) on malformed input', () => {
    expect(manifestContentEquals(buildManifest(base()), null)).toBe(false)
    expect(manifestContentEquals(buildManifest(base()), { junk: true })).toBe(false)
  })
})

function mf(path: string, over: Partial<ManifestFile> = {}): ManifestFile {
  return { path, title: basename(path), tags: [], status: 'current', updated: '2026-06-01', summary: '', ...over }
}
function basename(p: string): string {
  return (p.split('/').pop() ?? p).replace(/\.md$/, '')
}
function manifestOf(domains: Record<string, ManifestFile[]>): VaultManifest {
  return {
    version: 1,
    generated_at: '2026-07-03T00:00:00Z',
    run_id: '2026-W27',
    domains: Object.fromEntries(
      Object.entries(domains).map(([name, files]) => [
        name,
        { file_count: files.length, top_tags: [], hub_docs: [], files },
      ])
    ),
  }
}

describe('selectVaultDocs', () => {
  it('scores title/tag hits above path/summary hits', () => {
    const m = manifestOf({
      SOPs: [
        mf('SOPs/Campaign Briefs.md', { title: 'Campaign Briefs' }),          // title hit: 3
        mf('SOPs/Other.md', { summary: 'mentions campaign in passing' }),      // summary hit: 1
      ],
    })
    const { picks } = selectVaultDocs(m, { taskName: 'Campaign dashboard' })
    expect(picks[0].path).toBe('SOPs/Campaign Briefs.md')
  })

  it('drops picks below MIN_SCORE (summary-only grazes do not qualify)', () => {
    const m = manifestOf({
      SOPs: [
        mf('SOPs/A.md', { summary: 'campaign' }),
        mf('SOPs/B.md', { summary: 'campaign' }),
        mf('SOPs/C.md', { summary: 'campaign' }),
      ],
    })
    // Each file scores 1 (summary) + 1 (domain affinity) = 2 < MIN_SCORE
    const { picks } = selectVaultDocs(m, { taskName: 'Campaign dashboard' })
    expect(MIN_SCORE).toBe(3)
    expect(picks).toEqual([])
  })

  it('adds domain-affinity bonus so picks cluster in the top domains', () => {
    const m = manifestOf({
      Strong: [
        mf('Strong/One.md', { title: 'Campaign Setup' }),
        mf('Strong/Two.md', { title: 'Campaign Review' }),
      ],
      Weak: [mf('Weak/Three.md', { title: 'Campaign' })],
      Zero: [mf('Zero/Off.md', { title: 'Unrelated' })],
    })
    const { picks } = selectVaultDocs(m, { taskName: 'campaign setup review' })
    const strongPick = picks.find((p) => p.path === 'Strong/One.md')!
    // title 'Campaign Setup' hits 'campaign'(3) + 'setup'(3) + affinity(1) = 7
    expect(strongPick.score).toBe(7)
    expect(picks.length).toBeGreaterThanOrEqual(3)
  })

  it('caps picks at MAX_PICKS and includes description tokens', () => {
    const files = Array.from({ length: 8 }, (_, i) => mf(`SOPs/Editing ${i}.md`, { title: `Editing ${i}` }))
    const m = manifestOf({ SOPs: files })
    const { picks } = selectVaultDocs(m, { taskName: 'Untitled', description: 'video editing workflow' })
    expect(picks.length).toBe(MAX_PICKS)
  })

  it('returns a domain brief for every domain regardless of picks', () => {
    const m = manifestOf({ SOPs: [mf('SOPs/A.md')], 'Dev Docs': [mf('Dev Docs/B.md')] })
    const { domains } = selectVaultDocs(m, { taskName: 'nothing matches' })
    expect(domains.map((d) => d.name).sort()).toEqual(['Dev Docs', 'SOPs'])
  })
})

describe('truncateDocSyntaxSafe', () => {
  it('returns short content unchanged', () => {
    expect(truncateDocSyntaxSafe('short')).toBe('short')
  })

  it('cuts at the last newline before the limit and appends [truncated]', () => {
    const line = 'x'.repeat(100)
    const content = Array.from({ length: 200 }, () => line).join('\n') // 20,199 chars
    const out = truncateDocSyntaxSafe(content)
    expect(out.length).toBeLessThanOrEqual(DOC_CHAR_LIMIT + 20)
    expect(out.endsWith('\n[truncated]')).toBe(true)
    const kept = out.replace(/\n\[truncated\]$/, '')
    expect(kept.split('\n').every((l) => l === line)).toBe(true) // no mid-line cut
  })

  it('closes an open code fence left dangling by the cut', () => {
    const prefix = 'p\n'.repeat(7400) // 14,800 chars — fence opens just before the limit
    const content = prefix + '```ts\nconst x = 1\n' + 'y\n'.repeat(2000)
    const out = truncateDocSyntaxSafe(content)
    const fenceCount = out.split('\n').filter((l) => l.trimStart().startsWith('```')).length
    expect(fenceCount % 2).toBe(0)
    expect(out.endsWith('\n[truncated]')).toBe(true)
  })
})

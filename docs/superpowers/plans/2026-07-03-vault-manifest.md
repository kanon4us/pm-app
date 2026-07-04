# Vault Manifest (Tier 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile a deterministic `MANIFEST.json` index of the documentation vault as a final step of the weekly consolidation cron, and make the FVI assessment consume it manifest-first with the existing keyword search as fallback.

**Architecture:** A pure compiler module (`lib/vault/manifest.ts`) turns the existing consolidation `RunSnapshot` into a domain-grouped manifest with frontmatter-driven summaries — no LLM calls. The cron writes it to the docs repo `main` when content (ignoring volatile fields) changed. A retrieval module (`lib/vault/manifest-retrieval.ts`, I/O injected) scores manifest entries against the task and fetches whole docs; `assess/init` uses it and falls back to today's search when it returns null.

**Tech Stack:** Next.js App Router route handlers, existing `lib/github/vault.ts` GitHub helpers, Jest (`__tests__/lib/...`, mocks per `__tests__/api/cron/vault-consolidation.test.ts` conventions).

**Spec:** `docs/superpowers/specs/2026-07-03-vault-manifest-design.md`

**File structure:**

| File | Responsibility |
|---|---|
| Create `lib/vault/manifest.ts` | Pure: types, `buildManifest`, `extractSummary`, `serializeManifest`, `manifestContentEquals`, `selectVaultDocs`, `truncateDocSyntaxSafe`, constants |
| Create `lib/vault/manifest-retrieval.ts` | Manifest-first retrieval orchestration with injected `readFile` (returns `null` → caller falls back to search) |
| Modify `app/api/cron/vault-consolidation/route.ts` | Manifest build + conditional write step after `storeSnapshot` |
| Modify `app/api/sprint/tasks/[id]/assess/init/route.ts` | Consume retrieval module; `vaultSource` response field; VAULT MAP prompt section |
| Create `__tests__/lib/vault/manifest.test.ts` | Compiler/selector/truncation unit tests |
| Create `__tests__/lib/vault/manifest-retrieval.test.ts` | Retrieval + fallback-signal unit tests |
| Modify `__tests__/api/cron/vault-consolidation.test.ts` | Manifest-step isolation + skip-write tests |

**Prerequisite (manual, owner Michael):** prod `GITHUB_TOKEN` in Vercel is returning 401 (seen 2026-07-01 in vault-cron). Replace with a token that has read/write on `ViscapMedia/documentation`. Code tasks below don't block on this; the final rollout task does.

---

### Task 1: Manifest types + `buildManifest`

**Files:**
- Create: `lib/vault/manifest.ts`
- Create: `__tests__/lib/vault/manifest.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/lib/vault/manifest.test.ts`:

```ts
// __tests__/lib/vault/manifest.test.ts
import {
  buildManifest,
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest __tests__/lib/vault/manifest.test.ts`
Expected: FAIL — `Cannot find module '@/lib/vault/manifest'`

- [ ] **Step 3: Implement `lib/vault/manifest.ts` (compiler core)**

```ts
// lib/vault/manifest.ts
// Tier-1 vault index: deterministic MANIFEST.json compiled from the weekly
// consolidation snapshot (no LLM calls), plus the pure selection/truncation
// helpers the assessment retrieval path uses.
// Spec: docs/superpowers/specs/2026-07-03-vault-manifest-design.md
import type { RunSnapshot, VaultDoc } from '@/lib/vault/types'

export const MANIFEST_PATH = 'MANIFEST.json'
export const MANIFEST_VERSION = 1
export const ROOT_DOMAIN = 'Global Foundations'
export const MIN_SCORE = 3
export const MAX_PICKS = 5
export const DOC_CHAR_LIMIT = 15_000
export const TOTAL_CHAR_BUDGET = 40_000
const SUMMARY_CHAR_LIMIT = 200
const TOP_TAGS_LIMIT = 8
const HUB_DOCS_LIMIT = 5
const EXCLUDED_TOP_DIRS = new Set(['scripts'])

export interface ManifestFile {
  path: string
  title: string
  tags: string[]
  status: string | null
  updated: string
  summary: string
}

export interface ManifestDomain {
  file_count: number
  top_tags: string[]
  hub_docs: string[]
  files: ManifestFile[]
}

export interface VaultManifest {
  version: number
  generated_at: string
  run_id: string
  domains: Record<string, ManifestDomain>
}

export function buildManifest(snapshot: RunSnapshot): VaultManifest {
  const backlinkCounts = new Map(snapshot.backlinks.map(([target, sources]) => [target, sources.length]))

  const byDomain = new Map<string, VaultDoc[]>()
  for (const d of snapshot.docs) {
    const top = d.path.includes('/') ? d.path.split('/')[0] : null
    if (top && (top.startsWith('.') || EXCLUDED_TOP_DIRS.has(top))) continue
    const domain = top ?? ROOT_DOMAIN
    const list = byDomain.get(domain) ?? []
    list.push(d)
    byDomain.set(domain, list)
  }

  const domains: Record<string, ManifestDomain> = {}
  for (const name of [...byDomain.keys()].sort((a, b) => a.localeCompare(b))) {
    const docs = [...byDomain.get(name)!].sort((a, b) => a.path.localeCompare(b.path))
    const files: ManifestFile[] = docs.map((d) => ({
      path: d.path,
      title: d.frontmatter.title ?? basenameNoExt(d.path),
      tags: parseTags(d),
      status: d.frontmatter.status ?? null,
      updated: d.frontmatter.updated ?? d.lastCommitISO.slice(0, 10),
      summary: extractSummary(d.content, d.frontmatter),
    }))

    const tagCounts = new Map<string, number>()
    for (const f of files) for (const t of f.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
    const top_tags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_TAGS_LIMIT)
      .map(([t]) => t)

    const hub_docs = docs
      .map((d) => ({ path: d.path, n: backlinkCounts.get(d.path) ?? 0 }))
      .filter((h) => h.n > 0)
      .sort((a, b) => b.n - a.n || a.path.localeCompare(b.path))
      .slice(0, HUB_DOCS_LIMIT)
      .map((h) => h.path)

    domains[name] = { file_count: files.length, top_tags, hub_docs, files }
  }

  return {
    version: MANIFEST_VERSION,
    generated_at: snapshot.generatedAt,
    run_id: snapshot.runId,
    domains,
  }
}

function basenameNoExt(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/, '')
}

// readFrontmatter only captures scalar `key: value` lines, so Obsidian
// block-list tags (`tags:\n  - a`) never reach doc.frontmatter — parse both
// forms from the raw content here.
function parseTags(d: VaultDoc): string[] {
  const inline = d.frontmatter.tags
  if (inline) {
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((t) => t.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
  }
  const fm = /^---\n([\s\S]*?)\n---/.exec(d.content)
  if (!fm) return []
  const lines = fm[1].split('\n')
  const start = lines.findIndex((l) => /^tags:\s*$/.test(l))
  if (start === -1) return []
  const tags: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const item = /^\s+-\s+(.+)$/.exec(lines[i])
    if (!item) break
    tags.push(item[1].trim())
  }
  return tags
}

// Summary priority: [!abstract] callout body → frontmatter description/summary
// → first prose paragraph. Deterministic, ≤200 chars, wikilinks flattened.
export function extractSummary(content: string, frontmatter: Record<string, string>): string {
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '')
  const lines = body.split('\n')

  const abstractIdx = lines.findIndex((l) => /^>\s*\[!abstract\]/i.test(l))
  if (abstractIdx !== -1) {
    const parts: string[] = []
    for (let i = abstractIdx + 1; i < lines.length; i++) {
      const m = /^>\s?(.*)$/.exec(lines[i])
      if (!m) break
      parts.push(m[1])
    }
    const text = cleanProse(parts.join(' '))
    if (text) return capSummary(text)
  }

  const meta = frontmatter.description ?? frontmatter.summary
  if (meta) return capSummary(cleanProse(meta))

  const para: string[] = []
  let inFence = false
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (t === '' || t.startsWith('#') || t.startsWith('>') || t.startsWith('![')) {
      if (para.length) break
      continue
    }
    para.push(t)
  }
  return capSummary(cleanProse(para.join(' ')))
}

function cleanProse(s: string): string {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function capSummary(s: string): string {
  return s.length <= SUMMARY_CHAR_LIMIT ? s : s.slice(0, SUMMARY_CHAR_LIMIT - 1).trimEnd() + '…'
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest __tests__/lib/vault/manifest.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/vault/manifest.ts __tests__/lib/vault/manifest.test.ts
git commit -m "feat(vault): deterministic manifest compiler from consolidation snapshot"
```

---

### Task 2: Summary extraction edge cases

**Files:**
- Modify: `__tests__/lib/vault/manifest.test.ts` (append)
- Modify (only if tests fail): `lib/vault/manifest.ts`

- [ ] **Step 1: Append the failing/edge tests**

Append to `__tests__/lib/vault/manifest.test.ts`:

```ts
import { extractSummary } from '@/lib/vault/manifest'

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
```

- [ ] **Step 2: Run tests**

Run: `npx jest __tests__/lib/vault/manifest.test.ts`
Expected: PASS (the Task 1 implementation already covers these; if any fail, fix `extractSummary` — these tests define the contract)

- [ ] **Step 3: Commit**

```bash
git add __tests__/lib/vault/manifest.test.ts lib/vault/manifest.ts
git commit -m "test(vault): manifest summary extraction edge cases"
```

---

### Task 3: `serializeManifest` + volatile-blind `manifestContentEquals`

**Files:**
- Modify: `lib/vault/manifest.ts`
- Modify: `__tests__/lib/vault/manifest.test.ts` (append)

- [ ] **Step 1: Append the failing tests**

```ts
import { serializeManifest, manifestContentEquals, buildManifest as bm } from '@/lib/vault/manifest'

describe('serializeManifest / manifestContentEquals', () => {
  const base = () => snap([doc('SOPs/A.md', 'Alpha prose.')])

  it('is byte-identical across runs on identical content', () => {
    expect(serializeManifest(bm(base()))).toBe(serializeManifest(bm(base())))
  })

  it('ignores generated_at and run_id but catches content changes', () => {
    const a = bm(base())
    const b = bm({ ...base(), runId: '2026-W28', generatedAt: '2026-07-10T00:00:00Z' })
    expect(manifestContentEquals(a, b)).toBe(true)

    const c = bm(snap([doc('SOPs/A.md', 'Changed prose.')]))
    expect(manifestContentEquals(a, c)).toBe(false)
  })

  it('returns false (never throws) on malformed input', () => {
    expect(manifestContentEquals(bm(base()), null)).toBe(false)
    expect(manifestContentEquals(bm(base()), { junk: true })).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest __tests__/lib/vault/manifest.test.ts`
Expected: FAIL — `serializeManifest` is not exported

- [ ] **Step 3: Implement in `lib/vault/manifest.ts`**

Append:

```ts
/** Stable serialization — buildManifest already emits sorted domains/files. */
export function serializeManifest(m: VaultManifest): string {
  return JSON.stringify(m, null, 2) + '\n'
}

/**
 * Equality that ignores volatile fields (generated_at, run_id) so the weekly
 * cron doesn't commit a new MANIFEST.json when no doc actually changed.
 */
export function manifestContentEquals(a: VaultManifest, b: unknown): boolean {
  try {
    const other = b as VaultManifest
    if (!other || typeof other !== 'object' || !other.domains) return false
    const strip = (m: VaultManifest) => serializeManifest({ ...m, generated_at: '', run_id: '' })
    return strip(a) === strip(other)
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest __tests__/lib/vault/manifest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/vault/manifest.ts __tests__/lib/vault/manifest.test.ts
git commit -m "feat(vault): stable manifest serialization + volatile-blind equality"
```

---

### Task 4: `selectVaultDocs` (scoring, confidence floor, domain affinity) + `truncateDocSyntaxSafe`

**Files:**
- Modify: `lib/vault/manifest.ts`
- Modify: `__tests__/lib/vault/manifest.test.ts` (append)

- [ ] **Step 1: Append the failing tests**

```ts
import {
  selectVaultDocs,
  truncateDocSyntaxSafe,
  MIN_SCORE,
  MAX_PICKS,
  DOC_CHAR_LIMIT,
} from '@/lib/vault/manifest'
import type { VaultManifest, ManifestFile } from '@/lib/vault/manifest'

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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest __tests__/lib/vault/manifest.test.ts`
Expected: FAIL — `selectVaultDocs` is not exported

- [ ] **Step 3: Implement in `lib/vault/manifest.ts`**

Append:

```ts
export interface DomainBrief {
  name: string
  file_count: number
  top_tags: string[]
}

export interface VaultPick {
  path: string
  score: number
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'for', 'in', 'on', 'at', 'with', 'and', 'or', 'of', 'is', 'are', 'be', 'as'])

function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    ),
  ].slice(0, 12)
}

/**
 * Deterministic manifest-driven doc selection. Weighted keyword scoring
 * (title 3, tags 3, path 2, summary 1) + a +1 affinity bonus for files in the
 * two highest-scoring domains. Picks below MIN_SCORE are discarded so weak
 * matches trigger the caller's live-search fallback instead.
 */
export function selectVaultDocs(
  manifest: VaultManifest,
  query: { taskName: string; description?: string }
): { domains: DomainBrief[]; picks: VaultPick[] } {
  const tokens = tokenize(`${query.taskName} ${query.description ?? ''}`)

  const scored: Array<{ path: string; domain: string; score: number }> = []
  for (const [domain, d] of Object.entries(manifest.domains)) {
    for (const f of d.files) {
      let score = 0
      const title = f.title.toLowerCase()
      const path = f.path.toLowerCase()
      const summary = f.summary.toLowerCase()
      const tags = f.tags.map((t) => t.toLowerCase())
      for (const tok of tokens) {
        if (title.includes(tok)) score += 3
        if (tags.some((t) => t.includes(tok))) score += 3
        if (path.includes(tok)) score += 2
        if (summary.includes(tok)) score += 1
      }
      if (score > 0) scored.push({ path: f.path, domain, score })
    }
  }

  const domainTotals = new Map<string, number>()
  for (const s of scored) domainTotals.set(s.domain, (domainTotals.get(s.domain) ?? 0) + s.score)
  const topDomains = new Set(
    [...domainTotals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 2)
      .map(([name]) => name)
  )

  const picks = scored
    .map((s) => ({ path: s.path, score: s.score + (topDomains.has(s.domain) ? 1 : 0) }))
    .filter((s) => s.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, MAX_PICKS)

  const domains = Object.entries(manifest.domains).map(([name, d]) => ({
    name,
    file_count: d.file_count,
    top_tags: d.top_tags,
  }))

  return { domains, picks }
}

/**
 * Truncate a doc for prompt inclusion without breaking markdown parsing:
 * cut at the last newline before the limit, close a dangling ``` fence,
 * then mark the truncation.
 */
export function truncateDocSyntaxSafe(content: string, limit: number = DOC_CHAR_LIMIT): string {
  if (content.length <= limit) return content
  let cut = content.slice(0, limit)
  const lastNewline = cut.lastIndexOf('\n')
  if (lastNewline > 0) cut = cut.slice(0, lastNewline)
  const fenceCount = cut.split('\n').filter((l) => l.trimStart().startsWith('```')).length
  if (fenceCount % 2 === 1) cut += '\n```'
  return cut + '\n[truncated]'
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest __tests__/lib/vault/manifest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/vault/manifest.ts __tests__/lib/vault/manifest.test.ts
git commit -m "feat(vault): manifest doc selector with confidence floor + syntax-safe truncation"
```

---

### Task 5: Retrieval module (`lib/vault/manifest-retrieval.ts`)

**Files:**
- Create: `lib/vault/manifest-retrieval.ts`
- Create: `__tests__/lib/vault/manifest-retrieval.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// __tests__/lib/vault/manifest-retrieval.test.ts
import { retrieveVaultContext } from '@/lib/vault/manifest-retrieval'
import { serializeManifest, MANIFEST_PATH } from '@/lib/vault/manifest'
import type { VaultManifest } from '@/lib/vault/manifest'

const MANIFEST: VaultManifest = {
  version: 1,
  generated_at: '2026-07-03T00:00:00Z',
  run_id: '2026-W27',
  domains: {
    SOPs: {
      file_count: 2,
      top_tags: ['sop', 'video'],
      hub_docs: [],
      files: [
        { path: 'SOPs/Campaign Setup.md', title: 'Campaign Setup', tags: ['sop'], status: 'current', updated: '2026-06-01', summary: '' },
        { path: 'SOPs/Campaign Review.md', title: 'Campaign Review', tags: ['sop'], status: 'current', updated: '2026-06-01', summary: '' },
      ],
    },
  },
}

function readFileFor(files: Record<string, string | null>) {
  return jest.fn(async (path: string) => {
    const c = files[path]
    return c == null ? null : { content: c }
  })
}

describe('retrieveVaultContext', () => {
  const query = { taskName: 'Campaign setup review dashboard' }

  it('returns manifest-sourced context with docs and a vault map', async () => {
    const readFile = readFileFor({
      [MANIFEST_PATH]: serializeManifest(MANIFEST),
      'SOPs/Campaign Setup.md': 'Setup doc body.',
      'SOPs/Campaign Review.md': 'Review doc body.',
    })
    const result = await retrieveVaultContext({ readFile }, query)
    expect(result).not.toBeNull()
    expect(result!.filesRead).toEqual(['SOPs/Campaign Review.md', 'SOPs/Campaign Setup.md'])
    expect(result!.vaultContext).toContain('Setup doc body.')
    expect(result!.vaultMapText).toContain('SOPs (2 docs; tags: sop, video)')
  })

  it('returns null when the manifest is missing', async () => {
    const result = await retrieveVaultContext({ readFile: readFileFor({}) }, query)
    expect(result).toBeNull()
  })

  it('returns null on invalid JSON or wrong version', async () => {
    expect(await retrieveVaultContext({ readFile: readFileFor({ [MANIFEST_PATH]: 'not json' }) }, query)).toBeNull()
    const v2 = serializeManifest({ ...MANIFEST, version: 2 })
    expect(await retrieveVaultContext({ readFile: readFileFor({ [MANIFEST_PATH]: v2 }) }, query)).toBeNull()
  })

  it('returns null when fewer than 2 picks qualify (weak matches → live search)', async () => {
    const readFile = readFileFor({ [MANIFEST_PATH]: serializeManifest(MANIFEST) })
    expect(await retrieveVaultContext({ readFile }, { taskName: 'totally unrelated topic' })).toBeNull()
  })

  it('returns null when doc fetches leave fewer than 2 docs', async () => {
    const readFile = readFileFor({
      [MANIFEST_PATH]: serializeManifest(MANIFEST),
      'SOPs/Campaign Setup.md': 'Setup doc body.',
      // Review doc missing → only 1 doc retrievable
    })
    expect(await retrieveVaultContext({ readFile }, query)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest __tests__/lib/vault/manifest-retrieval.test.ts`
Expected: FAIL — `Cannot find module '@/lib/vault/manifest-retrieval'`

- [ ] **Step 3: Implement `lib/vault/manifest-retrieval.ts`**

```ts
// lib/vault/manifest-retrieval.ts
// Manifest-first vault retrieval for the FVI assessment. All I/O is injected
// so the fallback contract (return null → caller runs legacy keyword search)
// is unit-testable without route mocking.
import {
  MANIFEST_PATH,
  MANIFEST_VERSION,
  TOTAL_CHAR_BUDGET,
  selectVaultDocs,
  truncateDocSyntaxSafe,
} from '@/lib/vault/manifest'
import type { VaultManifest } from '@/lib/vault/manifest'

export interface VaultRetrievalDeps {
  readFile(path: string): Promise<{ content: string } | null>
}

export interface VaultRetrievalResult {
  vaultContext: string
  filesRead: string[]
  vaultMapText: string
}

/**
 * Returns null whenever the manifest path can't produce ≥2 documents —
 * missing/invalid manifest, weak matches (confidence floor), or failed
 * fetches. The caller falls back to live keyword search in every null case.
 */
export async function retrieveVaultContext(
  deps: VaultRetrievalDeps,
  query: { taskName: string; description?: string }
): Promise<VaultRetrievalResult | null> {
  const manifestFile = await deps.readFile(MANIFEST_PATH).catch(() => null)
  if (!manifestFile) return null

  let manifest: VaultManifest
  try {
    manifest = JSON.parse(manifestFile.content) as VaultManifest
  } catch {
    return null
  }
  if (manifest?.version !== MANIFEST_VERSION || !manifest.domains) return null

  const { domains, picks } = selectVaultDocs(manifest, query)
  if (picks.length < 2) return null

  const fetched = await Promise.all(
    picks.map((p) => deps.readFile(p.path).catch(() => null))
  )

  let vaultContext = ''
  const filesRead: string[] = []
  let total = 0
  for (let i = 0; i < picks.length; i++) {
    const file = fetched[i]
    if (!file) continue
    const body = truncateDocSyntaxSafe(file.content)
    if (total + body.length > TOTAL_CHAR_BUDGET) break
    total += body.length
    filesRead.push(picks[i].path)
    vaultContext += `\n\n---\nFile: ${picks[i].path}\n${body}`
  }
  if (filesRead.length < 2) return null

  const vaultMapText = domains
    .map((d) => `- ${d.name} (${d.file_count} docs${d.top_tags.length ? `; tags: ${d.top_tags.slice(0, 5).join(', ')}` : ''})`)
    .join('\n')

  return { vaultContext, filesRead, vaultMapText }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest __tests__/lib/vault/manifest-retrieval.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/vault/manifest-retrieval.ts __tests__/lib/vault/manifest-retrieval.test.ts
git commit -m "feat(vault): manifest-first retrieval with null fallback contract"
```

---

### Task 6: Cron integration — write MANIFEST.json after snapshot

**Files:**
- Modify: `app/api/cron/vault-consolidation/route.ts`
- Modify: `__tests__/api/cron/vault-consolidation.test.ts`

- [ ] **Step 1: Add the failing tests**

In `__tests__/api/cron/vault-consolidation.test.ts`, add a module mock for `@/lib/github/vault` next to the existing mocks (factories must use late-bound lambdas — see the file's own hoisting comment):

```ts
let mockReadVaultFile: jest.Mock
let mockWriteVaultFile: jest.Mock
jest.mock('@/lib/github/vault', () => ({
  readVaultFile: (...args: unknown[]) => mockReadVaultFile(...args),
  writeVaultFile: (...args: unknown[]) => mockWriteVaultFile(...args),
}))
```

In the suite's `beforeEach` (where the other mocks are reset), add:

```ts
mockReadVaultFile = jest.fn().mockResolvedValue(null)   // no existing manifest
mockWriteVaultFile = jest.fn().mockResolvedValue({ sha: 'new-sha', url: 'https://example.com' })
```

Then append a new describe block (reuse the file's existing `makeRequest`/fixture helpers — the names below assume the file's existing `MOCK_SNAPSHOT` and authorized-request helper; match what's there):

```ts
describe('manifest step', () => {
  it('writes MANIFEST.json when none exists', async () => {
    const res = await GET(makeAuthorizedRequest())
    expect(res.status).toBe(200)
    expect(mockWriteVaultFile).toHaveBeenCalledTimes(1)
    const [, path, content, message, branch] = mockWriteVaultFile.mock.calls[0]
    expect(path).toBe('MANIFEST.json')
    expect(branch).toBe('main')
    expect(message).toBe('chore: refresh vault manifest')
    expect(JSON.parse(content).version).toBe(1)
  })

  it('skips the write when the existing manifest is content-equal (volatile fields ignored)', async () => {
    // First call captures what the cron would write; feed it back with different volatile fields
    await GET(makeAuthorizedRequest())
    const written = mockWriteVaultFile.mock.calls[0][2] as string
    const existing = JSON.parse(written)
    existing.generated_at = '1999-01-01T00:00:00Z'
    existing.run_id = '1999-W01'
    mockWriteVaultFile.mockClear()
    mockReadVaultFile = jest.fn().mockResolvedValue({ content: JSON.stringify(existing, null, 2) + '\n', sha: 'old' })

    await GET(makeAuthorizedRequest())
    expect(mockWriteVaultFile).not.toHaveBeenCalled()
  })

  it('does not fail the run when the manifest step throws', async () => {
    mockReadVaultFile = jest.fn().mockRejectedValue(new Error('boom'))
    mockWriteVaultFile = jest.fn().mockRejectedValue(new Error('boom'))
    const res = await GET(makeAuthorizedRequest())
    expect(res.status).toBe(200)
  })

  it('does not write during dry runs', async () => {
    const res = await GET(makeAuthorizedRequest('?dryRun=1'))
    expect(res.status).toBe(200)
    expect(mockWriteVaultFile).not.toHaveBeenCalled()
  })
})
```

(If the existing file's request helper takes different arguments, adapt the call sites — the assertions are the contract.)

- [ ] **Step 2: Run to verify failure**

Run: `npx jest __tests__/api/cron/vault-consolidation.test.ts`
Expected: New tests FAIL (`mockWriteVaultFile` never called); all pre-existing tests still PASS (the vault mock defaults are inert).

- [ ] **Step 3: Implement the cron step**

In `app/api/cron/vault-consolidation/route.ts`:

Add imports at the top:

```ts
import { buildManifest, serializeManifest, manifestContentEquals, MANIFEST_PATH } from '@/lib/vault/manifest'
import { readVaultFile, writeVaultFile } from '@/lib/github/vault'
```

Insert immediately after the `await storeSnapshot(supabase, snap)` line (i.e. after step "2. Persist snapshot", before the `vault_review_runs` insert). This is in the live path only — the dry-run branch returns earlier:

```ts
  // 2b. Refresh MANIFEST.json (Tier-1 vault index) — derived from the same
  // snapshot, committed straight to main, never fatal to the run.
  // Spec: docs/superpowers/specs/2026-07-03-vault-manifest-design.md
  try {
    const manifest = buildManifest(snap)
    const existing = await readVaultFile(token, MANIFEST_PATH)
    let unchanged = false
    if (existing) {
      try {
        unchanged = manifestContentEquals(manifest, JSON.parse(existing.content))
      } catch {
        // existing manifest unparseable → overwrite it
      }
    }
    if (!unchanged) {
      const written = await writeVaultFile(token, MANIFEST_PATH, serializeManifest(manifest), 'chore: refresh vault manifest', 'main')
      if (!written) console.error('[vault-cron] manifest write failed (writeVaultFile returned null)')
    }
  } catch (err) {
    console.error('[vault-cron] manifest step failed:', err)
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest __tests__/api/cron/vault-consolidation.test.ts`
Expected: PASS (all pre-existing + 4 new)

- [ ] **Step 5: Commit**

```bash
git add app/api/cron/vault-consolidation/route.ts __tests__/api/cron/vault-consolidation.test.ts
git commit -m "feat(vault): write MANIFEST.json from the consolidation cron (skip when unchanged)"
```

---

### Task 7: Assess consumption — manifest-first with search fallback

**Files:**
- Modify: `app/api/sprint/tasks/[id]/assess/init/route.ts`

- [ ] **Step 1: Rewire the vault-search block**

Add imports at the top of the file:

```ts
import { retrieveVaultContext } from '@/lib/vault/manifest-retrieval'
```

Replace the existing "── Vault search ──" block (the `if (ghAccessToken) { ... }` that currently calls `extractKeywords`/`searchFeatureSpecs`/`searchVault`/`readDevObjectives`) with:

```ts
  // ── Vault retrieval: manifest-first, keyword-search fallback ───────────────
  let vaultSource: 'manifest' | 'search' = 'search'
  let vaultMapText = ''

  if (ghAccessToken) {
    try {
      const [manifestResult, devObjContent] = await Promise.all([
        retrieveVaultContext(
          { readFile: (p) => readVaultFile(ghAccessToken, p) },
          { taskName: task.name, description: clickupDescription }
        ),
        readDevObjectives(ghAccessToken),
      ])
      devObjectivesContent = devObjContent

      if (manifestResult) {
        vaultSource = 'manifest'
        vaultContext = manifestResult.vaultContext
        vaultFilesRead.push(...manifestResult.filesRead)
        vaultMapText = manifestResult.vaultMapText
      } else {
        const keywords = extractKeywords(task.name)
        const [specResults, broadResults] = await Promise.all([
          searchFeatureSpecs(ghAccessToken, keywords),
          searchVault(ghAccessToken, keywords, 3),
        ])
        const allResults = [...specResults, ...broadResults].slice(0, 5)
        for (const r of allResults) {
          if (!vaultFilesRead.includes(r.path)) {
            vaultFilesRead.push(r.path)
            vaultContext += `\n\n---\nFile: ${r.path}\n${r.snippet}`
          }
        }
      }
    } catch { /* non-fatal */ }
  }
```

(`readVaultFile` is already imported on line 5; `vaultFilesRead`/`vaultContext`/`devObjectivesContent` declarations above the block stay as they are.)

- [ ] **Step 2: Add the VAULT MAP section to the user message**

In the `userMessage` template, insert between the `CUSTOM FIELDS` section and `VAULT CONTENT FOUND`:

```ts
VAULT MAP (documentation domains available — cite these when noting evidence gaps):
${vaultMapText || '(No manifest available — retrieval used keyword search)'}
```

- [ ] **Step 3: Expose `vaultSource` in the response**

In the final `NextResponse.json({ ... })`, add after `vaultFilesRead`:

```ts
    vaultSource,
```

- [ ] **Step 4: Typecheck and run the full assess + vault suites**

Run: `npm run typecheck && npx jest --testPathPattern "assess|vault"`
Expected: typecheck clean; all suites PASS (assess suites don't exercise init's vault block; vault suites cover the new modules)

- [ ] **Step 5: Commit**

```bash
git add "app/api/sprint/tasks/[id]/assess/init/route.ts"
git commit -m "feat(assess): manifest-first vault retrieval with search fallback + vaultSource field"
```

---

### Task 8: Full verification + rollout

**Files:** none (verification + ops)

- [ ] **Step 1: Full test suite + typecheck + lint**

Run: `npm run typecheck && npx jest && npm run lint`
Expected: all pass

- [ ] **Step 2: Push (triggers Vercel production deploy)**

```bash
git push origin main
```

Confirm the deployment goes READY (Vercel dashboard or MCP `list_deployments`).

- [ ] **Step 3: GATE — prod `GITHUB_TOKEN` (manual, Michael)**

The token must be replaced in Vercel env before seeding. Verify it works:

```bash
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer <token>" \
  https://api.github.com/repos/ViscapMedia/documentation/git/trees/main
```

Expected: `200` (was `401` on 2026-07-01)

- [ ] **Step 4: Seed the manifest**

Trigger the consolidation cron once with minimal fan-out (limit caps stable-doc processing; the manifest step always runs in live mode):

```bash
curl -s "https://viscap.edgefixautomation.com/api/cron/vault-consolidation?limit=1" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Expected: 200; `MANIFEST.json` appears at the root of `ViscapMedia/documentation@main` with commit message `chore: refresh vault manifest`.

- [ ] **Step 5: Verify assess uses the manifest**

Run an AI Assessment from the Sprint UI (or replay the `assess/init` POST) and check the response JSON contains `"vaultSource": "manifest"` with ≥2 entries in `vaultFilesRead`. If it reports `"search"`, the fallback fired — check Vercel logs and the manifest content before tuning `MIN_SCORE`.

---

## Self-review notes (already applied)

- Spec coverage: compiler (T1–3), hash-skip w/ volatile-blind equality (T3, T6), confidence floor + domain affinity (T4), syntax-safe truncation (T4), Global Foundations root domain (T1), retrieval + fallback contract (T5, T7), `vaultSource` observability (T7), cron failure isolation + dry-run exclusion (T6), rollout gates incl. token prerequisite (T8).
- The cron test's `@/lib/github/vault` mock defaults (`readVaultFile → null`, `writeVaultFile → success`) keep every pre-existing test in that file passing.
- Types used across tasks are all defined in Task 1/4 (`VaultManifest`, `ManifestFile`, `DomainBrief`, `VaultPick`) — signatures in Tasks 5–7 match them.

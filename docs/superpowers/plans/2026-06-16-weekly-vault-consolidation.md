# Weekly Vault Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A weekly PM-app process that reports vault changes and asks each doc's author Slack questions about their stable (>7-day) docs, applying answers as link-safe commits on one weekly branch that opens a single reviewed PR.

**Architecture:** Event-driven, state externalized to git + frontmatter. A Vercel cron builds a cached run snapshot and fans out per-doc work to a queue; the consumer DMs authors Slack Block Kit cards; an interactions webhook acks within 3 s and funnels all git writes through a single-concurrency queue; a close-out cron opens the consolidated PR. No durable-workflow runtime.

**Tech Stack:** Next.js (App Router) on Vercel, `@anthropic-ai/sdk` (Sonnet 4.6, tool-use for structured output), Supabase (ephemeral interaction store), GitHub API via `lib/github/vault.ts`, Slack via `lib/slack/client.ts`, a queue (Upstash QStash or Vercel Queues — decided in Phase 2), jest + ts-jest.

**Spec:** `docs/superpowers/specs/2026-06-16-weekly-vault-consolidation-design.md`

> **Doc-verification rule (this repo's `AGENTS.md`):** before writing code against Next.js, Slack Web API, QStash, or the GitHub git/contents API, read the current docs — APIs here differ from training data. Tasks that touch those APIs say so explicitly and name the doc to read. This is a correctness guardrail, not a placeholder.

---

## File Structure

**Pure / deterministic (fully unit-tested — Phase 1 & parts of 3/4):**
- `lib/vault/types.ts` — shared types: `VaultDoc`, `Audience`, `ReviewStatus`, `AuditResult`, `QuestionSet`, `RunSnapshot`.
- `lib/vault/frontmatter.ts` — surgical frontmatter read + patch (preserves body, key order, trailing newlines).
- `lib/vault/backlinks.ts` — build the global `[[wikilink]]` backlink map from `{path → content}`.
- `lib/vault/audit.ts` — classify one doc (orphan/stale/duplicate/empty/no-provenance) given the snapshot; `support_critical_paths` tiering.
- `lib/vault/questions.ts` — map an `AuditResult` → a `QuestionSet` (deterministic; support-framed phrasing).
- `lib/vault/blockkit.ts` — build Slack Block Kit JSON from raw strings + enforce length limits.
- `lib/vault/closeout-body.ts` — build the author-grouped PR body + the Stale Support Risks block.

**I/O (thin, integration-tested with mocks — Phases 2–4):**
- `lib/vault/snapshot.ts` — build a `RunSnapshot` from the vault (uses `vault.ts`), store/load via KV/Blob.
- `lib/vault/llm.ts` — constrained Anthropic tool-use call returning only raw question strings.
- `lib/vault/git-writes.ts` — commit a file change to the weekly branch; retry on non-fast-forward.
- `lib/vault/author-routing.ts` — resolve a doc's author (owner → last committer → PM); git-email → Slack ID.
- `lib/slack/client.ts` (extend) — DM, open modal, `response_url` update.
- `lib/queue/client.ts` — queue enqueue/consume wrapper (provider chosen in Phase 2).

**Routes:**
- `app/api/cron/vault-consolidation/route.ts` — trigger: snapshot + change report + fan out.
- `app/api/vault/consolidation/process/route.ts` — queue consumer: one doc → card.
- `app/api/bot/slack/interactions/route.ts` — interactions webhook (ack ≤3 s).
- `app/api/vault/consolidation/write/route.ts` — single-concurrency git write consumer.
- `app/api/cron/vault-consolidation-closeout/route.ts` — close-out + PR.

**Migration:**
- `supabase/migrations/027_vault_review_sessions.sql` — ephemeral interaction store.

---

# Phase 1 — Foundational Audit & Frontmatter Plumbing

Pure TypeScript, no I/O. This is the deterministic core; every task is test-first.

## Task 1: Shared types

**Files:**
- Create: `lib/vault/types.ts`

- [ ] **Step 1: Write the types** (no test — type-only module, verified by `tsc` and downstream tasks)

```typescript
// lib/vault/types.ts
export type Audience = 'support' | 'engineering' | 'internal'
export type ReviewStatus = 'stable' | 'reviewed' | 'snoozed' | 'active'

export interface VaultDoc {
  path: string
  content: string
  lastCommitISO: string        // ISO date of the file's most recent commit
  lastCommitterEmail: string
  blobSha: string
  frontmatter: Record<string, string>
}

export type AuditSignal =
  | 'orphan'            // zero inbound backlinks
  | 'duplicate'         // overlaps an existing canonical doc
  | 'stale'             // updated: predates source repo push
  | 'no-provenance'     // missing source:/status:
  | 'empty'             // empty / near-empty body
  | 'untagged-audience' // support-critical doc missing audience:

export interface AuditResult {
  path: string
  signals: AuditSignal[]
  supportCritical: boolean
  suggestedHome: string | null
  overlapsPath: string | null
}

export interface Question {
  id: string                    // stable key, e.g. "orphan", "merge", "tag-audience"
  text: string                  // raw prompt string (LLM- or template-phrased)
  actions: Array<{ id: string; label: string }>  // deterministic button actions
}

export type QuestionSet = Question[]

export interface RunSnapshot {
  runId: string                 // e.g. "2026-W25"
  generatedAt: string           // ISO
  docs: VaultDoc[]
  backlinks: Array<[string, string[]]>  // serialized BacklinkMap (target -> sources)
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add lib/vault/types.ts
git commit -m "feat(vault): shared types for weekly consolidation"
```

## Task 2: Surgical frontmatter editor

The hardest pure piece: patch only the keys we own, preserve everything else byte-for-byte.

**Files:**
- Create: `lib/vault/frontmatter.ts`
- Test: `__tests__/lib/vault/frontmatter.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// __tests__/lib/vault/frontmatter.test.ts
import { readFrontmatter, patchFrontmatter } from '@/lib/vault/frontmatter'

const DOC = `---
title: Example
status: current
tags:
  - a
  - b
---

Body line one.
Body line two.
`

describe('readFrontmatter', () => {
  it('parses top-level scalar keys', () => {
    expect(readFrontmatter(DOC)).toMatchObject({ title: 'Example', status: 'current' })
  })
  it('returns {} when no frontmatter block', () => {
    expect(readFrontmatter('No frontmatter here.\n')).toEqual({})
  })
})

describe('patchFrontmatter', () => {
  it('updates an existing key in place, preserving body byte-for-byte', () => {
    const out = patchFrontmatter(DOC, { status: 'reviewed' })
    expect(out).toContain('status: reviewed')
    expect(out).not.toContain('status: current')
    expect(out.endsWith('Body line one.\nBody line two.\n')).toBe(true)
    expect(out).toContain('tags:\n  - a\n  - b') // untouched nested block preserved
  })
  it('inserts a new key before the closing fence', () => {
    const out = patchFrontmatter(DOC, { review_status: 'stable' })
    const fmEnd = out.indexOf('\n---', 3)
    expect(out.slice(0, fmEnd)).toContain('review_status: stable')
  })
  it('creates a frontmatter block when none exists', () => {
    const out = patchFrontmatter('Body only.\n', { audience: 'support' })
    expect(out.startsWith('---\naudience: support\n---\n')).toBe(true)
    expect(out.endsWith('Body only.\n')).toBe(true)
  })
  it('preserves a trailing-newline-free body exactly', () => {
    const noNl = `---\nstatus: current\n---\nno trailing newline`
    const out = patchFrontmatter(noNl, { status: 'reviewed' })
    expect(out.endsWith('no trailing newline')).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx jest __tests__/lib/vault/frontmatter.test.ts`
Expected: FAIL — `Cannot find module '@/lib/vault/frontmatter'`.

- [ ] **Step 3: Implement the module**

```typescript
// lib/vault/frontmatter.ts
// Surgical frontmatter editing: only the keys we own change; the rest of the YAML
// block, the body, and trailing newlines are preserved exactly. We deliberately do
// NOT use a YAML load/dump round-trip (it reorders keys and strips structure).

const FENCE = '---'

interface Split { head: string; body: string; hasBlock: boolean }

function split(doc: string): Split {
  if (!doc.startsWith(FENCE + '\n') && doc !== FENCE) return { head: '', body: doc, hasBlock: false }
  const end = doc.indexOf('\n' + FENCE, FENCE.length)
  if (end === -1) return { head: '', body: doc, hasBlock: false }
  const head = doc.slice(FENCE.length + 1, end + 1) // between fences, keeps trailing \n
  const afterFence = end + 1 + FENCE.length          // index just past closing ---
  const body = doc.slice(afterFence)
  return { head, body, hasBlock: true }
}

/** Parse only top-level `key: value` scalar lines. Nested/structured keys are ignored for reads. */
export function readFrontmatter(doc: string): Record<string, string> {
  const { head, hasBlock } = split(doc)
  if (!hasBlock) return {}
  const out: Record<string, string> = {}
  for (const line of head.split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line)
    if (m && m[2] !== '') out[m[1]] = m[2].trim()
  }
  return out
}

/** Patch the given top-level keys, preserving everything else exactly. */
export function patchFrontmatter(doc: string, patch: Record<string, string>): string {
  const { head, body, hasBlock } = split(doc)

  if (!hasBlock) {
    const block = Object.entries(patch).map(([k, v]) => `${k}: ${v}`).join('\n')
    return `${FENCE}\n${block}\n${FENCE}\n${doc}`
  }

  const lines = head.split('\n')
  const remaining = { ...patch }
  const patched = lines.map((line) => {
    const m = /^([A-Za-z0-9_-]+):/.exec(line)
    if (m && m[1] in remaining) {
      const k = m[1]
      const v = remaining[k]
      delete remaining[k]
      return `${k}: ${v}`
    }
    return line
  })

  // `head` ends with a trailing "\n" (the line before the closing fence). Insert any
  // not-yet-present keys just before that final empty element.
  const inserts = Object.entries(remaining).map(([k, v]) => `${k}: ${v}`)
  if (inserts.length) {
    // patched has a trailing '' element from the final '\n'; splice inserts before it
    patched.splice(patched.length - 1, 0, ...inserts)
  }

  return `${FENCE}\n${patched.join('\n')}${FENCE}${body}`
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx jest __tests__/lib/vault/frontmatter.test.ts`
Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add lib/vault/frontmatter.ts __tests__/lib/vault/frontmatter.test.ts
git commit -m "feat(vault): surgical frontmatter editor with byte-preserving body"
```

## Task 3: Global backlink map

**Files:**
- Create: `lib/vault/backlinks.ts`
- Test: `__tests__/lib/vault/backlinks.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// __tests__/lib/vault/backlinks.test.ts
import { buildBacklinkMap, inboundCount } from '@/lib/vault/backlinks'

const FILES = {
  '02_Glossary/Element.md': 'An [[Project|project]] has Elements.',
  'Manual/Making a Creative.md': 'See [[02_Glossary/Element]] and [[Project]].',
  '01_Inbox/Orphan.md': 'Nothing links to me.',
  '02_Glossary/Project.md': 'A project.',
}

describe('buildBacklinkMap', () => {
  const map = buildBacklinkMap(FILES)
  it('resolves a full-path wikilink to its target', () => {
    expect(inboundCount(map, '02_Glossary/Element.md')).toBe(1)
  })
  it('resolves a bare-name wikilink by basename', () => {
    expect(inboundCount(map, '02_Glossary/Project.md')).toBe(2) // Element.md + Manual
  })
  it('reports zero for an orphan', () => {
    expect(inboundCount(map, '01_Inbox/Orphan.md')).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx jest __tests__/lib/vault/backlinks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// lib/vault/backlinks.ts
// Build a map: target doc path -> set of source paths that wikilink to it.
// Obsidian links are [[Target]] or [[Target|alias]]; Target may be a full path
// ("02_Glossary/Element") or a bare basename ("Project"). We resolve bare names
// by basename across the vault.

export type BacklinkMap = Map<string, Set<string>>

const LINK_RE = /\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g

function basename(path: string): string {
  const file = path.split('/').pop() ?? path
  return file.replace(/\.md$/, '')
}

export function buildBacklinkMap(files: Record<string, string>): BacklinkMap {
  const byBasename = new Map<string, string>() // basename -> full path
  for (const path of Object.keys(files)) byBasename.set(basename(path), path)

  const map: BacklinkMap = new Map()
  const add = (target: string, source: string) => {
    if (!map.has(target)) map.set(target, new Set())
    map.get(target)!.add(source)
  }

  for (const [source, content] of Object.entries(files)) {
    for (const m of content.matchAll(LINK_RE)) {
      const raw = m[1].trim()
      const full = raw.endsWith('.md') ? raw : `${raw}.md`
      if (files[full]) { add(full, source); continue }
      const resolved = byBasename.get(raw)
      if (resolved) add(resolved, source)
    }
  }
  return map
}

export function inboundCount(map: BacklinkMap, path: string): number {
  return map.get(path)?.size ?? 0
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx jest __tests__/lib/vault/backlinks.test.ts`
Expected: PASS (3).

- [ ] **Step 5: Commit**

```bash
git add lib/vault/backlinks.ts __tests__/lib/vault/backlinks.test.ts
git commit -m "feat(vault): global wikilink backlink map"
```

## Task 4: Audit classifier (with support-critical tier)

**Files:**
- Create: `lib/vault/audit.ts`
- Test: `__tests__/lib/vault/audit.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// __tests__/lib/vault/audit.test.ts
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
```

- [ ] **Step 2: Run, verify fail.** `npx jest __tests__/lib/vault/audit.test.ts` → module not found.

- [ ] **Step 3: Implement**

```typescript
// lib/vault/audit.ts
import type { VaultDoc, AuditResult, AuditSignal } from './types'
import { inboundCount, type BacklinkMap } from './backlinks'

export const SUPPORT_CRITICAL_PATHS_DEFAULT = ['SOPs/', 'Manual/', 'Feature Overview/']
// Audience tagging is required only for the most directly support-facing paths.
const AUDIENCE_REQUIRED_PATHS = ['SOPs/', 'Manual/']

const EMPTY_THRESHOLD = 20 // chars of non-whitespace body

function bodyOf(doc: VaultDoc): string {
  // strip a leading frontmatter block for the empty check
  if (doc.content.startsWith('---\n')) {
    const end = doc.content.indexOf('\n---', 3)
    if (end !== -1) return doc.content.slice(end + 4)
  }
  return doc.content
}

export function auditDoc(doc: VaultDoc, backlinks: BacklinkMap, supportPaths: string[]): AuditResult {
  const signals: AuditSignal[] = []
  const supportCritical = supportPaths.some((p) => doc.path.startsWith(p))

  if (inboundCount(backlinks, doc.path) === 0) signals.push('orphan')
  if (bodyOf(doc).replace(/\s/g, '').length < EMPTY_THRESHOLD) signals.push('empty')
  if (!doc.frontmatter.source || !doc.frontmatter.status) signals.push('no-provenance')

  const audienceRequired = AUDIENCE_REQUIRED_PATHS.some((p) => doc.path.startsWith(p))
  if (audienceRequired && !doc.frontmatter.audience) signals.push('untagged-audience')

  // 'stale' and 'duplicate' need the snapshot's source-repo timestamps and overlap
  // analysis respectively; they are attached by the snapshot/consumer layer (Phase 2)
  // which has that context. auditDoc covers the per-doc, snapshot-local signals.

  return { path: doc.path, signals, supportCritical, suggestedHome: null, overlapsPath: null }
}
```

- [ ] **Step 4: Run, verify pass.** `npx jest __tests__/lib/vault/audit.test.ts` → PASS (6).

- [ ] **Step 5: Commit**

```bash
git add lib/vault/audit.ts __tests__/lib/vault/audit.test.ts
git commit -m "feat(vault): audit classifier with support-critical tiering"
```

## Task 5: Question builder (deterministic, support-framed)

**Files:**
- Create: `lib/vault/questions.ts`
- Test: `__tests__/lib/vault/questions.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// __tests__/lib/vault/questions.test.ts
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
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**

```typescript
// lib/vault/questions.ts
import type { AuditResult, Question, QuestionSet } from './types'

export function buildQuestions(a: AuditResult): QuestionSet {
  const qs: QuestionSet = []

  if (a.signals.includes('orphan')) qs.push({
    id: 'orphan',
    text: 'Nothing links here. Still needed? If so, what should point to it?',
    actions: [{ id: 'keep', label: 'Keep' }, { id: 'archive', label: 'Archive' }, { id: 'reply', label: 'Reply' }],
  })

  if (a.signals.includes('duplicate')) {
    const supportForced = a.supportCritical
    qs.push({
      id: 'merge',
      text: supportForced
        ? `Claude answers live tickets from this path. It overlaps ${a.overlapsPath}. Merge into the canonical doc.`
        : `Looks like it covers the same ground as ${a.overlapsPath}. Merge, or distinct?`,
      actions: supportForced
        ? [{ id: 'merge-canonical', label: 'Merge into canonical' }, { id: 'reply', label: 'Reply' }]
        : [{ id: 'merge-canonical', label: 'Merge into canonical' }, { id: 'distinct', label: 'Keep — distinct' }],
    })
  }

  if (a.signals.includes('stale')) qs.push({
    id: 'stale',
    text: a.supportCritical
      ? 'Claude uses this document to answer live support tickets. Is this protocol still accurate?'
      : 'Source has moved since last review — reconcile, or mark legacy?',
    actions: [{ id: 'accurate', label: 'Still accurate' }, { id: 'mark-legacy', label: 'Mark legacy' }, { id: 'reply', label: 'Reply' }],
  })

  if (a.signals.includes('no-provenance')) qs.push({
    id: 'provenance',
    text: 'What repo/code does this describe (for source:)? Or is it conceptual?',
    actions: [{ id: 'conceptual', label: 'Conceptual' }, { id: 'reply', label: 'Reply with source' }],
  })

  if (a.signals.includes('empty')) qs.push({
    id: 'empty',
    text: 'This is effectively empty. Delete, or a placeholder you will fill?',
    actions: [{ id: 'delete', label: 'Delete' }, { id: 'keep', label: 'Keep (placeholder)' }],
  })

  if (a.signals.includes('untagged-audience')) qs.push({
    id: 'tag-audience',
    text: 'Who is this document for? (sets the retrieval boundary)',
    actions: [{ id: 'tag-support', label: 'Tag as Support' }, { id: 'tag-engineering', label: 'Tag as Engineering' }],
  })

  return qs
}
```

- [ ] **Step 4: Run, verify pass.** PASS (4).

- [ ] **Step 5: Commit**

```bash
git add lib/vault/questions.ts __tests__/lib/vault/questions.test.ts
git commit -m "feat(vault): deterministic question builder with support phrasing"
```

**Phase 1 checkpoint:** `npx jest __tests__/lib/vault && npx tsc --noEmit` → all green. The deterministic core is complete and fully tested.

---

# Phase 2 — Ingestion: Cron, Snapshot & Queue

I/O-heavy. Integration-tested with the GitHub/Supabase clients mocked.

> **Decision to make first (Task 6):** queue provider. Default recommendation: **Upstash QStash** — proven, simple HTTP publish/consume, per-endpoint retry config, and a dedicated `parallelism` control we need for the serialized write path (Phase 4). Read https://upstash.com/docs/qstash before coding. (Vercel Queues is the alternative; same shape, beta.)

## Task 6: Migration + ephemeral interaction store

**Files:**
- Create: `supabase/migrations/027_vault_review_sessions.sql`
- Modify: `lib/supabase/types.ts` (add the `vault_review_sessions` table type)

- [ ] **Step 1: Write the migration**

```sql
-- 027_vault_review_sessions.sql
-- Ephemeral interaction routing for weekly vault consolidation. Durable document
-- state lives in vault frontmatter; this table is disposable plumbing, cleared per cycle.
create table if not exists vault_review_sessions (
  id uuid primary key default gen_random_uuid(),
  run_id text not null,                 -- weekly run identifier (e.g. 2026-W25)
  doc_path text not null,
  author_email text not null,
  author_slack_id text,
  branch text not null,                 -- vault-consolidation/<isoweek>
  base_blob_sha text not null,          -- optimistic-lock baseline
  question_id text not null,
  status text not null default 'open',  -- open | answered | aborted
  slack_channel text,
  slack_message_ts text,
  created_at timestamptz not null default now()
);
create index if not exists idx_vault_review_sessions_run on vault_review_sessions(run_id);
create index if not exists idx_vault_review_sessions_author on vault_review_sessions(run_id, author_email);

create table if not exists vault_review_runs (
  run_id text primary key,              -- 2026-W25
  started_at timestamptz not null default now(),
  snapshot_ref text,                    -- KV/Blob key for the run snapshot
  pr_url text,                          -- set when the consolidated PR opens
  author_done jsonb not null default '{}'::jsonb  -- { "<email>": true }
);
```

- [ ] **Step 2: Add the types** to `lib/supabase/types.ts` `Database['public']['Tables']` (match the migration columns; follow the existing inline `Row/Insert/Update` style in that file).

- [ ] **Step 3: Verify** `npx tsc --noEmit` → exit 0.

- [ ] **Step 4: Commit** `git commit -m "feat(vault): vault_review_sessions + runs tables"`

> **Deploy note (project rule `[[project_migration_deploy_ordering]]`):** migration 027 must be applied to prod **before** the code that queries it ships. Add "apply 027" to the deploy checklist.

## Task 7: Snapshot builder

**Files:**
- Create: `lib/vault/snapshot.ts`
- Test: `__tests__/lib/vault/snapshot.test.ts` (GitHub calls mocked)

Builds a `RunSnapshot { runId, generatedAt, docs: VaultDoc[], backlinks }` from the vault and stores it (KV/Blob) keyed by `runId`. Reads `lib/github/vault.ts` (`listVaultDirectory` recursively, `readVaultFile`) and the GitHub commits API for per-file last-commit date/author/blobSha.

- [ ] **Step 1: Write the failing test** — given a mocked vault client returning two files + commit metadata, `buildSnapshot()` returns a `RunSnapshot` whose `backlinks` resolves a known link and whose `docs[].lastCommitISO` matches the mock. Assert `loadSnapshot(runId)` round-trips what `storeSnapshot` saved (mock the KV/Blob put/get).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `buildSnapshot(token)`, `storeSnapshot(runId, snap)`, `loadSnapshot(runId)`. Use `buildBacklinkMap` (Task 3) over `{path → content}`. Per-file commit metadata via GitHub `GET /repos/{repo}/commits?path=<file>&per_page=1` (read https://docs.github.com/rest/commits/commits first). Serialize the `BacklinkMap` (Map→array) for storage.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `git commit -m "feat(vault): run snapshot builder + store"`

## Task 8: Stability + change detection

**Files:**
- Create: `lib/vault/changes.ts`
- Test: `__tests__/lib/vault/changes.test.ts`

Pure functions over snapshot + git data: `isStable(doc, now, days=7)` (last commit > 7 days old), and `changeReport(commitsSinceLastRun)` → `{ added, modified, renamed, deleted }`.

- [ ] **Step 1: Failing tests** — `isStable` true for a 10-day-old commit, false for a 2-day-old; `changeReport` buckets a fixture commit list correctly.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** (pure; date math + grouping).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `git commit -m "feat(vault): git-based stability gate + change report"`

## Task 9: Queue client wrapper

**Files:**
- Create: `lib/queue/client.ts`
- Test: `__tests__/lib/queue/client.test.ts` (HTTP mocked)

Thin wrapper: `enqueue(endpoint, payload, opts?)` and a signature-verification helper for inbound queue webhooks. Two logical queues: `process` (parallel) and `writes` (parallelism = 1).

- [ ] **Step 1: Failing test** — `enqueue` POSTs to the configured QStash publish URL with the payload and retry header; `verifySignature` rejects a bad signature. (Read https://upstash.com/docs/qstash/features/signing before coding.)
- [ ] **Step 2–4:** implement + pass.
- [ ] **Step 5: Commit** `git commit -m "feat(queue): QStash enqueue + signature verification"`

## Task 10: Trigger cron — snapshot, change report, fan out

**Files:**
- Create: `app/api/cron/vault-consolidation/route.ts`
- Modify: `vercel.json` (add weekly cron)
- Test: `__tests__/api/cron/vault-consolidation.test.ts`

- [ ] **Step 1: Failing test** — calling the route handler (snapshot/queue/slack mocked) (a) stores a snapshot, (b) posts a change report to Slack, (c) enqueues one `process` message per stable doc with `{ runId, docPath }` only, (d) creates a `vault_review_runs` row. Verify the payload contains no backlink map.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the handler: `maxDuration = 60`; guard with the cron secret (follow `app/api/cron/sop-analysis/route.ts`); build+store snapshot; compute stable docs (Task 8); enqueue per doc; post change report via `lib/slack/client`. Add to `vercel.json` crons: `{ "path": "/api/cron/vault-consolidation", "schedule": "0 9 * * 1" }`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `git commit -m "feat(vault): weekly trigger cron with snapshot + fan-out"`

## Task 11: Process consumer — audit + author routing → enqueue card

**Files:**
- Create: `app/api/vault/consolidation/process/route.ts`
- Create: `lib/vault/author-routing.ts`
- Test: `__tests__/api/vault/process.test.ts`, `__tests__/lib/vault/author-routing.test.ts`

- [ ] **Step 1: Failing tests** — `resolveAuthor(doc, slackMap, pmFallback)` returns owner-frontmatter > last committer > PM (unit, pure-ish). The process route: loads snapshot, runs `auditDoc`+`buildQuestions`, resolves author, and (Slack mocked) sends a card carrying the doc's `blobSha`, and writes a `vault_review_sessions` row.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Verify the QStash signature (Task 9). Apply the per-author DM cap (5) — overflow path sets a flag for the digest (Phase 3, Task 14).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `git commit -m "feat(vault): process consumer + author routing"`

**Phase 2 checkpoint:** trigger → snapshot → fan-out → per-doc session rows, all under mocks. `npx jest && npx tsc --noEmit` green.

---

# Phase 3 — Slack Block Kit & Modal Loop

## Task 12: Constrained LLM phrasing (tool-use)

**Files:**
- Create: `lib/vault/llm.ts`
- Test: `__tests__/lib/vault/llm.test.ts` (Anthropic mocked)

The LLM returns **only raw strings** via a strict tool `input_schema`; it never emits Block Kit. Read the `claude-api` skill / Anthropic tool-use docs before coding (model `claude-sonnet-4-6`).

- [ ] **Step 1: Failing test** — `phraseQuestion(context)` calls `messages.create` with a `tools` entry whose `input_schema` requires `{ text: string, actions: {id,label}[] }`, and returns the parsed tool input. On a malformed tool result it falls back to the deterministic template text (from Task 5).
- [ ] **Step 2–4:** implement + pass (mock the Anthropic client returning a `tool_use` block).
- [ ] **Step 5: Commit** `git commit -m "feat(vault): constrained LLM question phrasing via tool-use"`

## Task 13: Block Kit builder (deterministic + length-safe)

**Files:**
- Create: `lib/vault/blockkit.ts`
- Test: `__tests__/lib/vault/blockkit.test.ts`

Pure: raw strings → valid Block Kit JSON, enforcing Slack limits. Read https://api.slack.com/reference/block-kit/blocks for current limits before finalizing.

- [ ] **Step 1: Failing tests** — `buildCard({title, body, actions, blockId})` truncates section text to ≤3000 chars (with ellipsis), truncates button labels to ≤75, and emits one `actions` block whose `block_id` round-trips. Assert a >3000-char body is truncated and a >75-char label is truncated.
- [ ] **Step 2–4:** implement + pass.
- [ ] **Step 5: Commit** `git commit -m "feat(vault): length-safe Block Kit builder"`

## Task 14: Slack client extensions + digest card

**Files:**
- Modify: `lib/slack/client.ts` (add `dm(userId, blocks)`, `openModal(triggerId, view)`, `updateViaResponseUrl(url, blocks)`)
- Create: `lib/vault/digest.ts` (build the overflow digest card — pure)
- Test: `__tests__/lib/vault/digest.test.ts`

- [ ] **Step 1: Failing test** — `buildDigestCard(docs)` renders ≤N lines, each with one button (`block_id` encodes the doc) that opens a modal. (Slack client methods integration-tested with fetch mocked; read https://api.slack.com/methods/chat.postMessage and `views.open`.)
- [ ] **Step 2–4:** implement + pass.
- [ ] **Step 5: Commit** `git commit -m "feat(vault): slack DM/modal helpers + overflow digest card"`

## Task 15: Interactions webhook (3 s ack) + merge modal

**Files:**
- Create or Modify: `app/api/bot/slack/interactions/route.ts`
- Test: `__tests__/api/bot/slack-interactions.test.ts`

- [ ] **Step 1: Failing tests** — the handler (a) returns `200` synchronously in <3 s without awaiting any GitHub call (assert no git-write client call on the request path), (b) enqueues a `writes` job carrying `{ sessionId, actionId }`, (c) for a `merge`/`distinct` action opens the merge modal via `views.open`. Verify Slack request signature first (read https://api.slack.com/authentication/verifying-requests-from-slack).
- [ ] **Step 2–4:** implement + pass. The handler resolves the `vault_review_sessions` row by `block_id`, enqueues the mutation, and returns immediately; the actual commit happens in Task 16.
- [ ] **Step 5: Commit** `git commit -m "feat(vault): slack interactions webhook with 3s ack + merge modal"`

**Phase 3 checkpoint:** a simulated button click enqueues a write and never blocks on GitHub. Green tests + tsc.

---

# Phase 4 — Shared Git Lineage & Close-Out

## Task 16: Serialized git write consumer (optimistic lock + 422 retry)

**Files:**
- Create: `app/api/vault/consolidation/write/route.ts`
- Create: `lib/vault/git-writes.ts`
- Test: `__tests__/lib/vault/git-writes.test.ts`

This endpoint is the **only** writer to the weekly branch, consumed from the parallelism=1 `writes` queue.

- [ ] **Step 1: Failing tests** — `applyAction(session, action, deps)`:
  - ensures the weekly branch exists (creates from `main` if missing, via `createVaultBranch`);
  - re-reads the file's current blob SHA in the branch; if it ≠ `session.base_blob_sha`, **aborts** (no commit) and returns `{ aborted: true }` (optimistic lock);
  - applies the action's frontmatter patch (Task 2) and/or file move/delete (rewriting inbound `[[links]]` from the snapshot for a move) and commits via `writeVaultFile`;
  - on a non-fast-forward `422` from the commit, retries against the new head with exponential backoff (assert it retries then succeeds with a mock that 422s once).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Read https://docs.github.com/rest/repos/contents and the existing `lib/github/vault.ts` helpers. Mark the session `answered`/`aborted`; update `author_done` when the author signals done. Update the Slack card via `response_url`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `git commit -m "feat(vault): serialized git write with optimistic lock + 422 retry"`

## Task 17: Close-out PR body builder (pure)

**Files:**
- Create: `lib/vault/closeout-body.ts`
- Test: `__tests__/lib/vault/closeout-body.test.ts`

- [ ] **Step 1: Failing tests** — `buildPrBody(sessions)` groups answered changes **by author** under headings, and renders a `## ⚠ Stale Support Risks` block **at the very top** listing unanswered `audience: support` docs. Assert the support block precedes the per-author sections and is omitted when there are no support risks.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** (pure string building).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `git commit -m "feat(vault): close-out PR body with stale-support block"`

## Task 18: Close-out cron — open PR + PM alert

**Files:**
- Create: `app/api/cron/vault-consolidation-closeout/route.ts`
- Modify: `vercel.json` (second weekly cron, ~2 days later)
- Test: `__tests__/api/cron/closeout.test.ts`

- [ ] **Step 1: Failing tests** — the handler opens **one** PR (GitHub mocked) when all authors are done OR the deadline passed; it is **idempotent** (no second PR if `vault_review_runs.pr_url` is set); when stale `audience: support` docs exist it pings the PM via Slack with the list.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Read https://docs.github.com/rest/pulls/pulls (create PR). Schedule in `vercel.json`: `{ "path": "/api/cron/vault-consolidation-closeout", "schedule": "0 9 * * 3" }`. Guard with cron secret.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `git commit -m "feat(vault): close-out cron opens consolidated PR + PM alert"`

**Phase 4 checkpoint:** end-to-end under mocks — trigger → cards → serialized writes → one PR with a Stale Support Risks block. `npx jest && npx tsc --noEmit && npx eslint <changed>` green.

---

## Final verification (before requesting review)

- [ ] `npx jest` — full suite green (new `__tests__/lib/vault/**`, `__tests__/api/**`).
- [ ] `npx tsc --noEmit` — exit 0.
- [ ] `npx eslint <changed files>` — 0 errors.
- [ ] Confirm migration `027` is in the prod-deploy checklist (deploy-ordering rule).
- [ ] Confirm env vars present: `QSTASH_TOKEN`/signing keys, Slack signing secret + bot token, cron secret, vault GitHub token.

## Out of scope (do not build here)
- Approve→branch/cascade/ClickUp wiring (Piece 2).
- Any agent *consuming* `audience` to restrict retrieval (Piece 3).
- The optional PM-app web triage view.

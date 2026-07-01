# ClickUp → Design-Index Webhook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a ClickUp ticket enters an "in progress" status, auto-scaffold/promote its design-index entry with the real `clickupId` via a DB inbox + a batched rolling GitHub PR.

**Architecture:** A thin webhook extension upserts a `design_index_inbox` row. A Vercel cron reads the inbox, resolves code-path existence against GitHub, runs a pure `applyInboxToIndex` transform, and force-updates one rolling `design-index-sync` branch / PR with auto-merge. Git stays the source of truth; the pure core is fully fixture-tested.

**Tech Stack:** TypeScript, Next.js route handlers, Jest (ts-jest node project), Supabase (service client), GitHub REST + GraphQL, Vercel cron. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-06-30-clickup-design-index-webhook-design.md`.

**Conventions (verified):** pure libs use relative imports (ts-node compat); tests use `@/`; `npm run typecheck`; single test `npx jest <path>`. `parseFigmaUrl` in `lib/figma/client.ts`. Figma custom field id = `figma_link` (`lib/field-config.ts`). GitHub path check: `pathExists` in `lib/github/repos.ts`. Repo = `kanon4us/pm-app`.

---

## File Structure

- `lib/design-migration/types.ts` — MODIFY: enrich `PendingEntry` (+`assignedClickupId`,`title`,`figmaNodeId`), `PendingReason` (+`unassigned-figma`).
- `lib/design-migration/seed.ts` — MODIFY: store `id/app/section/feature` in pending `partial` so entries are promotable.
- `lib/design-index/inbox.ts` — CREATE: pure `applyInboxToIndex` + `InboxRow`/`PendingFile` types.
- `lib/design-index/inbox-trigger.ts` — CREATE: pure `parseDesignIndexStatuses`, `isDesignIndexStatus`, `extractFigmaUrl`.
- `lib/github/design-index-pr.ts` — CREATE: read index files, force-update rolling branch, ensure PR + auto-merge.
- `app/api/webhooks/clickup/route.ts` — MODIFY: in `taskStatusUpdated`, write inbox row on a matching status.
- `app/api/cron/design-index-sync/route.ts` — CREATE: orchestrator.
- `supabase/migrations/030_design_index_inbox.sql` — CREATE.
- `vercel.json` — MODIFY: add the cron entry.
- `__tests__/lib/design-index/inbox.test.ts`, `__tests__/lib/design-index/inbox-trigger.test.ts` — CREATE.

---

## Task 1: Enrich pending types + make entries promotable

**Files:**
- Modify: `lib/design-migration/types.ts`
- Modify: `lib/design-migration/seed.ts`

- [ ] **Step 1: Extend the types**

In `lib/design-migration/types.ts`, replace the `PendingReason` and `PendingEntry` declarations:

```ts
export type PendingReason =
  | 'placeholder-clickup'
  | 'unassigned-codepaths'
  | 'unassigned-feature'
  | 'unassigned-figma'

export interface PendingEntry {
  featureId: string
  reason: PendingReason[]
  partial: Partial<Feature>
  /** Real ClickUp id once a ticket has been assigned (G1). */
  assignedClickupId?: string
  /** Ticket title, becomes the user-story title on promotion. */
  title?: string
  /** Deep Figma node id, anchors the user story on promotion. */
  figmaNodeId?: string
}
```

- [ ] **Step 2: Store promotable fields in the seed's pending entries**

In `lib/design-migration/seed.ts`, in `manifestToIndexEntries`, replace the `pending.push({...})` block with one that carries `id/app/section/feature`:

```ts
      pending.push({
        featureId:
          f.app && f.targetSection && f.targetFeature
            ? featureIdFor(f.app, f.targetSection, f.targetFeature)
            : `unassigned-${f.sourceFileKey}`,
        reason: reasons.length > 0 ? reasons : ['unassigned-feature'],
        partial: {
          id:
            f.app && f.targetSection && f.targetFeature
              ? featureIdFor(f.app, f.targetSection, f.targetFeature)
              : undefined,
          app: f.app ?? undefined,
          section: f.targetSection ?? undefined,
          feature: f.targetFeature ?? undefined,
          figmaFileKey: f.sourceFileKey,
          figmaFileUrl: f.sourceFileUrl,
          codePaths: f.codePaths,
        },
      })
```

- [ ] **Step 3: Verify compile + existing tests**

Run: `npm run typecheck` → PASS.
Run: `npx jest __tests__/lib/design-migration/` → PASS (24 tests; pending shape change is additive).

- [ ] **Step 4: Re-seed so pending.json carries the new fields**

Run: `npm run figma:manifest && npm run figma:seed`
Expected: `✓ Seeded 0 reconciled → figma-index.json, 41 pending → figma-index.pending.json`.

- [ ] **Step 5: Commit**

```bash
git add lib/design-migration/types.ts lib/design-migration/seed.ts design/figma-index.pending.json design/migration-manifest.json
git commit -m "feat(design-index): enrich pending entries with promotable fields"
```

---

## Task 2: Pure core — `applyInboxToIndex`

**Files:**
- Create: `lib/design-index/inbox.ts`
- Test: `__tests__/lib/design-index/inbox.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// __tests__/lib/design-index/inbox.test.ts
import { applyInboxToIndex } from '@/lib/design-index/inbox'
import { validateDesignIndex } from '@/lib/design-index/validate'
import type { DesignIndex } from '@/lib/design-index/types'
import type { PendingEntry } from '@/lib/design-migration/types'

const emptyIndex = (): DesignIndex => ({
  version: 1,
  apps: { web: { figmaProject: '▣ WEB APP' }, cms: { figmaProject: '▣ CMS APP' }, mobile: { figmaProject: '▣ MOBILE APP' } },
  features: [],
})

function pendingEntry(over: Partial<PendingEntry> = {}): PendingEntry {
  return {
    featureId: 'web-media-library',
    reason: ['placeholder-clickup', 'unassigned-codepaths'],
    partial: {
      id: 'web-media-library',
      app: 'web',
      section: 'Media Library',
      feature: 'Media Library',
      figmaFileKey: 'mlkey',
      figmaFileUrl: 'https://figma.com/design/mlkey/Media-Library',
      codePaths: ['app/media/**'],
    },
    ...over,
  }
}

const allPathsExist = { pathExists: () => true }
const noPathsExist = { pathExists: () => false }

describe('applyInboxToIndex', () => {
  it('promotes a matched entry to reconciled when codePaths exist (dual gate met)', () => {
    const pending = { version: 1, entries: [pendingEntry()] }
    const rows = [{ clickupTaskId: 'CU-1', title: 'Redesign Media Library', figmaUrl: 'https://figma.com/design/mlkey/Media-Library?node-id=2-2' }]
    const out = applyInboxToIndex(emptyIndex(), pending, rows, allPathsExist)
    expect(out.pending.entries).toHaveLength(0)
    expect(out.index.features).toHaveLength(1)
    expect(out.index.features[0].userStories[0].clickupId).toBe('CU-1')
    expect(out.index.features[0].userStories[0].figmaPageNodeId).toBe('2:2')
    expect(validateDesignIndex(out.index, allPathsExist)).toEqual([])
  })

  it('records clickupId but stays pending when codePaths are missing', () => {
    const pending = { version: 1, entries: [pendingEntry()] }
    const rows = [{ clickupTaskId: 'CU-1', title: 'Redesign Media Library', figmaUrl: 'https://figma.com/design/mlkey/x?node-id=2-2' }]
    const out = applyInboxToIndex(emptyIndex(), pending, rows, noPathsExist)
    expect(out.index.features).toHaveLength(0)
    expect(out.pending.entries).toHaveLength(1)
    expect(out.pending.entries[0].assignedClickupId).toBe('CU-1')
    expect(out.pending.entries[0].reason).not.toContain('placeholder-clickup')
    expect(out.pending.entries[0].reason).toContain('unassigned-codepaths')
  })

  it('creates a new stub when no fileKey matches', () => {
    const pending = { version: 1, entries: [] }
    const rows = [{ clickupTaskId: 'CU-9', title: 'New thing', figmaUrl: 'https://figma.com/design/unknownkey/x?node-id=1-1' }]
    const out = applyInboxToIndex(emptyIndex(), pending, rows, allPathsExist)
    expect(out.pending.entries).toHaveLength(1)
    expect(out.pending.entries[0].featureId).toBe('ticket-CU-9')
    expect(out.pending.entries[0].assignedClickupId).toBe('CU-9')
  })

  it('flags unassigned-figma when the ticket has no figma link', () => {
    const out = applyInboxToIndex(emptyIndex(), { version: 1, entries: [] },
      [{ clickupTaskId: 'CU-3', title: 'No link', figmaUrl: null }], allPathsExist)
    expect(out.pending.entries[0].reason).toContain('unassigned-figma')
  })

  it('re-evaluates an already-assigned pending entry and promotes it when paths now exist', () => {
    const entry = pendingEntry({ assignedClickupId: 'CU-1', title: 'ML', figmaNodeId: '2:2', reason: ['unassigned-codepaths'] })
    const out = applyInboxToIndex(emptyIndex(), { version: 1, entries: [entry] }, [], allPathsExist)
    expect(out.index.features).toHaveLength(1)
    expect(out.pending.entries).toHaveLength(0)
  })

  it('is idempotent — a clickupId already present is a no-op', () => {
    const entry = pendingEntry({ assignedClickupId: 'CU-1', figmaNodeId: '2:2', title: 'ML' })
    const pending = { version: 1, entries: [entry] }
    const rows = [{ clickupTaskId: 'CU-1', title: 'again', figmaUrl: 'https://figma.com/design/mlkey/x?node-id=2-2' }]
    const out = applyInboxToIndex(emptyIndex(), pending, rows, noPathsExist)
    expect(out.pending.entries).toHaveLength(1)
    expect(out.pending.entries[0].title).toBe('ML') // not overwritten
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest __tests__/lib/design-index/inbox.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write the pure core**

```ts
// lib/design-index/inbox.ts
import { parseFigmaUrl } from '../figma/client'
import type { DesignIndex, Feature, UserStory } from './types'
import type { PendingEntry, PendingReason } from '../design-migration/types'

export interface InboxRow {
  clickupTaskId: string
  title: string
  figmaUrl: string | null
}
export interface PendingFile {
  version: number
  entries: PendingEntry[]
}
export interface ApplyCtx {
  pathExists: (glob: string) => boolean
}
export type ApplyOutcome = 'promoted' | 'recorded-pending' | 'new-stub' | 'noop'
export interface ApplyResult {
  clickupTaskId: string
  outcome: ApplyOutcome
}

function knownClickupIds(index: DesignIndex, entries: PendingEntry[]): Set<string> {
  const ids = new Set<string>()
  for (const f of index.features) for (const s of f.userStories) ids.add(s.clickupId)
  for (const e of entries) if (e.assignedClickupId) ids.add(e.assignedClickupId)
  return ids
}

/** A pending entry becomes a valid Feature only when every gate is satisfied. */
function tryBuildFeature(e: PendingEntry, ctx: ApplyCtx): Feature | null {
  const p = e.partial
  if (!p.id || !p.app || !p.section || !p.feature) return null
  if (!p.figmaFileKey || !p.figmaFileUrl) return null
  if (!p.codePaths || p.codePaths.length === 0) return null
  if (!e.assignedClickupId || !e.figmaNodeId) return null
  if (!p.codePaths.every((g) => ctx.pathExists(g))) return null
  const story: UserStory = {
    clickupId: e.assignedClickupId,
    title: e.title ?? e.assignedClickupId,
    status: 'in-design',
    figmaPageNodeId: e.figmaNodeId,
    sourceOfTruthNodeId: e.figmaNodeId,
    sandboxNodeId: e.figmaNodeId,
  }
  return {
    id: p.id,
    app: p.app,
    section: p.section,
    feature: p.feature,
    figmaFileKey: p.figmaFileKey,
    figmaFileUrl: p.figmaFileUrl,
    codePaths: p.codePaths,
    userStories: [story],
  }
}

function recomputeReasons(e: PendingEntry, ctx: ApplyCtx): PendingReason[] {
  const p = e.partial
  const reasons: PendingReason[] = []
  if (!p.app || !p.feature) reasons.push('unassigned-feature')
  if (!p.codePaths || p.codePaths.length === 0 || !p.codePaths.every((g) => ctx.pathExists(g))) {
    reasons.push('unassigned-codepaths')
  }
  if (!e.figmaNodeId) reasons.push('unassigned-figma')
  if (!e.assignedClickupId) reasons.push('placeholder-clickup')
  return reasons
}

export function applyInboxToIndex(
  index: DesignIndex,
  pending: PendingFile,
  rows: InboxRow[],
  ctx: ApplyCtx
): { index: DesignIndex; pending: PendingFile; results: ApplyResult[] } {
  const features = [...index.features]
  const entries = pending.entries.map((e) => ({ ...e, partial: { ...e.partial } }))
  const ids = knownClickupIds(index, entries)
  const results: ApplyResult[] = []

  // 1. Apply each inbox row.
  for (const row of rows) {
    if (ids.has(row.clickupTaskId)) {
      results.push({ clickupTaskId: row.clickupTaskId, outcome: 'noop' })
      continue
    }
    const parsed = row.figmaUrl ? parseFigmaUrl(row.figmaUrl) : null
    const fileKey = parsed?.fileKey
    const nodeId = parsed?.nodeId
    const match = fileKey
      ? entries.find((e) => e.partial.figmaFileKey === fileKey && !e.assignedClickupId)
      : undefined
    if (match) {
      match.assignedClickupId = row.clickupTaskId
      match.title = row.title
      if (nodeId) match.figmaNodeId = nodeId
      results.push({ clickupTaskId: row.clickupTaskId, outcome: 'recorded-pending' })
    } else {
      entries.push({
        featureId: `ticket-${row.clickupTaskId}`,
        reason: [],
        partial: { figmaFileKey: fileKey, figmaFileUrl: row.figmaUrl ?? undefined, codePaths: [] },
        assignedClickupId: row.clickupTaskId,
        title: row.title,
        figmaNodeId: nodeId,
      })
      results.push({ clickupTaskId: row.clickupTaskId, outcome: 'new-stub' })
    }
    ids.add(row.clickupTaskId)
  }

  // 2. Promote every entry that now satisfies all gates; recompute reasons for the rest.
  const stillPending: PendingEntry[] = []
  for (const e of entries) {
    const feat = tryBuildFeature(e, ctx)
    if (feat) {
      features.push(feat)
      const existing = results.find((r) => r.clickupTaskId === e.assignedClickupId)
      if (existing) existing.outcome = 'promoted'
    } else {
      e.reason = recomputeReasons(e, ctx)
      stillPending.push(e)
    }
  }

  return {
    index: { ...index, features },
    pending: { version: pending.version, entries: stillPending },
    results,
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest __tests__/lib/design-index/inbox.test.ts` → PASS (6 tests).
Run: `npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/design-index/inbox.ts __tests__/lib/design-index/inbox.test.ts
git commit -m "feat(design-index): applyInboxToIndex pure core (dual-gate promotion)"
```

---

## Task 3: Trigger helpers (status parse + figma extract)

**Files:**
- Create: `lib/design-index/inbox-trigger.ts`
- Test: `__tests__/lib/design-index/inbox-trigger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/design-index/inbox-trigger.test.ts
import { parseDesignIndexStatuses, isDesignIndexStatus, extractFigmaUrl } from '@/lib/design-index/inbox-trigger'

describe('status parsing', () => {
  it('parses, lowercases and trims a comma list', () => {
    expect(parseDesignIndexStatuses(' In Progress , In Design ')).toEqual(['in progress', 'in design'])
  })
  it('returns [] for empty/undefined', () => {
    expect(parseDesignIndexStatuses(undefined)).toEqual([])
    expect(parseDesignIndexStatuses('')).toEqual([])
  })
  it('matches case-insensitively', () => {
    expect(isDesignIndexStatus('In Progress', ['in progress'])).toBe(true)
    expect(isDesignIndexStatus('done', ['in progress'])).toBe(false)
  })
})

describe('extractFigmaUrl', () => {
  it('reads the figma_link custom field by name', () => {
    const fields = [
      { name: 'Priority', value: 'high' },
      { name: 'Figma Link', value: 'https://figma.com/design/abc/x' },
    ]
    expect(extractFigmaUrl(fields)).toBe('https://figma.com/design/abc/x')
  })
  it('returns null when absent', () => {
    expect(extractFigmaUrl([{ name: 'Priority', value: 'high' }])).toBeNull()
    expect(extractFigmaUrl(undefined)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest __tests__/lib/design-index/inbox-trigger.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write the helpers**

```ts
// lib/design-index/inbox-trigger.ts

export function parseDesignIndexStatuses(env: string | undefined): string[] {
  if (!env) return []
  return env.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
}

export function isDesignIndexStatus(status: string, configured: string[]): boolean {
  return configured.includes(status.trim().toLowerCase())
}

interface CustomField {
  name?: string
  value?: unknown
}

/** Pulls the Figma URL from a ClickUp task's custom fields (the "Figma Link" field). */
export function extractFigmaUrl(fields: CustomField[] | undefined): string | null {
  if (!fields) return null
  const field = fields.find((f) => (f.name ?? '').toLowerCase().includes('figma'))
  const value = field?.value
  return typeof value === 'string' && value.length > 0 ? value : null
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest __tests__/lib/design-index/inbox-trigger.test.ts` → PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/design-index/inbox-trigger.ts __tests__/lib/design-index/inbox-trigger.test.ts
git commit -m "feat(design-index): status-parse + figma-url extraction helpers"
```

---

## Task 4: Migration 030 — `design_index_inbox`

**Files:**
- Create: `supabase/migrations/030_design_index_inbox.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/030_design_index_inbox.sql
create table if not exists design_index_inbox (
  id              uuid primary key default gen_random_uuid(),
  clickup_task_id text not null unique,
  title           text not null,
  figma_url       text,
  trigger_status  text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  processed_at    timestamptz,
  last_error      text
);

create index if not exists design_index_inbox_unprocessed
  on design_index_inbox (created_at) where processed_at is null;

alter table design_index_inbox enable row level security;
-- No policies: service-role only (webhook + cron use the Supabase service client).
```

- [ ] **Step 2: Commit (apply to prod manually before deploying Task 5/7)**

```bash
git add supabase/migrations/030_design_index_inbox.sql
git commit -m "feat(design-index): migration 030 design_index_inbox"
```

> ⚠️ Per `project_migration_deploy_ordering`: apply `030` to prod **before** the
> webhook/cron code ships, then regenerate Supabase types. Until applied, leave
> `CLICKUP_DESIGN_INDEX_STATUSES` unset so the webhook never touches the table.

---

## Task 5: Webhook extension

**Files:**
- Modify: `app/api/webhooks/clickup/route.ts`
- Test: `__tests__/api/webhooks/design-index-inbox.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/api/webhooks/design-index-inbox.test.ts
import { maybeQueueDesignIndex } from '@/app/api/webhooks/clickup/design-index-hook'

function fakeSupabase(captured: { row?: Record<string, unknown> }) {
  return {
    from() {
      return {
        upsert(row: Record<string, unknown>) { captured.row = row; return Promise.resolve({ error: null }) },
      }
    },
  } as never
}

describe('maybeQueueDesignIndex', () => {
  const fields = [{ name: 'Figma Link', value: 'https://figma.com/design/abc/x' }]

  it('upserts an inbox row when the status matches', async () => {
    const captured: { row?: Record<string, unknown> } = {}
    await maybeQueueDesignIndex(fakeSupabase(captured), {
      clickupTaskId: 'CU-1', taskName: 'X', toStatus: 'in progress', customFields: fields,
    }, ['in progress'])
    expect(captured.row).toMatchObject({ clickup_task_id: 'CU-1', figma_url: 'https://figma.com/design/abc/x', trigger_status: 'in progress' })
  })

  it('does nothing when the status does not match', async () => {
    const captured: { row?: Record<string, unknown> } = {}
    await maybeQueueDesignIndex(fakeSupabase(captured), {
      clickupTaskId: 'CU-1', taskName: 'X', toStatus: 'done', customFields: fields,
    }, ['in progress'])
    expect(captured.row).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest __tests__/api/webhooks/design-index-inbox.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write the hook module**

```ts
// app/api/webhooks/clickup/design-index-hook.ts
import type { getSupabaseServiceClient } from '@/lib/supabase/server'
import { isDesignIndexStatus, extractFigmaUrl } from '@/lib/design-index/inbox-trigger'

type Supabase = Awaited<ReturnType<typeof getSupabaseServiceClient>>

export interface DesignIndexHookInput {
  clickupTaskId: string
  taskName: string
  toStatus: string
  customFields: { name?: string; value?: unknown }[] | undefined
}

/** Upserts a design_index_inbox row when the ticket status is a configured trigger. */
export async function maybeQueueDesignIndex(
  supabase: Supabase,
  input: DesignIndexHookInput,
  configuredStatuses: string[]
): Promise<void> {
  if (!isDesignIndexStatus(input.toStatus, configuredStatuses)) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase.from('design_index_inbox') as any).upsert(
    {
      clickup_task_id: input.clickupTaskId,
      title: input.taskName,
      figma_url: extractFigmaUrl(input.customFields),
      trigger_status: input.toStatus,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'clickup_task_id' }
  )
}
```

- [ ] **Step 4: Wire it into the webhook**

In `app/api/webhooks/clickup/route.ts`, add the import at top:

```ts
import { maybeQueueDesignIndex } from './design-index-hook'
import { parseDesignIndexStatuses } from '@/lib/design-index/inbox-trigger'
```

Then in the `taskStatusUpdated` path, after the task row is resolved and before
`handleSlackHandoff(...)` (near line 137), add:

```ts
  await maybeQueueDesignIndex(
    supabase,
    {
      clickupTaskId: event.taskId,
      taskName: task ? (task as { name?: string }).name ?? '' : '',
      toStatus: event.toStatus,
      customFields: (task as { custom_fields?: { name?: string; value?: unknown }[] })?.custom_fields,
    },
    parseDesignIndexStatuses(process.env.CLICKUP_DESIGN_INDEX_STATUSES)
  )
```

> Note: the `tasks` select on lines 86–90 returns `id, list_id, status`. Extend it
> to also select `name, custom_fields` so the hook has the title + Figma field:
> change `.select('id, list_id, status')` to `.select('id, list_id, status, name, custom_fields')`
> in the `taskStatusUpdated` branch.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx jest __tests__/api/webhooks/design-index-inbox.test.ts` → PASS.
Run: `npm run typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add app/api/webhooks/clickup/design-index-hook.ts app/api/webhooks/clickup/route.ts __tests__/api/webhooks/design-index-inbox.test.ts
git commit -m "feat(design-index): webhook queues inbox rows on in-progress status"
```

---

## Task 6: GitHub rolling-branch PR helper

**Files:**
- Create: `lib/github/design-index-pr.ts`

- [ ] **Step 1: Write the helper**

```ts
// lib/github/design-index-pr.ts
const API = 'https://api.github.com'

function gh(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  }
}

/** Reads a file's text from a ref (default main). Returns null if absent. */
export async function readRepoFile(
  token: string, repo: string, path: string, ref = 'main'
): Promise<string | null> {
  const res = await fetch(`${API}/repos/${repo}/contents/${path}?ref=${ref}`, { headers: gh(token) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`readRepoFile ${path}: ${res.status}`)
  const data = (await res.json()) as { content: string }
  return Buffer.from(data.content, 'base64').toString('utf8')
}

/**
 * Force-updates `branch` to a single commit off main that writes `files`.
 * Deterministic: re-running with the same content yields the same tree.
 */
export async function forceUpdateBranch(
  token: string, repo: string, branch: string, files: { path: string; content: string }[], message: string
): Promise<void> {
  const headers = gh(token)
  const mainRef = await fetch(`${API}/repos/${repo}/git/ref/heads/main`, { headers })
  if (!mainRef.ok) throw new Error(`get main ref: ${mainRef.status}`)
  const baseSha = ((await mainRef.json()) as { object: { sha: string } }).object.sha

  const blobs = await Promise.all(files.map(async (f) => {
    const r = await fetch(`${API}/repos/${repo}/git/blobs`, {
      method: 'POST', headers, body: JSON.stringify({ content: f.content, encoding: 'utf-8' }),
    })
    if (!r.ok) throw new Error(`create blob ${f.path}: ${r.status}`)
    return { path: f.path, mode: '100644', type: 'blob', sha: ((await r.json()) as { sha: string }).sha }
  }))

  const treeRes = await fetch(`${API}/repos/${repo}/git/trees`, {
    method: 'POST', headers, body: JSON.stringify({ base_tree: baseSha, tree: blobs }),
  })
  if (!treeRes.ok) throw new Error(`create tree: ${treeRes.status}`)
  const treeSha = ((await treeRes.json()) as { sha: string }).sha

  const commitRes = await fetch(`${API}/repos/${repo}/git/commits`, {
    method: 'POST', headers, body: JSON.stringify({ message, tree: treeSha, parents: [baseSha] }),
  })
  if (!commitRes.ok) throw new Error(`create commit: ${commitRes.status}`)
  const commitSha = ((await commitRes.json()) as { sha: string }).sha

  const refPath = `${API}/repos/${repo}/git/refs/heads/${branch}`
  const exists = await fetch(refPath, { headers })
  const refRes = exists.ok
    ? await fetch(refPath, { method: 'PATCH', headers, body: JSON.stringify({ sha: commitSha, force: true }) })
    : await fetch(`${API}/repos/${repo}/git/refs`, { method: 'POST', headers, body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitSha }) })
  if (!refRes.ok) throw new Error(`update ref: ${refRes.status}`)
}

/** Ensures one open PR for branch→main exists and enables auto-merge. Returns PR number. */
export async function ensurePrWithAutoMerge(
  token: string, repo: string, branch: string, title: string
): Promise<number> {
  const headers = gh(token)
  const owner = repo.split('/')[0]
  const list = await fetch(`${API}/repos/${repo}/pulls?head=${owner}:${branch}&state=open`, { headers })
  if (!list.ok) throw new Error(`list pulls: ${list.status}`)
  let pr = ((await list.json()) as { number: number; node_id: string }[])[0]

  if (!pr) {
    const create = await fetch(`${API}/repos/${repo}/pulls`, {
      method: 'POST', headers, body: JSON.stringify({ title, head: branch, base: 'main', body: 'Automated design-index scaffold. Auto-merges on green CI.' }),
    })
    if (!create.ok) throw new Error(`create pull: ${create.status}`)
    pr = (await create.json()) as { number: number; node_id: string }
  }

  // Enable auto-merge (GraphQL); ignore failure if already enabled / not allowed.
  await fetch(`${API}/graphql`, {
    method: 'POST', headers,
    body: JSON.stringify({
      query: `mutation($id:ID!){ enablePullRequestAutoMerge(input:{pullRequestId:$id, mergeMethod:SQUASH}){ clientMutationId } }`,
      variables: { id: pr.node_id },
    }),
  }).catch(() => {})

  return pr.number
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck` → PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/github/design-index-pr.ts
git commit -m "feat(design-index): github rolling-branch PR + auto-merge helper"
```

---

## Task 7: Cron orchestrator + wiring

**Files:**
- Create: `app/api/cron/design-index-sync/route.ts`
- Modify: `vercel.json`

- [ ] **Step 1: Write the cron route**

```ts
// app/api/cron/design-index-sync/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { applyInboxToIndex, type InboxRow, type PendingFile } from '@/lib/design-index/inbox'
import { readRepoFile, forceUpdateBranch, ensurePrWithAutoMerge } from '@/lib/github/design-index-pr'
import { pathExists as ghPathExists } from '@/lib/github/repos'
import type { DesignIndex } from '@/lib/design-index/types'

export const maxDuration = 60
const REPO = process.env.GITHUB_REPO ?? 'kanon4us/pm-app'
const BRANCH = 'design-index-sync'

function staticPrefix(glob: string): string {
  const i = glob.indexOf('*')
  return (i === -1 ? glob : glob.slice(0, i)).replace(/\/+$/, '')
}

export async function POST(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const token = process.env.GITHUB_TOKEN
  if (!token) return NextResponse.json({ error: 'No GITHUB_TOKEN' }, { status: 500 })

  const supabase = await getSupabaseServiceClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rowsRaw } = await (supabase.from('design_index_inbox') as any)
    .select('*').is('processed_at', null)
  const dbRows = (rowsRaw ?? []) as { id: string; clickup_task_id: string; title: string; figma_url: string | null }[]
  if (dbRows.length === 0) return NextResponse.json({ ok: true, processed: 0 })

  try {
    const indexText = await readRepoFile(token, REPO, 'design/figma-index.json')
    const pendingText = await readRepoFile(token, REPO, 'design/figma-index.pending.json')
    const index = JSON.parse(indexText ?? '{"version":1,"apps":{},"features":[]}') as DesignIndex
    const pending = JSON.parse(pendingText ?? '{"version":1,"entries":[]}') as PendingFile

    // Resolve all codePaths existence against GitHub up-front (sync predicate for the pure core).
    const globs = new Set<string>()
    for (const e of pending.entries) for (const g of e.partial.codePaths ?? []) globs.add(g)
    const existing = new Map<string, boolean>()
    for (const g of globs) existing.set(g, await ghPathExists(token, REPO, staticPrefix(g)))
    const pathExists = (g: string) => existing.get(g) ?? false

    const rows: InboxRow[] = dbRows.map((r) => ({ clickupTaskId: r.clickup_task_id, title: r.title, figmaUrl: r.figma_url }))
    const out = applyInboxToIndex(index, pending, rows, { pathExists })

    await forceUpdateBranch(token, REPO, BRANCH, [
      { path: 'design/figma-index.json', content: JSON.stringify(out.index, null, 2) + '\n' },
      { path: 'design/figma-index.pending.json', content: JSON.stringify(out.pending, null, 2) + '\n' },
    ], `chore(design-index): scaffold ${rows.length} ticket(s) [skip ci]`)
    const pr = await ensurePrWithAutoMerge(token, REPO, BRANCH, 'Design-index: scaffold from ClickUp')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase.from('design_index_inbox') as any)
      .update({ processed_at: new Date().toISOString() })
      .in('id', dbRows.map((r) => r.id))

    return NextResponse.json({ ok: true, processed: rows.length, pr })
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase.from('design_index_inbox') as any)
      .update({ last_error: (err as Error).message })
      .in('id', dbRows.map((r) => r.id))
    console.error('[design-index-sync] failed:', err)
    return NextResponse.json({ error: 'sync failed' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Add the cron schedule**

In `vercel.json`, add to the `crons` array:

```json
    { "path": "/api/cron/design-index-sync", "schedule": "*/15 * * * *" }
```

- [ ] **Step 3: Verify build + typecheck**

Run: `npm run typecheck` → PASS.
Run: `npx jest __tests__/lib/design-index/ __tests__/api/webhooks/` → PASS (all design-index + webhook tests).

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/design-index-sync/route.ts vercel.json
git commit -m "feat(design-index): cron orchestrator + 15-min schedule"
```

---

## Task 8: Env documentation

**Files:**
- Modify: `.env.local.example`

- [ ] **Step 1: Document the new env var**

Add to `.env.local.example`:

```
# Comma-separated ClickUp status names that scaffold a design-index entry.
# Leave empty to keep the subsystem inert (safe dark ship).
CLICKUP_DESIGN_INDEX_STATUSES=
# GitHub repo for design-index PRs (owner/name). Defaults to kanon4us/pm-app.
GITHUB_REPO=
```

- [ ] **Step 2: Commit**

```bash
git add .env.local.example
git commit -m "docs(design-index): document CLICKUP_DESIGN_INDEX_STATUSES + GITHUB_REPO"
```

---

## Self-Review

**Spec coverage:**
- §4 architecture (webhook → inbox → cron → rolling PR) → Tasks 4, 5, 6, 7.
- §5 dual-gate matching/promotion + re-evaluation + idempotency → Task 2 (`applyInboxToIndex`).
- §5 `PendingEntry` enrichment + `unassigned-figma` → Task 1.
- §6 migration 030 + env status parsing → Tasks 4, 3, 5.
- §7 error handling (retry on failure, empty no-op, idempotent re-run) → Tasks 2, 7.
- §8 testing (pure core fixtures, webhook, status/figma parse) → Tasks 2, 3, 5.

Out of scope (spec §3 / §10): ClickUp-side automation UI, auto-`codePaths`, writing IDs back into Figma page names.

**Placeholder scan:** none — every step has runnable code/commands. The seed enrichment (Task 1) re-generates real data via `figma:seed`.

**Type consistency:** `InboxRow`/`PendingFile`/`ApplyCtx` defined in Task 2 reused in Task 7. `PendingEntry` fields (`assignedClickupId`,`title`,`figmaNodeId`) defined Task 1, used Tasks 2 & 7. `parseDesignIndexStatuses`/`isDesignIndexStatus`/`extractFigmaUrl` defined Task 3, used Task 5. `readRepoFile`/`forceUpdateBranch`/`ensurePrWithAutoMerge` defined Task 6, used Task 7. `pathExists(token, repo, path)` matches `lib/github/repos.ts`.

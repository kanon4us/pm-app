# Gatekeeper Custom-Field Trigger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fire the prototyping gatekeeper when a ClickUp task's custom fields signal prototype-readiness (`Design states == "In progress"` AND a Figma link), replacing the old status/tag trigger, and route the feature's app from the `Relevant App` field.

**Architecture:** Pure predicates in `lib/features/gatekeeper-extract.ts` (`isPrototypeReady`, extended `resolveAppIdentity`) keep the logic unit-testable. `parseWebhookEvent` learns to parse `taskUpdated` and collect changed field names. The webhook route gates on a re-fetch whitelist, fetches the task once, checks readiness, and passes the already-fetched task into `activateFeatureFromTask` (which gains an optional prefetched-task param to avoid a double `getTask`). `createWebhook` subscribes to `taskUpdated`.

**Tech Stack:** Next.js 16 App Router (route handler), TypeScript, Jest, ClickUp REST v2, Supabase.

**Spec:** `docs/superpowers/specs/2026-07-05-gatekeeper-custom-field-trigger-design.md`

---

## File Structure

- **Modify** `lib/features/gatekeeper-extract.ts` — extend `ClickUpCustomField` with `type`/`type_config`; add internal `optionLabel` + `relevantAppFromFields` helpers; add exported `isPrototypeReady`; extend `resolveAppIdentity` with a `fields` source (`relevant-app`). Existing status/tag helpers stay (unused by the route, still exported/tested).
- **Modify** `__tests__/lib/gatekeeper-extract.test.ts` — add `isPrototypeReady` + `resolveAppIdentity`/Relevant-App cases.
- **Modify** `lib/clickup/webhook.ts` — add `changedFieldNames?: string[]` to `ClickUpWebhookEvent`; parse `taskUpdated`.
- **Modify** `__tests__/lib/clickup/webhook.test.ts` — add `taskUpdated` parse cases.
- **Modify** `lib/features/gatekeeper.ts` — `activateFeatureFromTask` accepts optional prefetched `ClickUpTask`; pass `fields` into `resolveAppIdentity`.
- **Modify** `lib/clickup/client.ts` — add `taskUpdated` to `createWebhook` events.
- **Modify** `app/api/webhooks/clickup/route.ts` — replace the status/tag gatekeeper block with the `taskUpdated` custom-field trigger + early-return; swap imports.
- **Modify** `__tests__/api/webhooks/clickup.test.ts` — add `taskUpdated` route cases (fires when ready; whitelist drops off-list edits).

---

## Task 0: Worktree setup

**Files:** none

- [ ] **Step 1: Ensure `node_modules` is available**

Git worktrees don't copy `node_modules`. From the worktree root, symlink the main repo's (already done in this worktree, but recreate if missing):

```bash
cd /Users/michaelterry/Development/ViscapMedia/pm-app/.claude/worktrees/gatekeeper-trigger
[ -e node_modules ] || ln -s ../../../node_modules node_modules
node -e "console.log('next', require('next/package.json').version)"
```

Expected: prints `next 16.2.2`. All later `npx …` commands run from this worktree root.

---

## Task 1: `isPrototypeReady` + drop_down label resolution

**Files:**
- Modify: `lib/features/gatekeeper-extract.ts`
- Test: `__tests__/lib/gatekeeper-extract.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `__tests__/lib/gatekeeper-extract.test.ts` — first add `isPrototypeReady` to the import at the top:

```ts
import {
  parsePrototypeStatuses,
  isPrototypeStatus,
  hasPrototypeTag,
  extractFviScore,
  extractObjectives,
  resolveAppIdentity,
  isPrototypeReady,
} from '@/lib/features/gatekeeper-extract'
```

Then append:

```ts
describe('isPrototypeReady', () => {
  const figma = { name: 'Figma', type: 'short_text', value: 'https://www.figma.com/design/abc?node-id=1' }
  // value 2 → "In progress" in THIS field's ordering
  const designInProgress = {
    name: 'Design states', type: 'drop_down', value: 2,
    type_config: { options: [
      { id: 'a', orderindex: 0, label: 'Approved' },
      { id: 'b', orderindex: 1, label: 'Done' },
      { id: 'c', orderindex: 2, label: 'In progress' },
    ] },
  }

  it('true when a Design states field resolves to In progress AND a figma.com link is present', () => {
    expect(isPrototypeReady([designInProgress, figma])).toBe(true)
  })

  it('resolves label per-field, never by raw value (the duplicate-field trap)', () => {
    // Same raw value 2, but here orderindex 2 = "Done" — must NOT trigger.
    const designDoneHere = {
      name: 'Design states', type: 'drop_down', value: 2,
      type_config: { options: [
        { id: 'x0', orderindex: 0, label: 'Took it' },
        { id: 'x1', orderindex: 1, label: 'In progress' },
        { id: 'x2', orderindex: 2, label: 'Done' },
      ] },
    }
    expect(isPrototypeReady([designDoneHere, figma])).toBe(false)
  })

  it('matches when ANY of duplicate Design states fields resolves to In progress', () => {
    const emptyDup = { name: 'Design states', type: 'drop_down', value: null, type_config: { options: [] } }
    expect(isPrototypeReady([emptyDup, designInProgress, figma])).toBe(true)
  })

  it('resolves an option by id as well as by orderindex', () => {
    const byId = { name: 'Design states', type: 'drop_down', value: 'c',
      type_config: { options: [{ id: 'c', label: 'In progress' }] } }
    expect(isPrototypeReady([byId, figma])).toBe(true)
  })

  it('false without a figma.com link', () => {
    expect(isPrototypeReady([designInProgress])).toBe(false)
    expect(isPrototypeReady([designInProgress, { name: 'Figma', value: '' }])).toBe(false)
    expect(isPrototypeReady([designInProgress, { name: 'Figma', value: 'https://example.com/x' }])).toBe(false)
  })

  it('false when no Design states field is In progress', () => {
    const done = { ...designInProgress, value: 1 } // "Done"
    expect(isPrototypeReady([done, figma])).toBe(false)
  })

  it('false / safe on empty or undefined fields', () => {
    expect(isPrototypeReady([])).toBe(false)
    expect(isPrototypeReady(undefined)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd .claude/worktrees/gatekeeper-trigger && npx jest gatekeeper-extract -t isPrototypeReady`
Expected: FAIL — `isPrototypeReady is not a function` / not exported.

- [ ] **Step 3: Implement `optionLabel` + `isPrototypeReady`**

In `lib/features/gatekeeper-extract.ts`, first extend the field interface (replace the existing `ClickUpCustomField`):

```ts
export interface ClickUpFieldOption {
  id?: string
  orderindex?: number
  name?: string
  label?: string
}

export interface ClickUpCustomField {
  id?: string
  name?: string
  type?: string
  value?: unknown
  type_config?: { options?: ClickUpFieldOption[] }
}
```

Then add (near the top of the extraction helpers):

```ts
/** Display label of a drop_down field's stored value (matched by orderindex OR id). */
function optionLabel(field: ClickUpCustomField): string | null {
  const v = field.value
  if (v === null || v === undefined) return null
  const opt = (field.type_config?.options ?? []).find((o) => o.orderindex === v || o.id === v)
  const label = opt?.label ?? opt?.name
  return label ? label.trim() : null
}

const FIGMA_HOST = 'figma.com'

/**
 * Prototype-ready by custom fields: SOME field named "Design states" resolves to
 * the option label "In progress" AND a "Figma" field holds a figma.com link.
 * Resolve each drop_down's value to its own option label — never compare the raw
 * numeric value, which means different things across duplicate fields.
 */
export function isPrototypeReady(fields: ClickUpCustomField[] | undefined): boolean {
  const list = fields ?? []
  const designReady = list.some(
    (f) => f.name?.trim().toLowerCase() === 'design states' &&
      optionLabel(f)?.toLowerCase() === 'in progress'
  )
  if (!designReady) return false
  return list.some(
    (f) => f.name?.trim().toLowerCase() === 'figma' &&
      typeof f.value === 'string' && f.value.toLowerCase().includes(FIGMA_HOST)
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest gatekeeper-extract -t isPrototypeReady`
Expected: PASS (all `isPrototypeReady` cases green).

- [ ] **Step 5: Commit**

```bash
git add lib/features/gatekeeper-extract.ts __tests__/lib/gatekeeper-extract.test.ts
git commit -m "feat(gatekeeper): isPrototypeReady custom-field predicate + per-field label resolution"
```

---

## Task 2: Route app from the `Relevant App` field

**Files:**
- Modify: `lib/features/gatekeeper-extract.ts`
- Test: `__tests__/lib/gatekeeper-extract.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the `resolveAppIdentity` describe block in `__tests__/lib/gatekeeper-extract.test.ts`:

```ts
  const relevantApp = (label: string, id = 'opt1') => ({
    name: 'Relevant App', type: 'labels', value: [id],
    type_config: { options: [{ id, orderindex: 0, label }] },
  })

  it('routes from the Relevant App field (Web → web)', () => {
    expect(resolveAppIdentity({ tags: [], fields: [relevantApp('Web')] }))
      .toEqual({ app: 'web', source: 'relevant-app' })
  })

  it('maps iOS/Android → mobile and Mac/Win → desktop', () => {
    expect(resolveAppIdentity({ tags: [], fields: [relevantApp('iOS')] }).app).toBe('mobile')
    expect(resolveAppIdentity({ tags: [], fields: [relevantApp('Android')] }).app).toBe('mobile')
    expect(resolveAppIdentity({ tags: [], fields: [relevantApp('Mac')] }).app).toBe('desktop')
    expect(resolveAppIdentity({ tags: [], fields: [relevantApp('Win')] }).app).toBe('desktop')
  })

  it('Relevant App wins over tag and list repo', () => {
    expect(resolveAppIdentity({
      tags: ['app:cms'],
      listRepoFullName: 'Viscap-Media/media-sync-mobile',
      fields: [relevantApp('Web')],
    })).toEqual({ app: 'web', source: 'relevant-app' })
  })

  it('unresolvable Relevant App label falls through to existing precedence', () => {
    expect(resolveAppIdentity({ tags: ['app:mobile'], fields: [relevantApp('Linux', 'z')] }).app).toBe('mobile')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest gatekeeper-extract -t "resolveAppIdentity"`
Expected: FAIL — `source: 'relevant-app'` not produced (falls to `'default'`/`'tag'`).

- [ ] **Step 3: Implement the Relevant App source**

In `lib/features/gatekeeper-extract.ts`, add the label→slug map and helper (below `TAG_APP_ALIASES`):

```ts
// "Relevant App" label options → app slug. Mac/Win → desktop is retained but
// desktop is slated for retirement (web + mobile are the near-term apps).
const RELEVANT_APP_LABEL_TO_SLUG: Record<string, AppSlug> = {
  web: 'web',
  ios: 'mobile',
  android: 'mobile',
  mac: 'desktop',
  win: 'desktop',
}

function relevantAppFromFields(fields: ClickUpCustomField[] | undefined): AppSlug | null {
  const field = (fields ?? []).find((f) => f.name?.trim().toLowerCase() === 'relevant app')
  if (!field) return null
  const raw = field.value
  const ids = Array.isArray(raw) ? raw : raw != null ? [raw] : []
  const opts = field.type_config?.options ?? []
  for (const id of ids) {
    const opt = opts.find((o) => o.id === id || o.orderindex === id)
    const label = (opt?.label ?? opt?.name)?.trim().toLowerCase()
    if (label && RELEVANT_APP_LABEL_TO_SLUG[label]) return RELEVANT_APP_LABEL_TO_SLUG[label]
  }
  return null
}
```

Then update `resolveAppIdentity`'s signature + body (add the `fields` param and the first-priority check; widen the `source` union):

```ts
export function resolveAppIdentity(input: {
  tags: string[]
  listRepoFullName?: string | null
  fields?: ClickUpCustomField[]
}): { app: AppSlug; source: 'relevant-app' | 'tag' | 'list-repo' | 'default' } {
  const relevant = relevantAppFromFields(input.fields)
  if (relevant) return { app: relevant, source: 'relevant-app' }

  for (const raw of input.tags) {
    const tag = raw.trim().toLowerCase()
    const explicit = tag.startsWith('app:') ? tag.slice(4) : tag
    if ((APP_SLUGS as string[]).includes(explicit)) return { app: explicit as AppSlug, source: 'tag' }
    if (TAG_APP_ALIASES[explicit]) return { app: TAG_APP_ALIASES[explicit], source: 'tag' }
  }

  if (input.listRepoFullName) {
    const repo = input.listRepoFullName.trim().toLowerCase()
    for (const slug of APP_SLUGS) {
      if (APP_REGISTRY[slug].repo.toLowerCase() === repo) return { app: slug, source: 'list-repo' }
    }
  }

  return { app: 'web', source: 'default' }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest gatekeeper-extract`
Expected: PASS — new Relevant-App cases green AND the existing `resolveAppIdentity` cases (which omit `fields`) still pass.

- [ ] **Step 5: Commit**

```bash
git add lib/features/gatekeeper-extract.ts __tests__/lib/gatekeeper-extract.test.ts
git commit -m "feat(gatekeeper): route app from Relevant App field, first precedence"
```

---

## Task 3: Parse `taskUpdated` + collect changed field names

**Files:**
- Modify: `lib/clickup/webhook.ts`
- Test: `__tests__/lib/clickup/webhook.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the `parseWebhookEvent` describe in `__tests__/lib/clickup/webhook.test.ts`:

```ts
  it('collects changed custom-field AND top-level field names from taskUpdated', () => {
    const payload = {
      event: 'taskUpdated',
      task_id: 't1',
      history_items: [
        { field: 'custom_field', custom_field: { name: 'Design states' } },
        { field: 'description' },
        { field: 'custom_field', custom_field: { name: 'Figma' } },
      ],
    }
    expect(parseWebhookEvent(payload)).toEqual({
      taskId: 't1',
      type: 'taskUpdated',
      toStatus: '',
      changedFieldNames: ['Design states', 'description', 'Figma'],
    })
  })

  it('taskUpdated with no history_items yields empty changedFieldNames', () => {
    expect(parseWebhookEvent({ event: 'taskUpdated', task_id: 't2' })).toEqual({
      taskId: 't2', type: 'taskUpdated', toStatus: '', changedFieldNames: [],
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest webhook.test -t taskUpdated`
Expected: FAIL — `parseWebhookEvent` returns `null` for `taskUpdated`.

- [ ] **Step 3: Implement the `taskUpdated` branch**

In `lib/clickup/webhook.ts`, add `changedFieldNames` to the interface:

```ts
export interface ClickUpWebhookEvent {
  taskId: string
  type: string
  toStatus: string
  /** Present on taskMoved events: the destination list ID */
  listId?: string
  /** Present on taskTagUpdated events: tag names after the change */
  tags?: string[]
  /** Present on taskUpdated events: names of fields that changed (custom + top-level) */
  changedFieldNames?: string[]
}
```

Add this branch inside `parseWebhookEvent`, before the final `return null`:

```ts
  if (eventType === 'taskUpdated') {
    // ClickUp batches changes into multiple history_items; scan ALL of them.
    // Custom-field edits: field==='custom_field' → custom_field.name.
    // Top-level edits (e.g. description): the item's own `field` string.
    const historyItems = (payload.history_items as Array<{
      field?: string
      custom_field?: { name?: string }
    }>) ?? []
    const changedFieldNames = historyItems.flatMap((h) =>
      h.field === 'custom_field'
        ? (h.custom_field?.name ? [h.custom_field.name] : [])
        : (h.field ? [h.field] : [])
    )
    return { taskId, type: eventType, toStatus: '', changedFieldNames }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest webhook.test`
Expected: PASS — new `taskUpdated` cases green; existing `taskStatusUpdated`/`null` cases still pass (they use `toEqual` without `changedFieldNames`, which stays absent).

- [ ] **Step 5: Commit**

```bash
git add lib/clickup/webhook.ts __tests__/lib/clickup/webhook.test.ts
git commit -m "feat(clickup): parse taskUpdated into changedFieldNames (custom + top-level)"
```

---

## Task 4: Thread prefetched task + fields through the gatekeeper

**Files:**
- Modify: `lib/features/gatekeeper.ts`

No new unit test — this is orchestration wiring verified by `tsc` and covered end-to-end by the Task 6 route tests. Keep the diff minimal.

- [ ] **Step 1: Accept an optional prefetched task**

In `lib/features/gatekeeper.ts`, change the signature and the fetch so a caller that already has the task avoids a second `getTask`. Replace the opening of `activateFeatureFromTask`:

```ts
export async function activateFeatureFromTask(
  db: Db,
  clickupTaskId: string,
  prefetched?: ClickUpTask,
): Promise<GatekeeperResult | null> {
  let cuTask = prefetched
  if (!cuTask) {
    const { data: tokenRow } = await db
      .from('oauth_tokens').select('access_token').eq('provider', 'clickup').limit(1).single()
    if (!tokenRow) {
      console.warn('[gatekeeper] no ClickUp token — cannot enrich task', clickupTaskId)
      return null
    }
    cuTask = await buildClickUpClient(tokenRow.access_token).getTask(clickupTaskId)
  }
```

(Everything after `const fields = (cuTask.custom_fields ?? []) as ClickUpCustomField[]` stays as-is. Ensure `ClickUpTask` is imported — it already is: `import { buildClickUpClient, type ClickUpTask } from '@/lib/clickup/client'`.)

- [ ] **Step 2: Pass `fields` into `resolveAppIdentity`**

Still in `activateFeatureFromTask`, update the `resolveAppIdentity` call:

```ts
  const app = resolveAppIdentity({
    tags,
    listRepoFullName: task ? await listRepoFullName(db, task.list_id) : null,
    fields,
  })
```

- [ ] **Step 3: Verify types**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/features/gatekeeper.ts
git commit -m "refactor(gatekeeper): accept prefetched task + route app from custom fields"
```

---

## Task 5: Subscribe the webhook to `taskUpdated`

**Files:**
- Modify: `lib/clickup/client.ts`

- [ ] **Step 1: Add the event + refresh the comment**

In `lib/clickup/client.ts` `createWebhook`, replace the `body` line and its comment:

```ts
      // taskUpdated carries custom-field edits (Design states / Figma / Relevant App)
      // that drive the prototyping gatekeeper. Existing webhooks must be
      // re-registered (POST /api/lists/resubscribe) before the new event flows.
      body: JSON.stringify({ endpoint, events: ['taskStatusUpdated', 'taskMoved', 'taskTagUpdated', 'taskUpdated'] }),
```

- [ ] **Step 2: Verify types**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/clickup/client.ts
git commit -m "feat(clickup): subscribe webhook to taskUpdated events"
```

---

## Task 6: Rewire the webhook route to the custom-field trigger

**Files:**
- Modify: `app/api/webhooks/clickup/route.ts`
- Test: `__tests__/api/webhooks/clickup.test.ts`

- [ ] **Step 1: Write the failing route tests**

At the TOP of `__tests__/api/webhooks/clickup.test.ts`, add a mock for the gatekeeper module (below the existing `jest.mock('@/lib/slack/client', …)` block):

```ts
jest.mock('@/lib/features/gatekeeper', () => ({
  activateFeatureFromTask: jest.fn().mockResolvedValue(null),
}))
```

Then add a new describe block at the end of the file:

```ts
describe('POST /api/webhooks/clickup — prototyping gatekeeper (taskUpdated)', () => {
  const { activateFeatureFromTask } = jest.requireMock('@/lib/features/gatekeeper')

  function mockTokenAndTask(customFields: unknown[]) {
    const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(
      makeSupabaseMock({ oauth_tokens: { data: { access_token: 'cu-tok' } } })
    )
    // getTask() → ClickUp task JSON with the given custom_fields
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'cu-abc', name: 'T', description: null, custom_fields: customFields, list: { id: 'L' } }),
    })
  }

  const readyFields = [
    { name: 'Design states', type: 'drop_down', value: 2,
      type_config: { options: [{ orderindex: 2, label: 'In progress' }] } },
    { name: 'Figma', type: 'short_text', value: 'https://www.figma.com/design/abc' },
  ]

  it('activates when a whitelisted field changed and the task is prototype-ready', async () => {
    mockTokenAndTask(readyFields)
    const req = makeRequest({
      event: 'taskUpdated',
      task_id: 'cu-abc',
      history_items: [{ field: 'custom_field', custom_field: { name: 'Design states' } }],
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(activateFeatureFromTask).toHaveBeenCalledWith(
      expect.anything(), 'cu-abc', expect.objectContaining({ id: 'cu-abc' })
    )
  })

  it('does NOT fetch or activate when only off-whitelist fields changed', async () => {
    mockTokenAndTask(readyFields)
    const req = makeRequest({
      event: 'taskUpdated',
      task_id: 'cu-abc',
      history_items: [{ field: 'assignee' }, { field: 'due_date' }],
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(global.fetch).not.toHaveBeenCalled()
    expect(activateFeatureFromTask).not.toHaveBeenCalled()
  })

  it('does NOT activate when a whitelisted field changed but the task is not ready', async () => {
    mockTokenAndTask([
      { name: 'Design states', type: 'drop_down', value: 1,
        type_config: { options: [{ orderindex: 1, label: 'Done' }] } },
      { name: 'Figma', type: 'short_text', value: 'https://www.figma.com/design/abc' },
    ])
    const req = makeRequest({
      event: 'taskUpdated',
      task_id: 'cu-abc',
      history_items: [{ field: 'custom_field', custom_field: { name: 'Figma' } }],
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(activateFeatureFromTask).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest clickup.test`
Expected: FAIL — the route doesn't handle `taskUpdated` yet (activate not called; or fetch called on off-list edit).

- [ ] **Step 3: Rewire the route**

In `app/api/webhooks/clickup/route.ts`, swap the gatekeeper import (line 9):

```ts
import { isPrototypeReady, type ClickUpCustomField } from '@/lib/features/gatekeeper-extract'
```

Replace the entire prototyping-gatekeeper block (from the `// ── Prototyping gatekeeper …` comment through the `if (event.type === 'taskTagUpdated') return …` line) with:

```ts
  // ── Prototyping gatekeeper — custom-field trigger ──
  // Fire when the PM marks a task prototype-ready via custom fields:
  // Design states == "In progress" AND a Figma link. Those edits arrive as
  // taskUpdated; a whitelist pre-filter avoids a getTask on unrelated edits, and
  // isPrototypeReady re-checks after the fetch. activateFeatureFromTask is idempotent.
  if (event.type === 'taskUpdated') {
    const REFETCH_FIELDS = ['design states', 'figma', 'relevant app', 'description']
    const changed = (event.changedFieldNames ?? []).map((n) => n.trim().toLowerCase())
    if (changed.some((n) => REFETCH_FIELDS.includes(n))) {
      const { data: token } = await supabase
        .from('oauth_tokens').select('access_token').eq('provider', 'clickup').limit(1).single()
      if (token) {
        try {
          const cuTask = await buildClickUpClient(token.access_token).getTask(event.taskId)
          if (isPrototypeReady(cuTask.custom_fields as ClickUpCustomField[])) {
            await activateFeatureFromTask(supabase, event.taskId, cuTask)
          }
        } catch (err) {
          console.warn('[gatekeeper] taskUpdated activation failed for task', event.taskId, err)
        }
      }
    }
    return NextResponse.json({ ok: true })
  }

  // Tag events carry no status — nothing below applies to them.
  if (event.type === 'taskTagUpdated') return NextResponse.json({ ok: true })
```

(`activateFeatureFromTask` and `buildClickUpClient` imports already exist. The old `parsePrototypeStatuses/isPrototypeStatus/hasPrototypeTag` import is now removed.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest clickup.test`
Expected: PASS — all three new cases green; existing taskMoved/taskStatusUpdated cases still pass.

- [ ] **Step 5: Commit**

```bash
git add app/api/webhooks/clickup/route.ts __tests__/api/webhooks/clickup.test.ts
git commit -m "feat(gatekeeper): trigger on taskUpdated custom fields, retire status/tag path"
```

---

## Task 7: Full verification + ops

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `npx jest`
Expected: all suites green (was 522/522 on main; new cases add to that count).

- [ ] **Step 3: Production build**

Run: `npx next build`
Expected: builds successfully (route handler compiles).

- [ ] **Step 4: Record the ops steps in the PR description**

The PR body MUST list the manual post-deploy ops (no migration needed):
1. After merge + deploy, `POST /api/lists/resubscribe` once per team (re-registers the ClickUp webhook with `taskUpdated`; the live prod webhook currently has `taskStatusUpdated` only).
2. Live-test: on a task, set `Design states` → "In progress" with a `Figma` link; confirm the feature appears enriched (`fvi_score`, `clickup_details`) and app-routed from `Relevant App` in the Feature Editor.

- [ ] **Step 5: (Post-deploy) verify the live payload shape**

After the resubscribe, edit a task's description and a custom field, then check prod logs for `[gatekeeper]`. If activation doesn't fire on a known-ready task, capture the `taskUpdated` payload and confirm `history_items[].field === 'custom_field'` / `custom_field.name` and the top-level `field: 'description'` shape match Task 3's parser; adjust `parseWebhookEvent` if ClickUp's shape differs.

---

## Task 8: Open the PR

- [ ] **Step 1: Push and open the PR (do NOT auto-merge)**

```bash
git push -u origin feat/gatekeeper-custom-field-trigger
gh pr create --base main --title "feat(gatekeeper): custom-field prototype trigger (Design states + Figma)" --body "<summary + the Task 7 Step 4 ops checklist>"
```

Michael merges and runs the resubscribe manually.

---

## Notes for the implementer

- Run all commands from the worktree root: `.claude/worktrees/gatekeeper-trigger/`.
- The status/tag helpers (`parsePrototypeStatuses`, `isPrototypeStatus`, `hasPrototypeTag`) stay exported and tested but are no longer used by the route — leave them (the spec permits this; removing them expands the diff and drops their tests for no benefit).
- `ClickUpTask.custom_fields` is typed without `type_config`, but the ClickUp API returns it at runtime — hence the `as ClickUpCustomField[]` cast in the route. Do not widen the `ClickUpTask` type in this PR.

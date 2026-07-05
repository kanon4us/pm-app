# Assessment → Workflow Registry Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a PM push an assessment's affected workflows into `workflows_registry` from the assessment UI, so they appear on `/workflows`.

**Architecture:** A new per-workflow endpoint upserts one workflow into `workflows_registry` (OR-merging impact flags, race-safe via the existing `unique(name)` constraint) and best-effort links it to the assessment via `assessment_workflows`. The sprint page renders an Add/Update button per affected workflow, driven by a client-side set of existing registry names, with optimistic UI.

**Tech Stack:** Next.js (App Router, non-standard fork — see AGENTS.md), Supabase JS client, Jest, React 19 + Ant Design, TypeScript.

Spec: `docs/superpowers/specs/2026-07-05-assessment-workflow-registry-sync-design.md`

---

## File Structure

- **Create** `lib/workflows/normalize.ts` — shared name normalization + LIKE-escape helpers used by BOTH the endpoint (case-insensitive DB match) and the frontend (set membership). One responsibility: consistent workflow-name comparison.
- **Create** `app/api/sprint/tasks/[id]/assess/[conversationId]/workflows/route.ts` — the POST upsert endpoint.
- **Create** `__tests__/lib/workflows/normalize.test.ts` — unit tests for the helpers.
- **Create** `__tests__/api/sprint/tasks/assess-workflows-post.test.ts` — endpoint tests.
- **Modify** `app/sprint/page.tsx` — registry-name state + fetch, and the Add/Update button in the two render sites (run-history recap ~line 1272, scoring_review panel ~line 1633).

**Testing strategy:** The risky logic (OR-merge, catch-23505 fallback, best-effort junction, case-insensitive match) lives in the helper + endpoint and is covered by Jest unit tests (TDD). The `app/sprint/page.tsx` changes are straightforward state wiring on a very large existing page with no RTL harness; they are verified by `typecheck` + `lint` + `build` + a manual browser check (Task 5). This matches how the rest of that page is maintained.

---

## Task 1: Shared name-normalization helper

**Files:**
- Create: `lib/workflows/normalize.ts`
- Test: `__tests__/lib/workflows/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/lib/workflows/normalize.test.ts`:

```ts
import { normalizeWorkflowName, escapeLikePattern } from '@/lib/workflows/normalize'

describe('normalizeWorkflowName', () => {
  it('lowercases and trims', () => {
    expect(normalizeWorkflowName('  Idea Creation  ')).toBe('idea creation')
  })
  it('treats case variants as equal', () => {
    expect(normalizeWorkflowName('IDEA CREATION')).toBe(normalizeWorkflowName('idea creation'))
  })
})

describe('escapeLikePattern', () => {
  it('escapes LIKE wildcards and backslash', () => {
    expect(escapeLikePattern('50%_off\\x')).toBe('50\\%\\_off\\\\x')
  })
  it('leaves ordinary names untouched', () => {
    expect(escapeLikePattern('Assign Actor Avatar to Idea')).toBe('Assign Actor Avatar to Idea')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/lib/workflows/normalize.test.ts`
Expected: FAIL — `Cannot find module '@/lib/workflows/normalize'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/workflows/normalize.ts`:

```ts
// lib/workflows/normalize.ts

/** Canonical form for case-insensitive workflow-name comparison. */
export function normalizeWorkflowName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Escape a value so it matches literally inside a Postgres LIKE/ILIKE pattern.
 * Backslash is the default escape char, so escape it first, then the wildcards.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/lib/workflows/normalize.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/workflows/normalize.ts __tests__/lib/workflows/normalize.test.ts
git commit -m "feat(workflows): shared name normalization + LIKE-escape helpers"
```

---

## Task 2: Workflow upsert endpoint

**Files:**
- Create: `app/api/sprint/tasks/[id]/assess/[conversationId]/workflows/route.ts`
- Test: `__tests__/api/sprint/tasks/assess-workflows-post.test.ts`

The endpoint upserts one workflow. Supabase call sequence:
1. `from('workflows_registry').select('id, name, sop_impacted, education_impacted, scribehow_impacted').ilike('name', <escaped>)` → existing rows (case-insensitive).
2a. If a normalized match exists → `from('workflows_registry').update({...merged}).eq('id', id).select('id, name, sop_impacted, education_impacted, scribehow_impacted').single()`.
2b. If none → `from('workflows_registry').insert({...}).select('id, name, sop_impacted, education_impacted, scribehow_impacted').single()`. On error code `23505`, re-run the select (step 1) and update instead.
3. Junction (best-effort, non-fatal): `from('assessment_workflows').insert({ assessment_id, workflow_id })`; ignore code `23505`; on any other error, log and continue.

- [ ] **Step 1: Write the failing test**

Create `__tests__/api/sprint/tasks/assess-workflows-post.test.ts`:

```ts
// __tests__/api/sprint/tasks/assess-workflows-post.test.ts

const mockFrom = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({ from: mockFrom }),
}))
jest.mock('@/lib/auth', () => ({
  auth: jest.fn().mockResolvedValue({ user: { email: 'pm@viscap.ai' } }),
}))

import { POST } from '@/app/api/sprint/tasks/[id]/assess/[conversationId]/workflows/route'
import { NextRequest } from 'next/server'

function makeParams(id = 'task-1', conversationId = 'conv-1') {
  return { params: Promise.resolve({ id, conversationId }) }
}

function makeRequest(body: unknown, taskId = 'task-1', convId = 'conv-1') {
  return new NextRequest(
    `http://localhost/api/sprint/tasks/${taskId}/assess/${convId}/workflows`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  )
}

// Registry SELECT ... .ilike('name', x) → { data, error }
function mockSelect(rows: unknown[], error: unknown = null) {
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({
      ilike: jest.fn().mockResolvedValue({ data: rows, error }),
    }),
  })
}

// INSERT ... .select(...).single() → { data, error }
function mockInsertRegistry(data: unknown, error: unknown = null) {
  mockFrom.mockReturnValueOnce({
    insert: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({ data, error }),
      }),
    }),
  })
}

// UPDATE ... .eq('id', x).select(...).single() → { data, error }
function mockUpdateRegistry(data: unknown, error: unknown = null) {
  mockFrom.mockReturnValueOnce({
    update: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({ data, error }),
        }),
      }),
    }),
  })
}

// Junction INSERT → { error }
function mockJunctionInsert(error: unknown = null) {
  mockFrom.mockReturnValueOnce({
    insert: jest.fn().mockResolvedValue({ error }),
  })
}

const body = { name: 'Assign Actor Avatar to Idea', sopImpacted: true, educationImpacted: false, scribehowImpacted: false }

describe('POST /api/sprint/tasks/[id]/assess/[conversationId]/workflows', () => {
  beforeEach(() => { mockFrom.mockReset() })

  it('returns 401 when no session', async () => {
    const { auth } = await import('@/lib/auth')
    ;(auth as jest.Mock).mockResolvedValueOnce(null)
    const res = await POST(makeRequest(body), makeParams())
    expect(res.status).toBe(401)
  })

  it('returns 400 when name is blank', async () => {
    const res = await POST(makeRequest({ ...body, name: '   ' }), makeParams())
    expect(res.status).toBe(400)
  })

  it('creates a new workflow and links it', async () => {
    mockSelect([])                       // no existing match
    mockInsertRegistry({ id: 'wf-1', name: body.name, sop_impacted: true, education_impacted: false, scribehow_impacted: false })
    mockJunctionInsert()                 // link ok
    const res = await POST(makeRequest(body), makeParams())
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.action).toBe('created')
    expect(json.workflow.id).toBe('wf-1')
  })

  it('OR-merges flags on an existing workflow (never clears)', async () => {
    // existing has sop true; incoming sop false → stays true
    mockSelect([{ id: 'wf-1', name: 'Assign Actor Avatar to Idea', sop_impacted: true, education_impacted: false, scribehow_impacted: false }])
    let captured: Record<string, unknown> = {}
    mockFrom.mockReturnValueOnce({
      update: jest.fn().mockImplementation((patch: Record<string, unknown>) => {
        captured = patch
        return {
          eq: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: { id: 'wf-1', name: 'Assign Actor Avatar to Idea', sop_impacted: true, education_impacted: true, scribehow_impacted: false },
                error: null,
              }),
            }),
          }),
        }
      }),
    })
    mockJunctionInsert()
    const res = await POST(makeRequest({ ...body, sopImpacted: false, educationImpacted: true }), makeParams())
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.action).toBe('updated')
    expect(captured.sop_impacted).toBe(true)        // union: was true, stays true
    expect(captured.education_impacted).toBe(true)  // union: false OR true
  })

  it('matches case-insensitively (no duplicate row)', async () => {
    mockSelect([{ id: 'wf-1', name: 'Idea Creation', sop_impacted: false, education_impacted: false, scribehow_impacted: false }])
    mockUpdateRegistry({ id: 'wf-1', name: 'Idea Creation', sop_impacted: false, education_impacted: false, scribehow_impacted: false })
    mockJunctionInsert()
    const res = await POST(makeRequest({ ...body, name: 'idea creation' }), makeParams())
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.action).toBe('updated')
  })

  it('falls back to update when insert hits 23505 (create race)', async () => {
    mockSelect([])                                   // first lookup: none
    mockInsertRegistry(null, { code: '23505', message: 'duplicate key' })
    mockSelect([{ id: 'wf-1', name: body.name, sop_impacted: false, education_impacted: false, scribehow_impacted: false }]) // re-lookup finds it
    mockUpdateRegistry({ id: 'wf-1', name: body.name, sop_impacted: true, education_impacted: false, scribehow_impacted: false })
    mockJunctionInsert()
    const res = await POST(makeRequest(body), makeParams())
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.action).toBe('updated')
  })

  it('still succeeds when the junction link fails', async () => {
    mockSelect([])
    mockInsertRegistry({ id: 'wf-1', name: body.name, sop_impacted: true, education_impacted: false, scribehow_impacted: false })
    mockJunctionInsert({ code: '500', message: 'link boom' }) // non-fatal
    const res = await POST(makeRequest(body), makeParams())
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.workflow.id).toBe('wf-1')
  })

  it('returns 500 when the registry insert fails for a non-conflict reason', async () => {
    mockSelect([])
    mockInsertRegistry(null, { code: '42883', message: 'boom' })
    const res = await POST(makeRequest(body), makeParams())
    expect(res.status).toBe(500)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/api/sprint/tasks/assess-workflows-post.test.ts`
Expected: FAIL — cannot find module `.../workflows/route`.

- [ ] **Step 3: Write minimal implementation**

Create `app/api/sprint/tasks/[id]/assess/[conversationId]/workflows/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { normalizeWorkflowName, escapeLikePattern } from '@/lib/workflows/normalize'

type RegistryRow = {
  id: string
  name: string
  sop_impacted: boolean
  education_impacted: boolean
  scribehow_impacted: boolean
}

const REGISTRY_FIELDS = 'id, name, sop_impacted, education_impacted, scribehow_impacted'

// POST /api/sprint/tasks/[id]/assess/[conversationId]/workflows
// Upsert one affected workflow into workflows_registry and link it to the assessment.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; conversationId: string }> }
) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { conversationId } = await params
  const bodyJson = await request.json()
  const { name, sopImpacted, educationImpacted, scribehowImpacted } = bodyJson as {
    name?: unknown
    sopImpacted?: unknown
    educationImpacted?: unknown
    scribehowImpacted?: unknown
  }

  if (typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'Workflow name is required' }, { status: 400 })
  }

  const trimmedName = name.trim()
  const normalized = normalizeWorkflowName(trimmedName)
  const incoming = {
    sop: sopImpacted === true,
    education: educationImpacted === true,
    scribehow: scribehowImpacted === true,
  }
  const supabase = await getSupabaseServiceClient()

  // Case-insensitive lookup (escape LIKE wildcards so the name matches literally).
  async function findExisting(): Promise<RegistryRow | null> {
    const { data, error } = await supabase
      .from('workflows_registry')
      .select(REGISTRY_FIELDS)
      .ilike('name', escapeLikePattern(trimmedName))
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as RegistryRow[]
    return rows.find((r) => normalizeWorkflowName(r.name) === normalized) ?? null
  }

  // OR-merge the incoming impact flags onto an existing row (never clears a flag).
  async function updateFlags(row: RegistryRow): Promise<RegistryRow> {
    const { data, error } = await supabase
      .from('workflows_registry')
      .update({
        sop_impacted: row.sop_impacted || incoming.sop,
        education_impacted: row.education_impacted || incoming.education,
        scribehow_impacted: row.scribehow_impacted || incoming.scribehow,
      })
      .eq('id', row.id)
      .select(REGISTRY_FIELDS)
      .single()
    if (error || !data) throw new Error(error?.message ?? 'Update failed')
    return data as RegistryRow
  }

  let workflow: RegistryRow
  let action: 'created' | 'updated'

  try {
    const existing = await findExisting()
    if (existing) {
      workflow = await updateFlags(existing)
      action = 'updated'
    } else {
      const { data, error } = await supabase
        .from('workflows_registry')
        .insert({
          name: trimmedName,
          sop_impacted: incoming.sop,
          education_impacted: incoming.education,
          scribehow_impacted: incoming.scribehow,
        })
        .select(REGISTRY_FIELDS)
        .single()

      if (error) {
        // Concurrent create (or a dup the case-insensitive lookup missed): re-find and update.
        if (error.code === '23505') {
          const raced = await findExisting()
          if (!raced) return NextResponse.json({ error: error.message }, { status: 500 })
          workflow = await updateFlags(raced)
          action = 'updated'
        } else {
          return NextResponse.json({ error: error.message }, { status: 500 })
        }
      } else {
        workflow = data as RegistryRow
        action = 'created'
      }
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Upsert failed' }, { status: 500 })
  }

  // Best-effort link: the registry row (what /workflows reads) already landed.
  const { error: linkError } = await supabase
    .from('assessment_workflows')
    .insert({ assessment_id: conversationId, workflow_id: workflow.id })
  if (linkError && linkError.code !== '23505') {
    console.error('[assess/workflows] junction link failed (non-fatal):', linkError.message)
  }

  return NextResponse.json({ workflow, action })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/api/sprint/tasks/assess-workflows-post.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add "app/api/sprint/tasks/[id]/assess/[conversationId]/workflows/route.ts" __tests__/api/sprint/tasks/assess-workflows-post.test.ts
git commit -m "feat(assess): endpoint to upsert affected workflow into registry"
```

---

## Task 3: Frontend — registry-name state + fetch

**Files:**
- Modify: `app/sprint/page.tsx`

Add state for the set of existing registry names (normalized) and in-flight names, and load the set when a task's assessment history loads.

- [ ] **Step 1: Add state and import the normalizer**

In `app/sprint/page.tsx`, add to the imports near `import { apiFetch } from '@/lib/fetch'`:

```ts
import { normalizeWorkflowName } from '@/lib/workflows/normalize'
```

In the "Assessment history state" block (just after `const [showArchived, setShowArchived] = useState(false)` ~line 300), add:

```ts
  // Names currently present in workflows_registry (normalized), for Add-vs-Update.
  const [registryWorkflowNames, setRegistryWorkflowNames] = useState<Set<string>>(new Set())
  // Workflow names with an in-flight Add/Update request (raw names).
  const [syncingWorkflows, setSyncingWorkflows] = useState<Set<string>>(new Set())
```

- [ ] **Step 2: Add the fetch function**

Immediately after the `loadAssessHistory` function (ends ~line 353), add:

```ts
  async function loadRegistryWorkflowNames() {
    try {
      const res = await apiFetch('/api/workflows?summary=true')
      const data = await res.json()
      const names: string[] = (data.workflows ?? []).map((w: { name: string }) => normalizeWorkflowName(w.name))
      setRegistryWorkflowNames(new Set(names))
    } catch (err) {
      console.error('[loadRegistryWorkflowNames] fetch failed', err)
    }
  }
```

- [ ] **Step 3: Call it when a task detail opens**

Find the call `void loadAssessHistory(task.id)` (~line 366) and add the registry fetch alongside it:

```ts
    void loadAssessHistory(task.id)
    void loadRegistryWorkflowNames()
```

- [ ] **Step 4: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS (no new errors).

- [ ] **Step 5: Commit**

```bash
git add app/sprint/page.tsx
git commit -m "feat(sprint): load existing workflow-registry names for Add/Update state"
```

---

## Task 4: Frontend — Add/Update handler + buttons

**Files:**
- Modify: `app/sprint/page.tsx`

Add one handler and render an Add/Update button per affected workflow in both list sites.

- [ ] **Step 1: Add the sync handler**

After `loadRegistryWorkflowNames` (from Task 3), add. `AffectedWorkflow` is the type already imported inline elsewhere on this page; reference it the same way:

```ts
  async function syncWorkflowToRegistry(
    conversationId: string,
    workflow: import('@/lib/assessment-types').AffectedWorkflow
  ) {
    const key = normalizeWorkflowName(workflow.name)
    const wasPresent = registryWorkflowNames.has(key)
    setSyncingWorkflows((prev) => new Set(prev).add(workflow.name))
    setAssessError('')
    // Optimistic: show it as "in registry" immediately.
    setRegistryWorkflowNames((prev) => new Set(prev).add(key))
    try {
      const res = await apiFetch(
        `/api/sprint/tasks/${detailTask!.id}/assess/${conversationId}/workflows`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: workflow.name,
            sopImpacted: workflow.sopImpacted,
            educationImpacted: workflow.educationImpacted,
            scribehowImpacted: workflow.scribehowImpacted,
          }),
        }
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to sync workflow')
    } catch (e) {
      // Revert only if this click was the one that added it.
      if (!wasPresent) {
        setRegistryWorkflowNames((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
      setAssessError(e instanceof Error ? e.message : 'Failed to sync workflow')
    } finally {
      setSyncingWorkflows((prev) => {
        const next = new Set(prev)
        next.delete(workflow.name)
        return next
      })
    }
  }
```

- [ ] **Step 2: Add a small render helper for the button**

Just above the component's `return (` (search for the top-level `return (` of `SprintPage`, or place it right after the handlers), add a helper that renders the correct button for a workflow:

```ts
  function renderWorkflowSyncButton(
    conversationId: string,
    workflow: import('@/lib/assessment-types').AffectedWorkflow
  ) {
    const inRegistry = registryWorkflowNames.has(normalizeWorkflowName(workflow.name))
    const busy = syncingWorkflows.has(workflow.name)
    return (
      <Button
        size="small"
        type={inRegistry ? 'default' : 'primary'}
        loading={busy}
        onClick={(e) => { e.stopPropagation(); void syncWorkflowToRegistry(conversationId, workflow) }}
        style={{ fontSize: 11 }}
      >
        {inRegistry ? 'Update' : '+ Add'}
      </Button>
    )
  }
```

- [ ] **Step 3: Wire the button into the run-history recap**

Find the run-history `WORKFLOWS` block (~line 1272-1283). Replace the `<Tag>` mapping so each row shows the name, the ✦/in-registry cue, and the button:

```tsx
                              {run.affectedWorkflows.length > 0 && (
                                <div style={{ marginTop: 10 }}>
                                  <Typography.Text style={{ color: '#8b949e', fontSize: 10 }}>WORKFLOWS</Typography.Text>
                                  <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
                                    {run.affectedWorkflows.map((w) => {
                                      const inRegistry = registryWorkflowNames.has(normalizeWorkflowName(w.name))
                                      return (
                                        <div key={w.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                          <Tag style={{ fontSize: 11, margin: 0 }}>
                                            {w.name}{w.registryStatus === 'proposed' ? ' ✦' : ''}
                                          </Tag>
                                          {inRegistry && <Tag color="green" style={{ fontSize: 10, margin: 0 }}>in registry</Tag>}
                                          {renderWorkflowSyncButton(run.conversationId, w)}
                                        </div>
                                      )
                                    })}
                                  </div>
                                </div>
                              )}
```

- [ ] **Step 4: Wire the button into the scoring_review panel**

Find the `AFFECTED WORKFLOWS` block (~line 1629-1644). Add the in-registry cue and button inside each workflow row, after the existing impact tags:

```tsx
                  {conversation.affectedWorkflows.map((w) => (
                    <div key={w.name} style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 4, padding: '6px 8px', marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <Typography.Text style={{ color: '#e6edf3', fontSize: 12, fontWeight: 600 }}>{w.name}</Typography.Text>
                      {w.registryStatus === 'proposed' && <Tag color="orange" style={{ fontSize: 10 }}>proposed</Tag>}
                      {w.sopImpacted && <Tag color="blue" style={{ fontSize: 10 }}>SOP</Tag>}
                      {w.educationImpacted && <Tag color="purple" style={{ fontSize: 10 }}>Education</Tag>}
                      {w.scribehowImpacted && <Tag color="cyan" style={{ fontSize: 10 }}>ScribeHow</Tag>}
                      {registryWorkflowNames.has(normalizeWorkflowName(w.name)) && <Tag color="green" style={{ fontSize: 10 }}>in registry</Tag>}
                      <span style={{ marginLeft: 'auto' }}>{renderWorkflowSyncButton(conversation.conversationId, w)}</span>
                    </div>
                  ))}
```

- [ ] **Step 5: Verify typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS (no new errors/warnings in `app/sprint/page.tsx`).

- [ ] **Step 6: Commit**

```bash
git add app/sprint/page.tsx
git commit -m "feat(sprint): Add/Update workflow-to-registry buttons in assessment views"
```

---

## Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS, including the new `normalize` and `assess-workflows-post` suites.

- [ ] **Step 2: Typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all succeed.

- [ ] **Step 3: Manual browser check**

Run `npm run dev`, open a task with a completed assessment (e.g. "Actor Avatar"), expand its run in the assessment history, and confirm:
- Each workflow shows `+ Add` (if not yet in the registry) or `Update` + a green "in registry" tag.
- Clicking `+ Add` flips the row to `Update` + "in registry" immediately (optimistic), and the workflow now appears on `/workflows`.
- Clicking `Update` on an existing workflow succeeds; impact flags on `/workflows` only ever turn on, never off.
- A forced failure (e.g. offline) reverts an `+ Add` row and surfaces the error in the assessment error Alert.

- [ ] **Step 4: Final commit (if any doc/notes changed)**

```bash
git add -A
git commit -m "chore: verification notes for workflow-registry sync" --allow-empty
```

---

## Self-Review Notes

- **Spec coverage:** endpoint behavior 1-7 → Task 2; OR-merge → Task 2 test "OR-merges flags"; catch-23505 → Task 2 test "falls back to update"; best-effort junction → Task 2 test "still succeeds when junction fails"; case-insensitive match → Task 1 + Task 2 test; frontend Add/Update + optimistic + both render sites → Tasks 3-4; testing list → Tasks 1-2 + Task 5 manual. Covered.
- **Type consistency:** `RegistryRow`, `REGISTRY_FIELDS`, `normalizeWorkflowName`, `escapeLikePattern`, `syncWorkflowToRegistry`, `renderWorkflowSyncButton`, `registryWorkflowNames`, `syncingWorkflows` are named identically across all tasks.
- **No migration:** confirmed — `workflows_registry` and `assessment_workflows` exist from migration 025.

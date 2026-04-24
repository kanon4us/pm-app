# Assessment History Design

**Date:** 2026-04-23
**Status:** Revised v2 — resolves Resume stub, abandoned run visibility, FVI badge sync, and workflow hint.

## Goal

Let the team review past FVI assessment results without reopening the assessment modal. Completed assessments are shown inline in the task detail drawer — newest run fully expanded, older runs collapsed — with the ability to archive completed runs and toggle archived visibility.

## Scope

- Assessment history section in the task detail drawer (below FVI badge, above ClickUp fields)
- In-progress run indicator (passive — no Resume button yet; see deferred section)
- "Previous workflows" hint shown during assessment init so PMs can catch workflow tag drift manually
- Archive/unarchive a completed run
- "Show Archived" toggle in the history header
- DB migration to add `is_archived` flag

**Explicit design decisions:**
- **FVI badge** always reflects `tasks.fvi_score` (the last confirmed score). Archiving history runs does not change it.
- **Abandoned runs** are never shown in history — not even when "Show Archived" is on. They are noise, not data.
- **Resume button** is NOT included in this plan. An in-progress run is shown as a passive indicator only. Full resume requires a dedicated `GET .../resume` route — deferred to the next plan.

**Out of scope (future iteration):**
- Resume assessment: restore conversation state from an in-progress run (next plan).
- Workflow removal justification: automated gate when tags are dropped between runs (deferred until usage data).
- Pagination: expect 3–4 runs per task; full list fetch is sufficient.
- Side-by-side run comparison diff view.
- Hard delete of assessment runs (archive is sufficient; hard delete is irreversible).

---

## Architecture

Three layers of change:

1. **DB migration** — adds `is_archived` to `assessment_conversations`
2. **Two new API routes** — `GET history` (all runs) and `PATCH archive`
3. **Frontend** — new state + types + `loadAssessHistory()` + `archiveRun()` + history UI block + extracted `AssessmentButton` component

---

## 1. Database Migration

**File:** `supabase/migrations/009_assessment_is_archived.sql`

```sql
-- supabase/migrations/009_assessment_is_archived.sql
alter table assessment_conversations
  add column if not exists is_archived boolean not null default false;

comment on column assessment_conversations.is_archived
  is 'When true, this run is hidden from the default history view. Set by PM via the drawer UI.';

create index if not exists idx_assessment_conversations_history
  on assessment_conversations(task_id, created_at desc);
```

Apply via: `npx supabase db query --linked < supabase/migrations/009_assessment_is_archived.sql`

**Supabase types update** (`lib/supabase/types.ts`):
- Add `is_archived: boolean` to `assessment_conversations.Row`
- Add `is_archived?: boolean` to `assessment_conversations.Insert` and `Update`
- Add `affected_workflows: Json | null` to `assessment_conversations.Row` and `Update` (migration 008 added this column but types were not regenerated)

---

## 2. API Routes

### GET `/api/sprint/tasks/[id]/assess/history`

**File:** `app/api/sprint/tasks/[id]/assess/history/route.ts`

Auth: `auth()` session check + `users` table lookup (same pattern as init/reply routes).

**Returns ALL conversations for the task** — including `in_progress` and `is_archived` runs. The frontend is responsible for filtering by `status` and `is_archived`. This enables:
- Resume detection: frontend checks for any `in_progress` run
- Archived toggle: frontend filters by `is_archived` based on `showArchived` state

Query:
```sql
SELECT
  ac.id, ac.task_id, ac.status, ac.fvi_score, ac.effort, ac.risk,
  ac.final_scores, ac.affected_workflows, ac.completed_at, ac.created_at,
  ac.is_archived,
  cra.id as cra_id, cra.role_id, cra.usage_frequency,
  cra.claude_proposed_frequency, cra.user_override_frequency,
  cra.claude_reasoning, cra.user_reasoning,
  rr.role_name, rr.team_domain, rr.influence_type, rr.weight
FROM assessment_conversations ac
LEFT JOIN conversation_role_assessments cra ON cra.conversation_id = ac.id
LEFT JOIN role_registry rr ON rr.id = cra.role_id
WHERE ac.task_id = $1
ORDER BY ac.created_at DESC
```

Shape returned (grouped by conversation, rows collapsed per conversation):
```typescript
{
  runs: Array<{
    conversationId: string
    status: 'in_progress' | 'complete' | 'abandoned'
    isArchived: boolean
    fviScore: number | null           // null for in_progress runs
    effort: number | null
    risk: number | null
    riskLevel: string                 // derived from risk multiplier (see below)
    completedAt: string | null
    createdAt: string
    finalScores: Array<{
      objectiveId: number
      objectiveName: string
      objectiveOwner: string
      score: number
      reasoning: string
    }>
    affectedWorkflows: Array<{
      name: string                    // only name is displayed; impact flags stored but not surfaced in history UI
      sopImpacted: boolean
      educationImpacted: boolean
      scribehowImpacted: boolean
      registryStatus: 'existing' | 'proposed'
    }>
    roles: Array<{
      roleId: string
      roleName: string
      teamDomain: string
      influenceType: 'DM' | 'NDM'
      weight: number
      usageFrequency: number          // active value: userOverrideFrequency ?? claudeProposedFrequency ?? usage_frequency
      claudeProposedFrequency: number | null
      claudeReasoning: string | null
      userOverrideFrequency: number | null
      userReasoning: string | null
      isUserOverride: boolean         // userOverrideFrequency !== null
    }>
  }>
}
```

`riskLevel` derivation from `risk` multiplier:
- `1.0` → `'Routine'`
- `1.2` → `'Standard'`
- `1.5` → `'Moderate'`
- `2.0` → `'High'`
- `3.0` → `'Critical'`
- anything else → `'Unknown'`

**Error handling:**
- 401 if no session
- 404 if user not in `users` table
- 200 with `{ runs: [] }` if no conversations exist

---

### PATCH `/api/sprint/tasks/[id]/assess/history/[conversationId]`

**File:** `app/api/sprint/tasks/[id]/assess/history/[conversationId]/route.ts`

Body: `{ isArchived: boolean }`

Auth: same pattern. Verify conversation belongs to the task (`task_id = id`) before updating.

Action:
```sql
UPDATE assessment_conversations
SET is_archived = $1
WHERE id = $2 AND task_id = $3
```

Returns: `{ ok: true }` on success, 404 if conversation not found or doesn't belong to task.

---

## 3. Frontend

### New Types (`app/sprint/page.tsx`)

```typescript
interface AssessHistoryRole {
  roleId: string
  roleName: string
  teamDomain: string
  influenceType: 'DM' | 'NDM'
  weight: number
  usageFrequency: number          // active: userOverrideFrequency ?? claudeProposedFrequency ?? usage_frequency
  claudeProposedFrequency: number | null
  claudeReasoning: string | null
  userOverrideFrequency: number | null
  userReasoning: string | null
  isUserOverride: boolean
}

interface AssessHistoryRun {
  conversationId: string
  status: 'in_progress' | 'complete' | 'abandoned'
  isArchived: boolean
  fviScore: number | null
  effort: number | null
  risk: number | null
  riskLevel: string
  completedAt: string | null
  createdAt: string
  finalScores: Array<{
    objectiveId: number
    objectiveName: string
    objectiveOwner: string
    score: number
    reasoning: string
  }>
  affectedWorkflows: import('@/lib/assessment-types').AffectedWorkflow[]
  roles: AssessHistoryRole[]
}
```

### New State Variables

```typescript
const detailTaskRef = useRef<Task | null>(null)  // tracks current detailTask for async race protection

const [assessHistory, setAssessHistory] = useState<AssessHistoryRun[] | null>(null)
const [assessHistoryLoading, setAssessHistoryLoading] = useState(false)
const [expandedHistoryRuns, setExpandedHistoryRuns] = useState<Set<string>>(new Set())
const [showArchived, setShowArchived] = useState(false)
```

`detailTaskRef` must be kept in sync with `detailTask`. Add a `useEffect`:
```typescript
useEffect(() => { detailTaskRef.current = detailTask }, [detailTask])
```

`expandedHistoryRuns` holds the `conversationId`s of expanded runs. On load, the newest completed run's ID is added automatically.

### `loadAssessHistory(taskId: string)` function

```typescript
async function loadAssessHistory(taskId: string) {
  setAssessHistoryLoading(true)
  try {
    const res = await apiFetch(`/api/sprint/tasks/${taskId}/assess/history`)
    const data = await res.json()
    // Race condition check: only update state if the drawer is still showing the same task
    if (res.ok && detailTaskRef.current?.id === taskId) {
      const runs: AssessHistoryRun[] = data.runs ?? []
      setAssessHistory(runs)
      // Auto-expand the newest unarchived complete run only.
      // If the newest complete run is archived (or all are archived), start fully collapsed.
      const newestUnarchived = runs.find((r) => r.status === 'complete' && !r.isArchived)
      if (newestUnarchived) {
        setExpandedHistoryRuns(new Set([newestUnarchived.conversationId]))
      }
    }
  } catch (err) {
    console.error('[loadAssessHistory] fetch failed', err)
    // Non-fatal: history section shows empty state
  } finally {
    setAssessHistoryLoading(false)
  }
}
```

### `openDetail()` change

```typescript
async function openDetail(task: Task) {
  setDetailTask(task)
  detailTaskRef.current = task          // sync ref immediately (before async operations)
  setEditedFields(task.custom_fields ? [...task.custom_fields] : [])
  setSaveSuccess(false)
  setDescription('')
  setDescLoading(true)
  setAssessHistory(null)                // reset history
  setExpandedHistoryRuns(new Set())     // reset expanded state
  setShowArchived(false)                // reset archived toggle
  void loadAssessHistory(task.id)       // fire in parallel (non-blocking)
  try {
    const res = await apiFetch(`/api/sprint/tasks/${task.id}`)
    // ... rest unchanged
  }
}
```

Drawer `onClose`:
```typescript
onClose={() => {
  setDetailTask(null)
  detailTaskRef.current = null
  setAssessHistory(null)
  setExpandedHistoryRuns(new Set())
  setShowArchived(false)
}}
```

### `archiveRun(conversationId: string)` function

```typescript
async function archiveRun(conversationId: string) {
  if (!detailTask) return
  await apiFetch(`/api/sprint/tasks/${detailTask.id}/assess/history/${conversationId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isArchived: true }),
  })
  // Optimistic update: mark as archived in local state
  setAssessHistory((prev) =>
    prev?.map((r) => r.conversationId === conversationId ? { ...r, isArchived: true } : r) ?? null
  )
  setExpandedHistoryRuns((prev) => {
    const next = new Set(prev)
    next.delete(conversationId)
    return next
  })
}
```

Note: uses optimistic update (marks archived in local state immediately) rather than removing from list, so the "Show Archived" toggle can reveal it without a re-fetch.

### `AssessmentButton` component

**File:** `app/sprint/components/AssessmentButton.tsx`

Extracted component for the primary assessment action button. In this plan, the button always shows "Run Assessment" (or is disabled while history loads). An in-progress run is surfaced as a separate passive indicator — the Resume button is deferred to the next plan.

```typescript
// app/sprint/components/AssessmentButton.tsx

interface AssessmentButtonProps {
  historyLoading: boolean
  onRunNew: () => void
}

export function AssessmentButton({ historyLoading, onRunNew }: AssessmentButtonProps) {
  return (
    <Button type="primary" size="small" disabled={historyLoading} onClick={onRunNew}>
      Run Assessment
    </Button>
  )
}
```

The in-progress indicator (shown in the history section when `inProgressRun` is non-null):

```tsx
{inProgressRun && (
  <div style={{ background: '#161b22', border: '1px solid #f0883e', borderRadius: 6, padding: '8px 10px', marginTop: 8 }}>
    <Typography.Text style={{ color: '#f0883e', fontSize: 11 }}>
      ⚠ An assessment is in progress (started {new Date(inProgressRun.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}). Resume capability coming soon.
    </Typography.Text>
  </div>
)}
```

### "Previous workflows" hint in the assessment modal

When `assessHistory` has at least one completed run with non-empty `affectedWorkflows`, and the assessment modal is in `'interview'` phase, show a collapsible hint at the top of the interview section:

```tsx
{assessPhase === 'interview' && conversation && (() => {
  const prevWorkflows = assessHistory
    ?.find((r) => r.status === 'complete')
    ?.affectedWorkflows ?? []
  if (prevWorkflows.length === 0) return null
  return (
    <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 6, padding: '8px 10px', marginBottom: 10 }}>
      <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>
        PREVIOUS RUN WORKFLOWS — review for accuracy
      </Typography.Text>
      <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {prevWorkflows.map((w) => (
          <Tag key={w.name} style={{ fontSize: 11 }}>{w.name}</Tag>
        ))}
      </div>
    </div>
  )
})()}
```

This gives the PM visibility into what workflows the previous run identified, so they can notice if Claude drops any in the new run. No automated enforcement — manual review only in this iteration.

### History UI Block

Inserted in the task detail drawer **below the FVI score / AssessmentButton area, above the ClickUp custom fields section**.

**Filtering logic (computed from state):**
```typescript
const visibleHistory = (assessHistory ?? []).filter((r) =>
  r.status === 'complete' && (showArchived || !r.isArchived)
)
const inProgressRun = (assessHistory ?? []).find((r) => r.status === 'in_progress')
```

- `visibleHistory`: only `complete` runs; includes archived when toggle is on
- `inProgressRun`: first in-progress run, used to show a passive indicator only
- `abandoned` runs: never shown, excluded from both lists

**Structure:**

```tsx
{/* ── Assessment History ── */}
<div style={{ marginTop: 16 }}>

  {/* Section header with Show Archived toggle */}
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
    <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>ASSESSMENT HISTORY</Typography.Text>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Typography.Text style={{ color: '#8b949e', fontSize: 10 }}>Show Archived</Typography.Text>
      <Switch size="small" checked={showArchived} onChange={setShowArchived} />
    </div>
  </div>

  {assessHistoryLoading && <Spin size="small" style={{ marginTop: 8 }} />}

  {!assessHistoryLoading && (() => {
    const allComplete = (assessHistory ?? []).filter((r) => r.status === 'complete')
    const hasHiddenArchived = allComplete.length > 0 && visibleHistory.length === 0 && !showArchived
    const noRunsAtAll = allComplete.length === 0

    if (noRunsAtAll) return (
      <Typography.Text style={{ color: '#484f58', fontSize: 12, display: 'block', marginTop: 6 }}>
        No assessments yet — run one to see history here.
      </Typography.Text>
    )
    if (hasHiddenArchived) return (
      <Typography.Text style={{ color: '#484f58', fontSize: 12, display: 'block', marginTop: 6 }}>
        All assessments archived — toggle &quot;Show Archived&quot; to view them.
      </Typography.Text>
    )
    return null
  })()}

  {!assessHistoryLoading && visibleHistory.map((run) => {
    const isExpanded = expandedHistoryRuns.has(run.conversationId)
    const agencyDM = run.roles.filter((r) => r.teamDomain === 'agency' && r.influenceType === 'DM' && r.usageFrequency > 0)
    const agencyNDM = run.roles.filter((r) => r.teamDomain === 'agency' && r.influenceType === 'NDM' && r.usageFrequency > 0)
    const brandDM = run.roles.filter((r) => r.teamDomain === 'brand' && r.influenceType === 'DM' && r.usageFrequency > 0)
    const brandNDM = run.roles.filter((r) => r.teamDomain === 'brand' && r.influenceType === 'NDM' && r.usageFrequency > 0)
    const roleGroups = [
      { label: 'Agency — Decision Makers', roles: agencyDM },
      { label: 'Agency — Non-Decision Makers', roles: agencyNDM },
      { label: 'Brand — Decision Makers', roles: brandDM },
      { label: 'Brand — Non-Decision Makers', roles: brandNDM },
    ].filter((g) => g.roles.length > 0)

    return (
      <div key={run.conversationId}
        style={{ border: `1px solid ${run.isArchived ? '#21262d' : '#30363d'}`, borderRadius: 6, marginTop: 8, opacity: run.isArchived ? 0.6 : 1 }}>

        {/* Header row */}
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer' }}
          onClick={() => setExpandedHistoryRuns((prev) => {
            const next = new Set(prev)
            isExpanded ? next.delete(run.conversationId) : next.add(run.conversationId)
            return next
          })}
        >
          {run.fviScore != null && (
            <Tag color="blue" style={{ fontSize: 12 }}>FVI {run.fviScore.toFixed(2)}</Tag>
          )}
          <Typography.Text style={{ color: '#8b949e', fontSize: 11, flex: 1 }}>
            {new Date(run.completedAt ?? run.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </Typography.Text>
          <Tag style={{ fontSize: 11 }}>{run.riskLevel}</Tag>
          {run.effort != null && (
            <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>{run.effort}d</Typography.Text>
          )}
          {run.isArchived && <Tag style={{ fontSize: 10 }}>archived</Tag>}
          <Popconfirm
            title={run.isArchived ? 'Unarchive this run?' : 'Archive this run?'}
            onConfirm={(e) => { e?.stopPropagation(); void archiveRun(run.conversationId) }}
            onCancel={(e) => e?.stopPropagation()}
            okText={run.isArchived ? 'Unarchive' : 'Archive'}
            cancelText="Cancel"
          >
            <Button
              type="text" size="small"
              icon={run.isArchived ? <UndoOutlined /> : <DeleteOutlined />}
              style={{ color: '#484f58' }}
              onClick={(e) => e.stopPropagation()}
            />
          </Popconfirm>
          <Typography.Text style={{ color: '#484f58', fontSize: 11 }}>{isExpanded ? '▲' : '▼'}</Typography.Text>
        </div>

        {/* Expanded body */}
        {isExpanded && (
          <div style={{ padding: '0 10px 12px', borderTop: '1px solid #21262d' }}>

            {/* Affected Workflows — name only */}
            {run.affectedWorkflows.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <Typography.Text style={{ color: '#8b949e', fontSize: 10 }}>WORKFLOWS</Typography.Text>
                <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {run.affectedWorkflows.map((w) => (
                    <Tag key={w.name} style={{ fontSize: 11 }}>
                      {w.name}{w.registryStatus === 'proposed' ? ' ✦' : ''}
                    </Tag>
                  ))}
                </div>
              </div>
            )}

            {/* Objective Scores */}
            {run.finalScores.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <Typography.Text style={{ color: '#8b949e', fontSize: 10 }}>OBJECTIVES</Typography.Text>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginTop: 4 }}>
                  {run.finalScores.map((s) => (
                    <div key={s.objectiveId} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '3px 0' }}>
                      <Tag
                        color={s.score > 0 ? 'green' : s.score === 0 ? 'default' : 'red'}
                        style={{ fontSize: 10, minWidth: 28, textAlign: 'center', marginTop: 2 }}
                      >
                        {s.score > 0 ? '+' : ''}{s.score}
                      </Tag>
                      <div>
                        <Typography.Text style={{ color: '#e6edf3', fontSize: 11 }}>{s.objectiveName}</Typography.Text>
                        <Typography.Text style={{ color: '#8b949e', fontSize: 10, display: 'block' }}>{s.reasoning}</Typography.Text>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Roles — grouped, active only, override takes precedence */}
            {roleGroups.map((group) => (
              <div key={group.label} style={{ marginTop: 10 }}>
                <Typography.Text style={{ color: '#8b949e', fontSize: 10 }}>{group.label.toUpperCase()}</Typography.Text>
                <div style={{ marginTop: 4 }}>
                  {group.roles.map((r) => (
                    <div key={r.roleId} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '2px 0' }}>
                      <Tag style={{ fontSize: 10, minWidth: 20, textAlign: 'center' }}>{r.usageFrequency}</Tag>
                      <div style={{ flex: 1 }}>
                        <Typography.Text style={{ color: '#e6edf3', fontSize: 11 }}>{r.roleName}</Typography.Text>
                        {r.isUserOverride && (
                          <Tag color="orange" style={{ fontSize: 9, marginLeft: 4 }}>override</Tag>
                        )}
                        <Typography.Text style={{ color: '#8b949e', fontSize: 10, display: 'block' }}>
                          {r.isUserOverride ? r.userReasoning : r.claudeReasoning}
                        </Typography.Text>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

          </div>
        )}
      </div>
    )
  })}
</div>
```

**Display rules:**
- Workflow impact flags (SOP/Education/ScribeHow) are stored but not rendered in history — name only, with a `✦` suffix for proposed workflows
- Override reasoning takes precedence: `isUserOverride === true` → show `userReasoning`; otherwise show `claudeReasoning`
- Roles with `usageFrequency === 0` ("Cannot Access") are not shown in history
- Archived runs shown when `showArchived` is true, displayed at reduced opacity with an "archived" tag and an Undo button instead of Archive

---

## 4. Testing

### Unit tests — GET route (`__tests__/app/api/sprint/tasks/[id]/assess/history/route.test.ts`)

- Returns 401 when no session
- Returns `{ runs: [] }` when no conversations exist
- Returns all runs (complete, in_progress, archived) without filtering
- Groups role rows by conversation correctly
- Correctly derives `riskLevel` for all 5 multiplier values
- Sets `isUserOverride: true` when `user_override_frequency` is non-null
- Computes `usageFrequency` as `userOverrideFrequency ?? claudeProposedFrequency ?? usage_frequency`
- Orders runs newest first

### Unit tests — PATCH route

- Returns 404 when `conversationId` doesn't belong to the task
- Sets `is_archived = true` and returns `{ ok: true }`
- Sets `is_archived = false` (unarchive) and returns `{ ok: true }`

### Frontend

The history section and `AssessmentButton` are display components — no new unit tests required beyond the route tests. The existing 101-test suite will catch TypeScript and import errors.

---

## 5. File Summary

| File | Action |
|---|---|
| `supabase/migrations/009_assessment_is_archived.sql` | Create |
| `lib/supabase/types.ts` | Modify — add `is_archived`, `affected_workflows` to `assessment_conversations` |
| `app/api/sprint/tasks/[id]/assess/history/route.ts` | Create |
| `app/api/sprint/tasks/[id]/assess/history/[conversationId]/route.ts` | Create |
| `__tests__/app/api/sprint/tasks/[id]/assess/history/route.test.ts` | Create |
| `app/sprint/components/AssessmentButton.tsx` | Create — simple "Run Assessment" button; Resume deferred |
| `app/sprint/page.tsx` | Modify — types, state, `detailTaskRef`, `openDetail`, `loadAssessHistory`, `archiveRun`, history UI block, in-progress indicator, previous workflows hint, AssessmentButton wiring |

---

## 6. Deferred / Future Iterations

| Item | Reason deferred |
|---|---|
| Resume assessment | Needs `GET .../resume` route to restore conversation state (proposedScores + last question); build in next plan after history ships |
| Workflow removal justification | Requires comparing workflow sets across runs and gating the init call — add after real usage data shows how often tags drift |
| Side-by-side run diff view | Low value until users have 3+ runs to compare |

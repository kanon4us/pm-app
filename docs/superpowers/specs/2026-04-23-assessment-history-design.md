# Assessment History Design

**Date:** 2026-04-23

## Goal

Let the team review past FVI assessment results without reopening the assessment modal. Completed assessments are shown inline in the task detail drawer — newest run fully expanded, older runs collapsed — with the ability to archive runs that are no longer relevant.

## Scope

- Assessment history view in the task detail drawer
- Archive/unarchive a past run
- DB migration to add `is_archived` flag

**Out of scope:**
- Score non-determinism (addressed by Plan 2's Phase 1 workflow questions; revisit after real usage data)
- Deleting assessment runs (archive is sufficient; hard delete is irreversible)
- Comparing two runs side-by-side in a diff view (future iteration)

---

## Architecture

Three layers of change:

1. **DB migration** — adds `is_archived` to `assessment_conversations`
2. **Two new API routes** — `GET history` and `PATCH archive`
3. **Frontend** — new state + `AssessHistoryRun` type + history section in the task detail drawer

No new files for the DB layer (migration only). Two new route files. All frontend changes are in `app/sprint/page.tsx`.

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
  on assessment_conversations(task_id, status, is_archived, created_at desc);
```

Apply via: `npx supabase db query --linked < supabase/migrations/009_assessment_is_archived.sql`

**Supabase types update** (`lib/supabase/types.ts`): Add `is_archived: boolean` to `assessment_conversations.Row` and `is_archived?: boolean` to `Insert` and `Update`.

Also add `affected_workflows: Json | null` to `assessment_conversations.Row` (migration 008 added this column but types were not updated).

---

## 2. API Routes

### GET `/api/sprint/tasks/[id]/assess/history`

**File:** `app/api/sprint/tasks/[id]/assess/history/route.ts`

Auth: `auth()` session check + `users` table lookup (same pattern as init/reply routes).

Query:
```sql
SELECT
  ac.id, ac.task_id, ac.fvi_score, ac.effort, ac.risk,
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
  AND ac.status = 'complete'
  AND ac.is_archived = false
ORDER BY ac.created_at DESC
```

Shape returned (grouped by conversation):
```typescript
{
  runs: Array<{
    conversationId: string
    fviScore: number
    effort: number | null
    risk: number | null
    riskLevel: string          // derived: lookup risk multiplier → label
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
      name: string
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

`riskLevel` derivation: `risk` multiplier → label mapping (same as the confirm route):
- `1.0` → `'Routine'`
- `1.2` → `'Standard'`
- `1.5` → `'Moderate'`
- `2.0` → `'High'`
- `3.0` → `'Critical'`
- anything else → `'Unknown'`

**Error handling:**
- 401 if no session
- 404 if user not in `users` table
- 200 with `{ runs: [] }` if no completed conversations exist

---

### PATCH `/api/sprint/tasks/[id]/assess/history/[conversationId]`

**File:** `app/api/sprint/tasks/[id]/assess/history/[conversationId]/route.ts`

Body: `{ isArchived: boolean }`

Auth: same pattern. Additionally verify the conversation belongs to the task (`task_id = id`) before updating.

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
  usageFrequency: number          // active value: userOverrideFrequency ?? claudeProposedFrequency ?? usage_frequency
  claudeProposedFrequency: number | null
  claudeReasoning: string | null
  userOverrideFrequency: number | null
  userReasoning: string | null
  isUserOverride: boolean         // userOverrideFrequency !== null
}

interface AssessHistoryRun {
  conversationId: string
  fviScore: number
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
const [assessHistory, setAssessHistory] = useState<AssessHistoryRun[] | null>(null)
const [assessHistoryLoading, setAssessHistoryLoading] = useState(false)
const [expandedHistoryRuns, setExpandedHistoryRuns] = useState<Set<string>>(new Set())
```

`expandedHistoryRuns` holds the `conversationId`s of runs that are currently expanded. On load, the newest run's ID is added automatically.

### `loadAssessHistory(taskId: string)` function

```typescript
async function loadAssessHistory(taskId: string) {
  setAssessHistoryLoading(true)
  setAssessHistory(null)
  try {
    const res = await apiFetch(`/api/sprint/tasks/${taskId}/assess/history`)
    const data = await res.json()
    if (res.ok) {
      setAssessHistory(data.runs ?? [])
      // Auto-expand the newest run
      if (data.runs?.length > 0) {
        setExpandedHistoryRuns(new Set([data.runs[0].conversationId]))
      }
    }
  } catch { /* non-fatal — history section shows error state */ }
  setAssessHistoryLoading(false)
}
```

### `openDetail()` change

Add `loadAssessHistory(task.id)` call inside `openDetail()`, alongside the existing description fetch:

```typescript
async function openDetail(task: Task) {
  setDetailTask(task)
  setEditedFields(task.custom_fields ? [...task.custom_fields] : [])
  setSaveSuccess(false)
  setDescription('')
  setDescLoading(true)
  setAssessHistory(null)               // ← reset history
  setExpandedHistoryRuns(new Set())    // ← reset expanded state
  void loadAssessHistory(task.id)      // ← fire in parallel (non-blocking)
  try {
    const res = await apiFetch(`/api/sprint/tasks/${task.id}`)
    // ... rest unchanged
  }
}
```

Also reset history state when the drawer closes:

```typescript
onClose={() => {
  setDetailTask(null)
  setAssessHistory(null)
  setExpandedHistoryRuns(new Set())
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
  setAssessHistory((prev) => prev?.filter((r) => r.conversationId !== conversationId) ?? null)
  setExpandedHistoryRuns((prev) => { const next = new Set(prev); next.delete(conversationId); return next })
}
```

### History UI Block

Inserted in the task detail drawer, after the existing FVI score / "Run Assessment" button area and before the ClickUp custom fields section.

**Structure:**

```tsx
{/* ── Assessment History ── */}
<div style={{ marginTop: 16 }}>
  <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>ASSESSMENT HISTORY</Typography.Text>

  {assessHistoryLoading && <Spin size="small" style={{ marginTop: 8 }} />}

  {!assessHistoryLoading && assessHistory?.length === 0 && (
    <Typography.Text style={{ color: '#484f58', fontSize: 12, display: 'block', marginTop: 6 }}>
      No assessments yet — run one to see history here.
    </Typography.Text>
  )}

  {!assessHistoryLoading && (assessHistory ?? []).map((run, idx) => {
    const isExpanded = expandedHistoryRuns.has(run.conversationId)
    const agencyDM = run.roles.filter(r => r.teamDomain === 'agency' && r.influenceType === 'DM')
    const agencyNDM = run.roles.filter(r => r.teamDomain === 'agency' && r.influenceType === 'NDM')
    const brandDM = run.roles.filter(r => r.teamDomain === 'brand' && r.influenceType === 'DM')
    const brandNDM = run.roles.filter(r => r.teamDomain === 'brand' && r.influenceType === 'NDM')

    return (
      <div key={run.conversationId} style={{ border: '1px solid #21262d', borderRadius: 6, marginTop: 8 }}>

        {/* Header row — always visible */}
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer' }}
          onClick={() => setExpandedHistoryRuns(prev => {
            const next = new Set(prev)
            isExpanded ? next.delete(run.conversationId) : next.add(run.conversationId)
            return next
          })}
        >
          <Tag color="blue" style={{ fontSize: 12 }}>FVI {run.fviScore.toFixed(2)}</Tag>
          <Typography.Text style={{ color: '#8b949e', fontSize: 11, flex: 1 }}>
            {run.completedAt
              ? new Date(run.completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
              : new Date(run.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </Typography.Text>
          <Tag style={{ fontSize: 11 }}>{run.riskLevel}</Tag>
          {run.effort && <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>{run.effort}d</Typography.Text>}
          {/* Archive button — stops propagation so click doesn't toggle expand */}
          <Popconfirm
            title="Archive this assessment run?"
            onConfirm={(e) => { e?.stopPropagation(); void archiveRun(run.conversationId) }}
            onCancel={(e) => e?.stopPropagation()}
            okText="Archive"
            cancelText="Cancel"
          >
            <Button
              type="text"
              size="small"
              icon={<DeleteOutlined />}
              style={{ color: '#484f58' }}
              onClick={(e) => e.stopPropagation()}
            />
          </Popconfirm>
          <Typography.Text style={{ color: '#484f58', fontSize: 11 }}>{isExpanded ? '▲' : '▼'}</Typography.Text>
        </div>

        {/* Expanded body */}
        {isExpanded && (
          <div style={{ padding: '0 10px 12px', borderTop: '1px solid #21262d' }}>

            {/* Affected Workflows */}
            {run.affectedWorkflows.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <Typography.Text style={{ color: '#8b949e', fontSize: 10 }}>WORKFLOWS</Typography.Text>
                <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {run.affectedWorkflows.map((w) => (
                    <span key={w.name} style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 4, padding: '2px 6px', fontSize: 11, color: '#e6edf3' }}>
                      {w.name}
                      {w.registryStatus === 'proposed' && <Tag color="orange" style={{ fontSize: 9, marginLeft: 4 }}>new</Tag>}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Objective Scores */}
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

            {/* Roles — grouped */}
            {[
              { label: 'Agency — Decision Makers', roles: agencyDM },
              { label: 'Agency — Non-Decision Makers', roles: agencyNDM },
              { label: 'Brand — Decision Makers', roles: brandDM },
              { label: 'Brand — Non-Decision Makers', roles: brandNDM },
            ].filter(g => g.roles.some(r => r.usageFrequency > 0)).map((group) => (
              <div key={group.label} style={{ marginTop: 10 }}>
                <Typography.Text style={{ color: '#8b949e', fontSize: 10 }}>{group.label.toUpperCase()}</Typography.Text>
                <div style={{ marginTop: 4 }}>
                  {group.roles.filter(r => r.usageFrequency > 0).map((r) => (
                    <div key={r.roleId} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '2px 0' }}>
                      <Tag style={{ fontSize: 10, minWidth: 20, textAlign: 'center' }}>{r.usageFrequency}</Tag>
                      <div style={{ flex: 1 }}>
                        <span style={{ color: '#e6edf3', fontSize: 11 }}>{r.roleName}</span>
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

**Notes on the roles section:**
- Only roles with `usageFrequency > 0` are shown (roles set to "Cannot Access" are omitted — consistent with how the confirm route filters roles)
- Role groups with no active roles are filtered out entirely
- Override badge shows on the role name when `isUserOverride === true`; reasoning shown is `userReasoning` (not Claude's)

---

## 4. Testing

### Unit tests (`__tests__/app/api/sprint/tasks/[id]/assess/history/route.test.ts`)

Test cases for the GET route:
- Returns 401 when no session
- Returns `{ runs: [] }` when no completed conversations exist
- Returns runs grouped by conversation, newest first
- Excludes `is_archived = true` runs
- Correctly derives `riskLevel` from multiplier (all 5 values)
- Correctly sets `isUserOverride: true` when `user_override_frequency` is non-null

Test cases for the PATCH route:
- Returns 404 when conversationId doesn't belong to the task
- Sets `is_archived = true` and returns `{ ok: true }`

### Frontend (existing test suite)
The history section is purely display — no new unit tests required beyond the route tests. The existing 101-test suite will catch any TypeScript or import errors.

---

## 5. File Summary

| File | Action |
|---|---|
| `supabase/migrations/009_assessment_is_archived.sql` | Create |
| `lib/supabase/types.ts` | Modify — add `is_archived`, `affected_workflows` to `assessment_conversations` |
| `app/api/sprint/tasks/[id]/assess/history/route.ts` | Create |
| `app/api/sprint/tasks/[id]/assess/history/[conversationId]/route.ts` | Create |
| `__tests__/app/api/sprint/tasks/[id]/assess/history/route.test.ts` | Create |
| `app/sprint/page.tsx` | Modify — types, state, `openDetail`, `loadAssessHistory`, `archiveRun`, history UI block |

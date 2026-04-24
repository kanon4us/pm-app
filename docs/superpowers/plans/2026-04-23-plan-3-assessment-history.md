# Assessment History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an assessment history section to the task detail drawer so the team can review all past FVI runs inline, archive old runs, and see a passive indicator when a run is in-progress.

**Architecture:** DB migration adds `is_archived` to `assessment_conversations`. Two new API routes (`GET history`, `PATCH archive`) serve and mutate run data. The frontend gains new types, state, and a history UI block inserted in the task detail drawer (below the FVI info grid, above the editable custom fields). A standalone `AssessmentButton` component replaces the raw "AI Assessment" button.

**Tech Stack:** Next.js App Router, Supabase (postgres), TypeScript, Ant Design, Jest

---

### Task 1: DB migration + Supabase types update

**Files:**
- Create: `supabase/migrations/009_assessment_is_archived.sql`
- Modify: `lib/supabase/types.ts`

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/009_assessment_is_archived.sql
alter table assessment_conversations
  add column if not exists is_archived boolean not null default false;

comment on column assessment_conversations.is_archived
  is 'When true, this run is hidden from the default history view. Set by PM via the drawer UI.';

create index if not exists idx_assessment_conversations_history
  on assessment_conversations(task_id, created_at desc);
```

- [ ] **Step 2: Apply the migration**

Run: `npx supabase db query --linked < supabase/migrations/009_assessment_is_archived.sql`
Expected: No error output (or silent success).

- [ ] **Step 3: Update Supabase types**

Read `lib/supabase/types.ts`. Find the `assessment_conversations` block (around line 105). It currently reads:

```typescript
assessment_conversations: {
  Row: { id: string; task_id: string; status: 'in_progress' | 'complete' | 'abandoned'; vault_context: Json | null; proposed_scores: Json | null; final_scores: Json | null; effort: number | null; risk: number | null; fvi_score: number | null; vault_spec_content: string | null; created_at: string; completed_at: string | null }
  Insert: { id?: string; task_id: string; status?: 'in_progress' | 'complete' | 'abandoned'; vault_context?: Json | null; proposed_scores?: Json | null }
  Update: { status?: 'in_progress' | 'complete' | 'abandoned'; proposed_scores?: Json | null; final_scores?: Json | null; effort?: number | null; risk?: number | null; fvi_score?: number | null; vault_spec_content?: string | null; completed_at?: string | null }
  Relationships: []
}
```

Replace with:

```typescript
assessment_conversations: {
  Row: { id: string; task_id: string; status: 'in_progress' | 'complete' | 'abandoned'; vault_context: Json | null; proposed_scores: Json | null; final_scores: Json | null; effort: number | null; risk: number | null; fvi_score: number | null; vault_spec_content: string | null; affected_workflows: Json | null; is_archived: boolean; created_at: string; completed_at: string | null }
  Insert: { id?: string; task_id: string; status?: 'in_progress' | 'complete' | 'abandoned'; vault_context?: Json | null; proposed_scores?: Json | null; is_archived?: boolean }
  Update: { status?: 'in_progress' | 'complete' | 'abandoned'; proposed_scores?: Json | null; final_scores?: Json | null; effort?: number | null; risk?: number | null; fvi_score?: number | null; vault_spec_content?: string | null; affected_workflows?: Json | null; is_archived?: boolean; completed_at?: string | null }
  Relationships: []
}
```

(Added: `affected_workflows: Json | null` and `is_archived: boolean` to `Row`; `is_archived?: boolean` to `Insert` and `Update`; `affected_workflows?: Json | null` to `Update`.)

- [ ] **Step 4: Run tests to verify no regressions**

Run: `npm test`
Expected: All tests pass (101 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/009_assessment_is_archived.sql lib/supabase/types.ts
git commit -m "feat: add is_archived column to assessment_conversations + update types"
```

---

### Task 2: GET history route

**Files:**
- Create: `app/api/sprint/tasks/[id]/assess/history/route.ts`
- Create: `__tests__/api/sprint/tasks/assess-history-get.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// __tests__/api/sprint/tasks/assess-history-get.test.ts

const mockFrom = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({ from: mockFrom }),
}))
jest.mock('@/lib/auth', () => ({
  auth: jest.fn().mockResolvedValue({ user: { email: 'pm@viscap.ai' } }),
}))

import { GET } from '@/app/api/sprint/tasks/[id]/assess/history/route'
import { NextRequest } from 'next/server'

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

function makeRequest(id = 'task-1') {
  return new NextRequest(`http://localhost/api/sprint/tasks/${id}/assess/history`, { method: 'GET' })
}

function mockUserFound() {
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({ data: { id: 'user-1' }, error: null }),
      }),
    }),
  })
}

function mockUserNotFound() {
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({ data: null, error: null }),
      }),
    }),
  })
}

// Returns raw DB rows (flat join — one row per role per conversation)
function mockConversationRows(rows: object[]) {
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        order: jest.fn().mockResolvedValue({ data: rows, error: null }),
      }),
    }),
  })
}

describe('GET /api/sprint/tasks/[id]/assess/history', () => {
  beforeEach(() => { mockFrom.mockReset() })

  it('returns 401 when no session', async () => {
    const { auth } = await import('@/lib/auth')
    ;(auth as jest.Mock).mockResolvedValueOnce(null)
    const res = await GET(makeRequest(), makeParams('task-1'))
    expect(res.status).toBe(401)
  })

  it('returns 404 when user not found', async () => {
    mockUserNotFound()
    const res = await GET(makeRequest(), makeParams('task-1'))
    expect(res.status).toBe(404)
  })

  it('returns empty runs when no conversations exist', async () => {
    mockUserFound()
    mockConversationRows([])
    const res = await GET(makeRequest(), makeParams('task-1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.runs).toEqual([])
  })

  it('groups role rows by conversation', async () => {
    mockUserFound()
    mockConversationRows([
      {
        id: 'conv-1', task_id: 'task-1', status: 'complete', fvi_score: 1.5,
        effort: 3, risk: 1.2, final_scores: [], affected_workflows: [],
        completed_at: '2026-04-20T10:00:00Z', created_at: '2026-04-20T09:00:00Z',
        is_archived: false,
        cra_id: 'cra-1', role_id: 'role-1', usage_frequency: 3,
        claude_proposed_frequency: 3, user_override_frequency: null,
        claude_reasoning: 'Primary decision maker', user_reasoning: null,
        role_name: 'Account Manager', team_domain: 'agency', influence_type: 'DM', weight: 4,
      },
      {
        id: 'conv-1', task_id: 'task-1', status: 'complete', fvi_score: 1.5,
        effort: 3, risk: 1.2, final_scores: [], affected_workflows: [],
        completed_at: '2026-04-20T10:00:00Z', created_at: '2026-04-20T09:00:00Z',
        is_archived: false,
        cra_id: 'cra-2', role_id: 'role-2', usage_frequency: 2,
        claude_proposed_frequency: 2, user_override_frequency: null,
        claude_reasoning: 'Secondary contact', user_reasoning: null,
        role_name: 'Brand Manager', team_domain: 'brand', influence_type: 'DM', weight: 3,
      },
    ])
    const res = await GET(makeRequest(), makeParams('task-1'))
    const body = await res.json()
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0].conversationId).toBe('conv-1')
    expect(body.runs[0].roles).toHaveLength(2)
  })

  it('returns all runs including in_progress and archived', async () => {
    mockUserFound()
    mockConversationRows([
      { id: 'conv-1', task_id: 'task-1', status: 'complete', is_archived: false, fvi_score: 1.5, effort: 3, risk: 1.2, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-20T09:00:00Z', cra_id: null, role_id: null, usage_frequency: null, claude_proposed_frequency: null, user_override_frequency: null, claude_reasoning: null, user_reasoning: null, role_name: null, team_domain: null, influence_type: null, weight: null },
      { id: 'conv-2', task_id: 'task-1', status: 'in_progress', is_archived: false, fvi_score: null, effort: null, risk: null, final_scores: null, affected_workflows: null, completed_at: null, created_at: '2026-04-21T09:00:00Z', cra_id: null, role_id: null, usage_frequency: null, claude_proposed_frequency: null, user_override_frequency: null, claude_reasoning: null, user_reasoning: null, role_name: null, team_domain: null, influence_type: null, weight: null },
      { id: 'conv-3', task_id: 'task-1', status: 'complete', is_archived: true, fvi_score: 1.2, effort: 2, risk: 1.0, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-19T09:00:00Z', cra_id: null, role_id: null, usage_frequency: null, claude_proposed_frequency: null, user_override_frequency: null, claude_reasoning: null, user_reasoning: null, role_name: null, team_domain: null, influence_type: null, weight: null },
    ])
    const res = await GET(makeRequest(), makeParams('task-1'))
    const body = await res.json()
    expect(body.runs).toHaveLength(3)
    const statuses = body.runs.map((r: { status: string }) => r.status)
    expect(statuses).toContain('in_progress')
    expect(statuses).toContain('complete')
    const archived = body.runs.filter((r: { isArchived: boolean }) => r.isArchived)
    expect(archived).toHaveLength(1)
  })

  it('derives riskLevel from multiplier correctly', async () => {
    mockUserFound()
    mockConversationRows([
      { id: 'c1', task_id: 'task-1', status: 'complete', is_archived: false, fvi_score: 1.0, effort: 1, risk: 1.0, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-20T00:00:00Z', cra_id: null, role_id: null, usage_frequency: null, claude_proposed_frequency: null, user_override_frequency: null, claude_reasoning: null, user_reasoning: null, role_name: null, team_domain: null, influence_type: null, weight: null },
      { id: 'c2', task_id: 'task-1', status: 'complete', is_archived: false, fvi_score: 1.0, effort: 1, risk: 1.2, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-19T00:00:00Z', cra_id: null, role_id: null, usage_frequency: null, claude_proposed_frequency: null, user_override_frequency: null, claude_reasoning: null, user_reasoning: null, role_name: null, team_domain: null, influence_type: null, weight: null },
      { id: 'c3', task_id: 'task-1', status: 'complete', is_archived: false, fvi_score: 1.0, effort: 1, risk: 1.5, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-18T00:00:00Z', cra_id: null, role_id: null, usage_frequency: null, claude_proposed_frequency: null, user_override_frequency: null, claude_reasoning: null, user_reasoning: null, role_name: null, team_domain: null, influence_type: null, weight: null },
      { id: 'c4', task_id: 'task-1', status: 'complete', is_archived: false, fvi_score: 1.0, effort: 1, risk: 2.0, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-17T00:00:00Z', cra_id: null, role_id: null, usage_frequency: null, claude_proposed_frequency: null, user_override_frequency: null, claude_reasoning: null, user_reasoning: null, role_name: null, team_domain: null, influence_type: null, weight: null },
      { id: 'c5', task_id: 'task-1', status: 'complete', is_archived: false, fvi_score: 1.0, effort: 1, risk: 3.0, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-16T00:00:00Z', cra_id: null, role_id: null, usage_frequency: null, claude_proposed_frequency: null, user_override_frequency: null, claude_reasoning: null, user_reasoning: null, role_name: null, team_domain: null, influence_type: null, weight: null },
    ])
    const res = await GET(makeRequest(), makeParams('task-1'))
    const body = await res.json()
    const levels = body.runs.map((r: { riskLevel: string }) => r.riskLevel)
    expect(levels).toEqual(['Routine', 'Standard', 'Moderate', 'High', 'Critical'])
  })

  it('sets isUserOverride true when user_override_frequency is non-null', async () => {
    mockUserFound()
    mockConversationRows([
      {
        id: 'conv-1', task_id: 'task-1', status: 'complete', is_archived: false,
        fvi_score: 1.5, effort: 3, risk: 1.2, final_scores: [], affected_workflows: [],
        completed_at: null, created_at: '2026-04-20T09:00:00Z',
        cra_id: 'cra-1', role_id: 'role-1', usage_frequency: 2,
        claude_proposed_frequency: 2, user_override_frequency: 4,
        claude_reasoning: 'AI said 2', user_reasoning: 'PM bumped to 4',
        role_name: 'Director', team_domain: 'agency', influence_type: 'DM', weight: 5,
      },
    ])
    const res = await GET(makeRequest(), makeParams('task-1'))
    const body = await res.json()
    const role = body.runs[0].roles[0]
    expect(role.isUserOverride).toBe(true)
    expect(role.usageFrequency).toBe(4) // userOverrideFrequency wins
  })

  it('computes usageFrequency as userOverride ?? claudeProposed ?? usage_frequency', async () => {
    mockUserFound()
    // Row with only usage_frequency (no override, no claude proposed)
    mockConversationRows([
      {
        id: 'conv-1', task_id: 'task-1', status: 'complete', is_archived: false,
        fvi_score: 1.0, effort: 1, risk: 1.0, final_scores: [], affected_workflows: [],
        completed_at: null, created_at: '2026-04-20T09:00:00Z',
        cra_id: 'cra-1', role_id: 'role-1', usage_frequency: 3,
        claude_proposed_frequency: null, user_override_frequency: null,
        claude_reasoning: null, user_reasoning: null,
        role_name: 'Exec', team_domain: 'brand', influence_type: 'DM', weight: 5,
      },
    ])
    const res = await GET(makeRequest(), makeParams('task-1'))
    const body = await res.json()
    expect(body.runs[0].roles[0].usageFrequency).toBe(3)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm test -- --testPathPattern=assess-history-get`
Expected: FAIL — `Cannot find module '@/app/api/sprint/tasks/[id]/assess/history/route'`

- [ ] **Step 3: Create the GET history route**

```typescript
// app/api/sprint/tasks/[id]/assess/history/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

type Params = { params: Promise<{ id: string }> }

function riskLevel(multiplier: number | null): string {
  if (multiplier === 1.0) return 'Routine'
  if (multiplier === 1.2) return 'Standard'
  if (multiplier === 1.5) return 'Moderate'
  if (multiplier === 2.0) return 'High'
  if (multiplier === 3.0) return 'Critical'
  return 'Unknown'
}

// GET /api/sprint/tasks/[id]/assess/history
// Returns all assessment conversations for the task (complete, in_progress, abandoned)
// including role data joined from conversation_role_assessments + role_registry.
// Frontend is responsible for filtering by status and is_archived.
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()

  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // Fetch all conversations for the task with roles joined
  const { data: rows, error } = await supabase
    .from('assessment_conversations')
    .select(`
      id, task_id, status, fvi_score, effort, risk,
      final_scores, affected_workflows, completed_at, created_at, is_archived,
      conversation_role_assessments (
        id,
        role_id,
        usage_frequency,
        claude_proposed_frequency,
        user_override_frequency,
        claude_reasoning,
        user_reasoning,
        role_registry ( role_name, team_domain, influence_type, weight )
      )
    `)
    .eq('task_id', id)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[assess/history GET] DB error:', error)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }

  if (!rows || rows.length === 0) return NextResponse.json({ runs: [] })

  const runs = (rows as Array<Record<string, unknown>>).map((ac) => {
    const craRows = (ac.conversation_role_assessments as Array<Record<string, unknown>> | null) ?? []
    const roles = craRows
      .filter((cra) => cra.role_id != null)
      .map((cra) => {
        const rr = cra.role_registry as Record<string, unknown> | null
        const userOverride = cra.user_override_frequency as number | null
        const claudeProposed = cra.claude_proposed_frequency as number | null
        const usageFreq = cra.usage_frequency as number
        return {
          roleId: cra.role_id as string,
          roleName: rr?.role_name as string ?? '',
          teamDomain: rr?.team_domain as string ?? '',
          influenceType: rr?.influence_type as 'DM' | 'NDM' ?? 'DM',
          weight: rr?.weight as number ?? 0,
          usageFrequency: userOverride ?? claudeProposed ?? usageFreq,
          claudeProposedFrequency: claudeProposed,
          claudeReasoning: cra.claude_reasoning as string | null,
          userOverrideFrequency: userOverride,
          userReasoning: cra.user_reasoning as string | null,
          isUserOverride: userOverride !== null,
        }
      })

    return {
      conversationId: ac.id as string,
      status: ac.status as string,
      isArchived: ac.is_archived as boolean,
      fviScore: ac.fvi_score as number | null,
      effort: ac.effort as number | null,
      risk: ac.risk as number | null,
      riskLevel: riskLevel(ac.risk as number | null),
      completedAt: ac.completed_at as string | null,
      createdAt: ac.created_at as string,
      finalScores: (ac.final_scores as Array<Record<string, unknown>> | null) ?? [],
      affectedWorkflows: (ac.affected_workflows as Array<Record<string, unknown>> | null) ?? [],
      roles,
    }
  })

  return NextResponse.json({ runs })
}
```

**Note on the Supabase query:** The route uses Supabase's nested select syntax (PostgREST) to join `conversation_role_assessments` and `role_registry` in a single query. This avoids the flat-join row multiplication seen in the SQL in the spec — Supabase returns nested objects instead of repeated rows. The test mock uses a flat-row structure to simulate the DB response; the implementation will receive nested objects in production. Both need to work.

**Actually — the mock returns flat rows but Supabase nested select returns nested objects.** The tests above mock the raw Supabase chained API. To keep tests simple and correct, restructure the route to use a flat join (matching the mock) OR restructure the mock. The cleaner approach is to keep the route simple with the nested Supabase syntax and adjust the tests to mock the nested response. Revise the mock helpers:

```typescript
// Revised: mockConversationRows for nested Supabase response
function mockConversationRows(rows: object[]) {
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        order: jest.fn().mockResolvedValue({ data: rows, error: null }),
      }),
    }),
  })
}
```

The `rows` should use the nested structure:
```typescript
{
  id: 'conv-1', task_id: 'task-1', status: 'complete', fvi_score: 1.5,
  effort: 3, risk: 1.2, final_scores: [], affected_workflows: [],
  completed_at: '2026-04-20T10:00:00Z', created_at: '2026-04-20T09:00:00Z',
  is_archived: false,
  conversation_role_assessments: [
    {
      id: 'cra-1', role_id: 'role-1', usage_frequency: 3,
      claude_proposed_frequency: 3, user_override_frequency: null,
      claude_reasoning: 'Primary decision maker', user_reasoning: null,
      role_registry: { role_name: 'Account Manager', team_domain: 'agency', influence_type: 'DM', weight: 4 },
    },
  ],
}
```

Update all test rows in the test file to use the nested format. The mock infrastructure stays the same.

- [ ] **Step 4: Rewrite test data to use nested Supabase format**

Update `__tests__/api/sprint/tasks/assess-history-get.test.ts`. Replace all flat-row `mockConversationRows` calls with nested format:

```typescript
// 'groups role rows by conversation' test — replace the flat row data with:
mockConversationRows([
  {
    id: 'conv-1', task_id: 'task-1', status: 'complete', fvi_score: 1.5,
    effort: 3, risk: 1.2, final_scores: [], affected_workflows: [],
    completed_at: '2026-04-20T10:00:00Z', created_at: '2026-04-20T09:00:00Z',
    is_archived: false,
    conversation_role_assessments: [
      { id: 'cra-1', role_id: 'role-1', usage_frequency: 3, claude_proposed_frequency: 3, user_override_frequency: null, claude_reasoning: 'Primary decision maker', user_reasoning: null, role_registry: { role_name: 'Account Manager', team_domain: 'agency', influence_type: 'DM', weight: 4 } },
      { id: 'cra-2', role_id: 'role-2', usage_frequency: 2, claude_proposed_frequency: 2, user_override_frequency: null, claude_reasoning: 'Secondary contact', user_reasoning: null, role_registry: { role_name: 'Brand Manager', team_domain: 'brand', influence_type: 'DM', weight: 3 } },
    ],
  },
])

// 'returns all runs including in_progress and archived' test:
mockConversationRows([
  { id: 'conv-1', status: 'complete', is_archived: false, fvi_score: 1.5, effort: 3, risk: 1.2, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-20T09:00:00Z', task_id: 'task-1', conversation_role_assessments: [] },
  { id: 'conv-2', status: 'in_progress', is_archived: false, fvi_score: null, effort: null, risk: null, final_scores: null, affected_workflows: null, completed_at: null, created_at: '2026-04-21T09:00:00Z', task_id: 'task-1', conversation_role_assessments: [] },
  { id: 'conv-3', status: 'complete', is_archived: true, fvi_score: 1.2, effort: 2, risk: 1.0, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-19T09:00:00Z', task_id: 'task-1', conversation_role_assessments: [] },
])

// 'derives riskLevel' test — 5 rows, each with conversation_role_assessments: []:
mockConversationRows([
  { id: 'c1', status: 'complete', is_archived: false, fvi_score: 1.0, effort: 1, risk: 1.0, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-20T00:00:00Z', task_id: 'task-1', conversation_role_assessments: [] },
  { id: 'c2', status: 'complete', is_archived: false, fvi_score: 1.0, effort: 1, risk: 1.2, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-19T00:00:00Z', task_id: 'task-1', conversation_role_assessments: [] },
  { id: 'c3', status: 'complete', is_archived: false, fvi_score: 1.0, effort: 1, risk: 1.5, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-18T00:00:00Z', task_id: 'task-1', conversation_role_assessments: [] },
  { id: 'c4', status: 'complete', is_archived: false, fvi_score: 1.0, effort: 1, risk: 2.0, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-17T00:00:00Z', task_id: 'task-1', conversation_role_assessments: [] },
  { id: 'c5', status: 'complete', is_archived: false, fvi_score: 1.0, effort: 1, risk: 3.0, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-16T00:00:00Z', task_id: 'task-1', conversation_role_assessments: [] },
])

// 'sets isUserOverride true' test:
mockConversationRows([{
  id: 'conv-1', task_id: 'task-1', status: 'complete', is_archived: false,
  fvi_score: 1.5, effort: 3, risk: 1.2, final_scores: [], affected_workflows: [],
  completed_at: null, created_at: '2026-04-20T09:00:00Z',
  conversation_role_assessments: [{
    id: 'cra-1', role_id: 'role-1', usage_frequency: 2,
    claude_proposed_frequency: 2, user_override_frequency: 4,
    claude_reasoning: 'AI said 2', user_reasoning: 'PM bumped to 4',
    role_registry: { role_name: 'Director', team_domain: 'agency', influence_type: 'DM', weight: 5 },
  }],
}])

// 'computes usageFrequency' test:
mockConversationRows([{
  id: 'conv-1', task_id: 'task-1', status: 'complete', is_archived: false,
  fvi_score: 1.0, effort: 1, risk: 1.0, final_scores: [], affected_workflows: [],
  completed_at: null, created_at: '2026-04-20T09:00:00Z',
  conversation_role_assessments: [{
    id: 'cra-1', role_id: 'role-1', usage_frequency: 3,
    claude_proposed_frequency: null, user_override_frequency: null,
    claude_reasoning: null, user_reasoning: null,
    role_registry: { role_name: 'Exec', team_domain: 'brand', influence_type: 'DM', weight: 5 },
  }],
}])
```

- [ ] **Step 5: Run tests — expect they pass**

Run: `npm test -- --testPathPattern=assess-history-get`
Expected: PASS, 8 tests.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add "app/api/sprint/tasks/[id]/assess/history/route.ts" __tests__/api/sprint/tasks/assess-history-get.test.ts
git commit -m "feat: add GET /assess/history route — returns all runs with roles joined"
```

---

### Task 3: PATCH archive route

**Files:**
- Create: `app/api/sprint/tasks/[id]/assess/history/[conversationId]/route.ts`
- Create: `__tests__/api/sprint/tasks/assess-history-patch.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// __tests__/api/sprint/tasks/assess-history-patch.test.ts

const mockFrom = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({ from: mockFrom }),
}))
jest.mock('@/lib/auth', () => ({
  auth: jest.fn().mockResolvedValue({ user: { email: 'pm@viscap.ai' } }),
}))

import { PATCH } from '@/app/api/sprint/tasks/[id]/assess/history/[conversationId]/route'
import { NextRequest } from 'next/server'

function makeParams(id: string, conversationId: string) {
  return { params: Promise.resolve({ id, conversationId }) }
}

function makeRequest(body: { isArchived: boolean }, taskId = 'task-1', convId = 'conv-1') {
  return new NextRequest(
    `http://localhost/api/sprint/tasks/${taskId}/assess/history/${convId}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  )
}

function mockUserFound() {
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({ data: { id: 'user-1' }, error: null }),
      }),
    }),
  })
}

function mockConvFound() {
  mockFrom.mockReturnValueOnce({
    update: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ data: [{ id: 'conv-1' }], error: null, count: 1 }),
      }),
    }),
  })
}

function mockConvNotFound() {
  mockFrom.mockReturnValueOnce({
    update: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ data: [], error: null, count: 0 }),
      }),
    }),
  })
}

describe('PATCH /api/sprint/tasks/[id]/assess/history/[conversationId]', () => {
  beforeEach(() => { mockFrom.mockReset() })

  it('returns 401 when no session', async () => {
    const { auth } = await import('@/lib/auth')
    ;(auth as jest.Mock).mockResolvedValueOnce(null)
    const res = await PATCH(makeRequest({ isArchived: true }), makeParams('task-1', 'conv-1'))
    expect(res.status).toBe(401)
  })

  it('returns 404 when conversation does not belong to task', async () => {
    mockUserFound()
    mockConvNotFound()
    const res = await PATCH(makeRequest({ isArchived: true }), makeParams('task-1', 'conv-999'))
    expect(res.status).toBe(404)
  })

  it('archives a conversation and returns { ok: true }', async () => {
    mockUserFound()
    mockConvFound()
    const res = await PATCH(makeRequest({ isArchived: true }), makeParams('task-1', 'conv-1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
  })

  it('unarchives a conversation and returns { ok: true }', async () => {
    mockUserFound()
    mockConvFound()
    const res = await PATCH(makeRequest({ isArchived: false }), makeParams('task-1', 'conv-1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm test -- --testPathPattern=assess-history-patch`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: Create the PATCH route**

```typescript
// app/api/sprint/tasks/[id]/assess/history/[conversationId]/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

type Params = { params: Promise<{ id: string; conversationId: string }> }

// PATCH /api/sprint/tasks/[id]/assess/history/[conversationId]
// Body: { isArchived: boolean }
// Archives or unarchives a completed assessment run.
// Verifies the conversation belongs to the task before updating.
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id, conversationId } = await params
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { isArchived } = await req.json() as { isArchived: boolean }

  const supabase = await getSupabaseServiceClient()

  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { data, error } = await supabase
    .from('assessment_conversations')
    .update({ is_archived: isArchived })
    .eq('id', conversationId)
    .eq('task_id', id)

  if (error) {
    console.error('[assess/history PATCH] DB error:', error)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }

  // If no rows were updated, the conversation doesn't exist or doesn't belong to this task
  if (!data || (Array.isArray(data) && data.length === 0)) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: Run tests — expect they pass**

Run: `npm test -- --testPathPattern=assess-history-patch`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add "app/api/sprint/tasks/[id]/assess/history/[conversationId]/route.ts" __tests__/api/sprint/tasks/assess-history-patch.test.ts
git commit -m "feat: add PATCH /assess/history/[conversationId] route — archive/unarchive runs"
```

---

### Task 4: AssessmentButton component

**Files:**
- Create: `app/sprint/components/AssessmentButton.tsx`

This component is small and has no logic to unit-test beyond TypeScript checking. No test file needed.

- [ ] **Step 1: Create the component directory and file**

```bash
mkdir -p app/sprint/components
```

```typescript
// app/sprint/components/AssessmentButton.tsx
'use client'
import { Button } from 'antd'

interface AssessmentButtonProps {
  historyLoading: boolean
  onRunNew: () => void
}

// Primary action button for starting an FVI assessment.
// Disabled while history is loading (so the user can't start before we know if a run is in-progress).
// Resume capability is deferred — see docs/superpowers/plans for the next iteration.
export function AssessmentButton({ historyLoading, onRunNew }: AssessmentButtonProps) {
  return (
    <Button disabled={historyLoading} onClick={onRunNew}>
      AI Assessment
    </Button>
  )
}
```

- [ ] **Step 2: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/sprint/components/AssessmentButton.tsx
git commit -m "feat: add AssessmentButton component — disabled while history loads"
```

---

### Task 5: Frontend — types, state, and core functions

**Files:**
- Modify: `app/sprint/page.tsx`

Read `app/sprint/page.tsx` before editing. Key locations:
- Line 2: `import { useEffect, useMemo, useState } from 'react'` — needs `useRef` added
- Line 9: icons import — needs `DeleteOutlined, UndoOutlined` added
- Lines 3–7: antd imports — needs `Popconfirm` added
- Line 15: start of interface block
- Lines 202–253: `useState` declarations
- Line 278: `function openDetail(task: Task)`
- Line 918: `onClose={() => setDetailTask(null)}`

- [ ] **Step 1: Add `useRef` to the React import**

Find line 2:
```typescript
import { useEffect, useMemo, useState } from 'react'
```
Replace with:
```typescript
import { useEffect, useMemo, useRef, useState } from 'react'
```

- [ ] **Step 2: Add `Popconfirm` to the antd import**

Find:
```typescript
  Layout, Typography, Table, Button, Tag, Modal, Form, Input,
  DatePicker, InputNumber, Select, Space, Spin, Alert, Drawer,
  Switch, Tooltip, Divider, Slider, Progress,
```
Replace with:
```typescript
  Layout, Typography, Table, Button, Tag, Modal, Form, Input,
  DatePicker, InputNumber, Select, Space, Spin, Alert, Drawer,
  Switch, Tooltip, Divider, Slider, Progress, Popconfirm,
```

- [ ] **Step 3: Add icon imports**

Find line 9:
```typescript
import { SearchOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons'
```
Replace with:
```typescript
import { SearchOutlined, SaveOutlined, ThunderboltOutlined, DeleteOutlined, UndoOutlined } from '@ant-design/icons'
```

- [ ] **Step 4: Add `AssessHistoryRole` and `AssessHistoryRun` interfaces**

Find `// ── Assessment types ──` (around line 15). After the existing last interface in the assessment types block (find `interface DocProposal` and its closing `}`), add:

```typescript
interface AssessHistoryRole {
  roleId: string
  roleName: string
  teamDomain: string
  influenceType: 'DM' | 'NDM'
  weight: number
  usageFrequency: number
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

- [ ] **Step 5: Add new state variables**

Find the last `useState` declaration in the assessment state block (around line 253, after `docApplyResults`). Add immediately after:

```typescript
  // ── Assessment history state ───────────────────────────────────────────────
  const detailTaskRef = useRef<Task | null>(null)
  const [assessHistory, setAssessHistory] = useState<AssessHistoryRun[] | null>(null)
  const [assessHistoryLoading, setAssessHistoryLoading] = useState(false)
  const [expandedHistoryRuns, setExpandedHistoryRuns] = useState<Set<string>>(new Set())
  const [showArchived, setShowArchived] = useState(false)
```

- [ ] **Step 6: Add `useEffect` to sync `detailTaskRef`**

Find the `useEffect(() => { load() }, [])` line (around line 276). Add immediately after it:

```typescript
  useEffect(() => { detailTaskRef.current = detailTask }, [detailTask])
```

- [ ] **Step 7: Add `loadAssessHistory()` function**

Find `async function openDetail(task: Task)` (around line 278). Add the following immediately BEFORE it:

```typescript
  async function loadAssessHistory(taskId: string) {
    setAssessHistoryLoading(true)
    try {
      const res = await apiFetch(`/api/sprint/tasks/${taskId}/assess/history`)
      const data = await res.json()
      if (res.ok && detailTaskRef.current?.id === taskId) {
        const runs: AssessHistoryRun[] = data.runs ?? []
        setAssessHistory(runs)
        const newestUnarchived = runs.find((r) => r.status === 'complete' && !r.isArchived)
        if (newestUnarchived) {
          setExpandedHistoryRuns(new Set([newestUnarchived.conversationId]))
        }
      }
    } catch (err) {
      console.error('[loadAssessHistory] fetch failed', err)
    } finally {
      setAssessHistoryLoading(false)
    }
  }
```

- [ ] **Step 8: Update `openDetail()` to reset history state and fire `loadAssessHistory`**

Find `async function openDetail(task: Task)`. Replace its body with:

```typescript
  async function openDetail(task: Task) {
    setDetailTask(task)
    detailTaskRef.current = task
    setEditedFields(task.custom_fields ? [...task.custom_fields] : [])
    setSaveSuccess(false)
    setDescription('')
    setDescLoading(true)
    setAssessHistory(null)
    setExpandedHistoryRuns(new Set())
    setShowArchived(false)
    void loadAssessHistory(task.id)
    try {
      const res = await apiFetch(`/api/sprint/tasks/${task.id}`)
      const data = await res.json()
      setDescription(data.description ?? '')
      if (Array.isArray(data.customFields) && data.customFields.length > 0) {
        setEditedFields(data.customFields)
      }
    } catch { /* non-fatal */ }
    setDescLoading(false)
  }
```

- [ ] **Step 9: Update drawer `onClose` to reset history state**

Find:
```typescript
        onClose={() => setDetailTask(null)}
```
Replace with:
```typescript
        onClose={() => {
          setDetailTask(null)
          detailTaskRef.current = null
          setAssessHistory(null)
          setExpandedHistoryRuns(new Set())
          setShowArchived(false)
        }}
```

- [ ] **Step 10: Add `archiveRun()` function**

Find `function handleApproveScores()` (or another nearby handler function). Add `archiveRun` after it:

```typescript
  async function archiveRun(conversationId: string) {
    if (!detailTask) return
    await apiFetch(`/api/sprint/tasks/${detailTask.id}/assess/history/${conversationId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isArchived: true }),
    })
    setAssessHistory((prev) =>
      prev?.map((r) => r.conversationId === conversationId ? { ...r, isArchived: true } : r) ?? null
    )
    setExpandedHistoryRuns((prev) => {
      const next = new Set(prev)
      next.delete(conversationId)
      return next
    })
  }

  async function unarchiveRun(conversationId: string) {
    if (!detailTask) return
    await apiFetch(`/api/sprint/tasks/${detailTask.id}/assess/history/${conversationId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isArchived: false }),
    })
    setAssessHistory((prev) =>
      prev?.map((r) => r.conversationId === conversationId ? { ...r, isArchived: false } : r) ?? null
    )
  }
```

- [ ] **Step 11: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors (or only errors from unused variables that will be used in Task 6).

- [ ] **Step 12: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 13: Commit**

```bash
git add app/sprint/page.tsx
git commit -m "feat: add assessment history state, loadAssessHistory, archiveRun to sprint page"
```

---

### Task 6: Frontend — history UI block + previous workflows hint + AssessmentButton wiring

**Files:**
- Modify: `app/sprint/page.tsx`

Read `app/sprint/page.tsx` before editing. Key locations:
- Line 1013: `<div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>` — the action buttons block
- Line 1018: `<Button icon={<ThunderboltOutlined />} onClick={openAssess} block>` — the existing "AI Assessment" button (to be replaced by `AssessmentButton`)
- Around line 967: `<Divider style={{ borderColor: '#21262d', margin: '8px 0' }} />` — just before custom fields
- Inside the interview phase UI block (look for `{assessPhase === 'interview' && conversation &&`) — where the previous workflows hint goes

- [ ] **Step 1: Add the assessment history import**

Find the imports at the top of the file. Add after the existing local imports:

```typescript
import { AssessmentButton } from '@/app/sprint/components/AssessmentButton'
```

- [ ] **Step 2: Replace the raw "AI Assessment" button with `AssessmentButton`**

Find (around line 1018):
```tsx
              <Button icon={<ThunderboltOutlined />} onClick={openAssess} block>
                AI Assessment
              </Button>
```
Replace with:
```tsx
              <AssessmentButton historyLoading={assessHistoryLoading} onRunNew={openAssess} />
```

- [ ] **Step 3: Insert the assessment history UI block**

Find the `<Divider style={{ borderColor: '#21262d', margin: '8px 0' }} />` at around line 967 (the one between the description area and the editable custom fields). Insert the following **before** that divider:

```tsx
            {/* ── Assessment History ── */}
            <div style={{ marginTop: 8 }}>
              {/* Section header */}
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
                const visibleRuns = allComplete.filter((r) => showArchived || !r.isArchived)
                const hasHiddenArchived = allComplete.length > 0 && visibleRuns.length === 0 && !showArchived
                const noRunsAtAll = allComplete.length === 0
                const inProgressRun = (assessHistory ?? []).find((r) => r.status === 'in_progress')

                return (
                  <>
                    {inProgressRun && (
                      <div style={{ background: '#161b22', border: '1px solid #f0883e', borderRadius: 6, padding: '8px 10px', marginTop: 8 }}>
                        <Typography.Text style={{ color: '#f0883e', fontSize: 11 }}>
                          ⚠ An assessment is in progress (started {new Date(inProgressRun.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}). Resume capability coming soon.
                        </Typography.Text>
                      </div>
                    )}

                    {noRunsAtAll && (
                      <Typography.Text style={{ color: '#484f58', fontSize: 12, display: 'block', marginTop: 6 }}>
                        No assessments yet — run one to see history here.
                      </Typography.Text>
                    )}

                    {hasHiddenArchived && (
                      <Typography.Text style={{ color: '#484f58', fontSize: 12, display: 'block', marginTop: 6 }}>
                        All assessments archived — toggle &quot;Show Archived&quot; to view them.
                      </Typography.Text>
                    )}

                    {visibleRuns.map((run) => {
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
                              onConfirm={(e) => { e?.stopPropagation(); void (run.isArchived ? unarchiveRun(run.conversationId) : archiveRun(run.conversationId)) }}
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
                  </>
                )
              })()}
            </div>
```

- [ ] **Step 4: Add the "previous workflows" hint inside the interview phase**

Find the interview phase block — look for `{assessPhase === 'interview' && conversation &&`. Inside it, find the question display section. Insert the hint at the **very top** of the interview phase block's content (before the existing question UI):

```tsx
                {/* Previous run workflows hint — helps PM catch tag drift */}
                {(() => {
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

- [ ] **Step 5: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add app/sprint/page.tsx
git commit -m "feat: add assessment history UI block, in-progress indicator, and previous workflows hint"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Task |
|---|---|
| `is_archived` DB column | Task 1 |
| `affected_workflows` added to Supabase types | Task 1 |
| GET history route — all runs, no filtering | Task 2 |
| GET history — `riskLevel` derivation | Task 2 |
| GET history — `isUserOverride`, `usageFrequency` computation | Task 2 |
| PATCH archive/unarchive route | Task 3 |
| PATCH — 404 when conversation doesn't belong to task | Task 3 |
| `AssessmentButton` component (disabled while history loads) | Task 4 |
| `AssessHistoryRole` and `AssessHistoryRun` types | Task 5 |
| `detailTaskRef` + `useEffect` sync | Task 5 |
| `loadAssessHistory` with race condition check | Task 5 |
| `archiveRun` + `unarchiveRun` (optimistic update) | Task 5 |
| Updated `openDetail` + drawer `onClose` | Task 5 |
| History UI block — header + toggle | Task 6 |
| Three-state empty state (no runs / all archived / normal) | Task 6 |
| In-progress indicator | Task 6 |
| Expanded run: workflows (name + ✦), objectives, roles | Task 6 |
| Archive/unarchive Popconfirm with correct icon | Task 6 |
| Previous workflows hint in interview phase | Task 6 |
| `AssessmentButton` wired in place of raw button | Task 6 |

### Placeholder scan

No TBD, TODO, or vague steps. All code blocks are complete.

### Type consistency

- `AssessHistoryRun` defined in Task 5, used in Task 5 (`loadAssessHistory`) and Task 6 (history UI).
- `AssessHistoryRole` defined in Task 5, referenced in `AssessHistoryRun.roles`.
- `archiveRun(conversationId)` and `unarchiveRun(conversationId)` both defined in Task 5, called in Task 6.
- `expandedHistoryRuns` is `Set<string>`, toggled in Task 6 with `.has()`, `.add()`, `.delete()` — all correct Set methods.
- `visibleRuns` computed inline in Task 6 (not a separate variable from Task 5) — self-contained, no cross-task dependency.

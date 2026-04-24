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

// Returns nested Supabase rows (conversation_role_assessments is a nested array)
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
        conversation_role_assessments: [
          { id: 'cra-1', role_id: 'role-1', usage_frequency: 3, claude_proposed_frequency: 3, user_override_frequency: null, claude_reasoning: 'Primary decision maker', user_reasoning: null, role_registry: { role_name: 'Account Manager', team_domain: 'agency', influence_type: 'DM', weight: 4 } },
          { id: 'cra-2', role_id: 'role-2', usage_frequency: 2, claude_proposed_frequency: 2, user_override_frequency: null, claude_reasoning: 'Secondary contact', user_reasoning: null, role_registry: { role_name: 'Brand Manager', team_domain: 'brand', influence_type: 'DM', weight: 3 } },
        ],
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
      { id: 'conv-1', status: 'complete', is_archived: false, fvi_score: 1.5, effort: 3, risk: 1.2, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-20T09:00:00Z', task_id: 'task-1', conversation_role_assessments: [] },
      { id: 'conv-2', status: 'in_progress', is_archived: false, fvi_score: null, effort: null, risk: null, final_scores: null, affected_workflows: null, completed_at: null, created_at: '2026-04-21T09:00:00Z', task_id: 'task-1', conversation_role_assessments: [] },
      { id: 'conv-3', status: 'complete', is_archived: true, fvi_score: 1.2, effort: 2, risk: 1.0, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-19T09:00:00Z', task_id: 'task-1', conversation_role_assessments: [] },
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
      { id: 'c1', status: 'complete', is_archived: false, fvi_score: 1.0, effort: 1, risk: 1.0, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-20T00:00:00Z', task_id: 'task-1', conversation_role_assessments: [] },
      { id: 'c2', status: 'complete', is_archived: false, fvi_score: 1.0, effort: 1, risk: 1.2, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-19T00:00:00Z', task_id: 'task-1', conversation_role_assessments: [] },
      { id: 'c3', status: 'complete', is_archived: false, fvi_score: 1.0, effort: 1, risk: 1.5, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-18T00:00:00Z', task_id: 'task-1', conversation_role_assessments: [] },
      { id: 'c4', status: 'complete', is_archived: false, fvi_score: 1.0, effort: 1, risk: 2.0, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-17T00:00:00Z', task_id: 'task-1', conversation_role_assessments: [] },
      { id: 'c5', status: 'complete', is_archived: false, fvi_score: 1.0, effort: 1, risk: 3.0, final_scores: [], affected_workflows: [], completed_at: null, created_at: '2026-04-16T00:00:00Z', task_id: 'task-1', conversation_role_assessments: [] },
    ])
    const res = await GET(makeRequest(), makeParams('task-1'))
    const body = await res.json()
    const levels = body.runs.map((r: { riskLevel: string }) => r.riskLevel)
    expect(levels).toEqual(['Routine', 'Standard', 'Moderate', 'High', 'Critical'])
  })

  it('sets isUserOverride true when user_override_frequency is non-null', async () => {
    mockUserFound()
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
    const res = await GET(makeRequest(), makeParams('task-1'))
    const body = await res.json()
    const role = body.runs[0].roles[0]
    expect(role.isUserOverride).toBe(true)
    expect(role.usageFrequency).toBe(4) // userOverrideFrequency wins
  })

  it('computes usageFrequency as userOverride ?? claudeProposed ?? usage_frequency', async () => {
    mockUserFound()
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
    const res = await GET(makeRequest(), makeParams('task-1'))
    const body = await res.json()
    expect(body.runs[0].roles[0].usageFrequency).toBe(3)
  })
})

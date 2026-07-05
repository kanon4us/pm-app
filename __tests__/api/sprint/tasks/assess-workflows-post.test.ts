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

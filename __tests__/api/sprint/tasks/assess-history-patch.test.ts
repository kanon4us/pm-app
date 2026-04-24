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
        eq: jest.fn().mockReturnValue({
          select: jest.fn().mockResolvedValue({ data: [{ id: 'conv-1' }], error: null, count: 1 }),
        }),
      }),
    }),
  })
}

function mockConvNotFound() {
  mockFrom.mockReturnValueOnce({
    update: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          select: jest.fn().mockResolvedValue({ data: [], error: null, count: 0 }),
        }),
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

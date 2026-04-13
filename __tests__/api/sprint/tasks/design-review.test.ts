const mockFrom = jest.fn()
const mockFetch = jest.fn()
global.fetch = mockFetch as typeof fetch

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({ from: mockFrom }),
}))

jest.mock('@/lib/auth', () => ({
  auth: jest.fn().mockResolvedValue({ user: { email: 'pm@viscap.ai' } }),
}))

jest.mock('@anthropic-ai/sdk', () => ({
  default: jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({
          steps: [
            { stepNumber: 1, title: 'Login Screen', userStoryText: 'As a user I can log in', figmaFrameId: '1:2', figmaFrameName: 'Login Screen', type: 'mapped' },
          ],
          divergenceNotes: 'No major divergences.',
        }) }],
      }),
    },
  })),
}))

jest.mock('@/lib/figma/client', () => ({
  parseFigmaUrl: jest.fn().mockReturnValue({ fileKey: 'TestKey', nodeId: 'page:1' }),
  fetchFigmaFrames: jest.fn().mockResolvedValue({
    frames: [{ id: '1:2', name: 'Login Screen', thumbnailUrl: 'https://cdn.figma.com/img/1-2.png' }],
    warnings: [],
  }),
}))

import { POST } from '@/app/api/sprint/tasks/[id]/assess/[conversationId]/design-review/route'
import { NextRequest } from 'next/server'

function makeParams(id: string, conversationId: string) {
  return { params: Promise.resolve({ id, conversationId }) }
}

function makeRequest(body: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/sprint/tasks/task-1/assess/conv-1/design-review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ figmaLink: 'https://figma.com/design/TestKey/My-Design', ...body }),
  })
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

function mockConvFound(overrides: Record<string, unknown> = {}) {
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({
            data: { id: 'conv-1', task_id: 'task-1', design_review: null, ...overrides },
            error: null,
          }),
        }),
      }),
    }),
  })
}

function mockTaskFound() {
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({
          data: { id: 'task-1', name: 'Login Feature' },
          error: null,
        }),
      }),
    }),
  })
}

function mockObjectiveAssessments() {
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({
        data: [{ objective_id: 1, score: 5, reasoning: 'Backed by data' }],
        error: null,
      }),
    }),
  })
}

function mockFigmaToken() {
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({ data: { access_token: 'figma-token' }, error: null }),
        }),
      }),
    }),
  })
}

function mockConvUpdate() {
  mockFrom.mockReturnValueOnce({
    update: jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({ error: null }),
    }),
  })
}

beforeEach(() => {
  mockFrom.mockReset()
  mockFetch.mockReset()
  jest.clearAllMocks()
})

describe('POST /api/sprint/tasks/[id]/assess/[conversationId]/design-review', () => {
  it('returns 401 when not authenticated', async () => {
    const { auth } = require('@/lib/auth')
    auth.mockResolvedValueOnce(null)
    const res = await POST(makeRequest(), makeParams('task-1', 'conv-1'))
    expect(res.status).toBe(401)
  })

  it('returns cached result when design_review already exists', async () => {
    const cached = {
      steps: [{ stepNumber: 1, title: 'Cached Step', userStoryText: 'Cached story', figmaFrameId: null, figmaFrameName: null, type: 'not-yet-designed' }],
      divergenceNotes: 'Cached notes',
      figmaFrames: [],
      warnings: [],
      generatedAt: '2026-04-12T00:00:00Z',
    }
    mockUserFound()
    mockConvFound({ design_review: cached })

    const res = await POST(makeRequest(), makeParams('task-1', 'conv-1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cached).toBe(true)
    expect(body.steps[0].title).toBe('Cached Step')
    const { fetchFigmaFrames } = require('@/lib/figma/client')
    expect(fetchFigmaFrames).not.toHaveBeenCalled()
  })

  it('generates new result and persists it when no cache', async () => {
    mockUserFound()
    mockConvFound()
    mockTaskFound()
    mockObjectiveAssessments()
    mockFigmaToken()
    mockConvUpdate()

    const res = await POST(makeRequest(), makeParams('task-1', 'conv-1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cached).toBe(false)
    expect(body.steps).toHaveLength(1)
    expect(body.steps[0].title).toBe('Login Screen')
    expect(body.divergenceNotes).toBe('No major divergences.')
    expect(body.figmaFrames).toHaveLength(1)
  })

  it('includes figma_unavailable warning and still returns steps when Figma fails', async () => {
    const { fetchFigmaFrames } = require('@/lib/figma/client')
    fetchFigmaFrames.mockResolvedValueOnce({ frames: [], warnings: ['figma_api_error'] })

    mockUserFound()
    mockConvFound()
    mockTaskFound()
    mockObjectiveAssessments()
    mockFigmaToken()
    mockConvUpdate()

    const res = await POST(makeRequest(), makeParams('task-1', 'conv-1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.warnings).toContain('figma_unavailable')
    expect(body.figmaFrames).toHaveLength(0)
  })

  it('returns 500 when Claude call fails', async () => {
    const Anthropic = require('@anthropic-ai/sdk').default
    Anthropic.mockImplementationOnce(() => ({
      messages: { create: jest.fn().mockRejectedValue(new Error('API down')) },
    }))

    mockUserFound()
    mockConvFound()
    mockTaskFound()
    mockObjectiveAssessments()
    mockFigmaToken()

    const res = await POST(makeRequest(), makeParams('task-1', 'conv-1'))
    expect(res.status).toBe(500)
  })
})

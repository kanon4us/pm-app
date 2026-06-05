import { GET } from '@/app/api/developers/[email]/experiment/route'
import { NextRequest } from 'next/server'

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn(),
}))

function makeRequest(email: string) {
  return new NextRequest(`http://localhost/api/developers/${email}/experiment`)
}

function makeSupabaseMock(overrides: { version?: number; clickupSprintId?: string; startsAt?: string } = {}) {
  return {
    from: jest.fn().mockImplementation((table: string) => {
      const base = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: null }),
      }
      if (table === 'bundle_prompt_versions') {
        return { ...base, single: jest.fn().mockResolvedValue({ data: { version: overrides.version ?? 2 } }) }
      }
      if (table === 'sprints') {
        return {
          ...base,
          single: jest.fn().mockResolvedValue({
            data: {
              clickup_sprint_id: overrides.clickupSprintId ?? null,
              starts_at: overrides.startsAt ?? '2026-06-01T00:00:00Z',
            },
          }),
        }
      }
      return base
    }),
  }
}

describe('GET /api/developers/[email]/experiment', () => {
  it('returns experiment context with version, bundle_version, and sprint', async () => {
    const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(makeSupabaseMock({ version: 3, startsAt: '2026-07-01T00:00:00Z' }))

    const req = makeRequest('dev@example.com')
    const res = await GET(req, { params: Promise.resolve({ email: 'dev@example.com' }) })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.version).toBe('v1')
    expect(body.bundle_version).toBe(3)
    expect(body.sprint).toBe('2026-07')
  })

  it('returns sprint from clickup_sprint_id when it contains a date', async () => {
    const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(
      makeSupabaseMock({ clickupSprintId: 'sprint-2026-08-planning', startsAt: '2026-06-01T00:00:00Z' })
    )

    const req = makeRequest('dev@example.com')
    const res = await GET(req, { params: Promise.resolve({ email: 'dev@example.com' }) })

    const body = await res.json()
    expect(body.sprint).toBe('2026-08')
  })

  it('falls back to current month when no sprint data', async () => {
    const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')
    const mock = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: null }),
      }),
    }
    getSupabaseServiceClient.mockResolvedValue(mock)

    const req = makeRequest('dev@example.com')
    const res = await GET(req, { params: Promise.resolve({ email: 'dev@example.com' }) })

    const body = await res.json()
    expect(body.version).toBe('v1')
    expect(body.bundle_version).toBe(1) // default when no active version
    expect(body.sprint).toMatch(/^\d{4}-\d{2}$/) // current month format
  })
})

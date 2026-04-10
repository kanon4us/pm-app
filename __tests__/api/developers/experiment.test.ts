/**
 * Integration tests for GET /api/developers/[email]/experiment
 */

const mockFrom = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({
    from: mockFrom,
  }),
}))

import { GET } from '@/app/api/developers/[email]/experiment/route'
import { NextRequest } from 'next/server'

const VALID_KEY = 'test-key'

beforeEach(() => {
  process.env.VIDF_HOOK_API_KEY = VALID_KEY
  jest.clearAllMocks()
})

function makeRequest(email: string, key?: string) {
  const url = `http://localhost/api/developers/${encodeURIComponent(email)}/experiment`
  return new NextRequest(url, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  })
}

function mockDbFound(row: Record<string, unknown>) {
  const chain = { eq: jest.fn().mockReturnThis(), single: jest.fn().mockResolvedValue({ data: row, error: null }) }
  mockFrom.mockReturnValue({ select: jest.fn().mockReturnValue(chain) })
}

function mockDbNotFound() {
  const chain = {
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
  }
  const upsertChain = {
    select: jest.fn().mockReturnValue({
      single: jest.fn().mockResolvedValue({
        data: {
          id: 'new-id', github_email: 'new@example.com', github_username: null,
          vidf_tag: 'pre', bundle_version: 'v0', sop_version: 'v0', sprint: '2026-04',
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        },
        error: null,
      })
    })
  }
  mockFrom
    .mockReturnValueOnce({ select: jest.fn().mockReturnValue(chain) })
    .mockReturnValueOnce({ upsert: jest.fn().mockReturnValue(upsertChain) })
}

describe('GET /api/developers/[email]/experiment', () => {
  it('returns 401 with no API key', async () => {
    const res = await GET(makeRequest('dev@example.com'), { params: Promise.resolve({ email: 'dev@example.com' }) })
    expect(res.status).toBe(401)
  })

  it('returns 401 with wrong API key', async () => {
    const res = await GET(makeRequest('dev@example.com', 'wrong-key'), { params: Promise.resolve({ email: 'dev@example.com' }) })
    expect(res.status).toBe(401)
  })

  it('returns experiment data for known developer', async () => {
    mockDbFound({
      id: 'uuid-1', github_email: 'dev@viscap.ai', github_username: 'devviscap',
      vidf_tag: 'v1', bundle_version: 'v1.0', sop_version: 'v1', sprint: '2026-04',
      created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
    })
    const res = await GET(makeRequest('dev@viscap.ai', VALID_KEY), { params: Promise.resolve({ email: 'dev@viscap.ai' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tag).toBe('v1')
    expect(body.bundle_version).toBe('v1.0')
    expect(body.sop_version).toBe('v1')
    expect(body.sprint).toBe('2026-04')
  })

  it('auto-registers unknown developer with pre-vidf defaults', async () => {
    mockDbNotFound()
    const res = await GET(makeRequest('new@example.com', VALID_KEY), { params: Promise.resolve({ email: 'new@example.com' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tag).toBe('pre')
    expect(body.bundle_version).toBe('v0')
  })

  it('returns the commit tag string', async () => {
    mockDbFound({
      id: 'uuid-1', github_email: 'dev@viscap.ai', github_username: null,
      vidf_tag: 'pre', bundle_version: 'v0', sop_version: 'v0', sprint: '2026-04',
      created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
    })
    const res = await GET(makeRequest('dev@viscap.ai', VALID_KEY), { params: Promise.resolve({ email: 'dev@viscap.ai' }) })
    const body = await res.json()
    expect(body.commit_tag).toBe('[vidf:pre | bundle:v0 | sop:v0 | sprint:2026-04]')
  })
})

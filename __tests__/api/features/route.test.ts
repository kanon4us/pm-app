// __tests__/api/features/route.test.ts
import { GET, POST } from '@/app/api/features/route'
import { NextRequest } from 'next/server'

jest.mock('@/lib/features/client', () => ({
  listFeatures: jest.fn().mockResolvedValue([{ id: 'f-1', name: 'Login', status: 'draft' }]),
  createFeature: jest.fn().mockResolvedValue({ id: 'f-2', name: 'New', status: 'draft' }),
}))
jest.mock('@/lib/auth', () => ({
  getSessionUser: jest.fn().mockResolvedValue({ email: 'pm@test.com' }),
}))

describe('GET /api/features', () => {
  it('returns feature list', async () => {
    const req = new NextRequest('http://localhost/api/features')
    const res = await GET(req)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toHaveLength(1)
    expect(json[0].id).toBe('f-1')
  })
})

describe('POST /api/features', () => {
  it('creates a feature', async () => {
    const req = new NextRequest('http://localhost/api/features', {
      method: 'POST',
      body: JSON.stringify({ name: 'New' }),
    })
    const res = await POST(req)
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.id).toBe('f-2')
  })
})

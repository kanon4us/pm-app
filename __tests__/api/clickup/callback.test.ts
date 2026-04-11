import { GET } from '@/app/api/clickup/callback/route'
import { NextRequest } from 'next/server'

jest.mock('next-auth/jwt', () => ({ encode: jest.fn().mockResolvedValue('mock-token') }))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({
    from: jest.fn().mockReturnValue({
      upsert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: { id: 'user-1' } }),
    }),
  }),
}))

describe('GET /api/clickup/callback', () => {
  beforeEach(() => {
    (global.fetch as jest.Mock) = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { email: 'u@test.com', username: 'u', id: 1, profilePicture: null } }), { status: 200 }))
  })

  it('redirects to /setup by default when no callbackUrl cookie', async () => {
    const req = new NextRequest('http://localhost/api/clickup/callback?code=abc')
    const res = await GET(req)
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/setup')
    expect(res.headers.get('location')).not.toContain('/sprint')
  })

  it('redirects to callbackUrl cookie value when present and safe', async () => {
    const req = new NextRequest('http://localhost/api/clickup/callback?code=abc')
    req.cookies.set('callbackUrl', '/sprint')
    const res = await GET(req)
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/sprint')
  })

  it('falls back to /setup when callbackUrl cookie contains external URL', async () => {
    const req = new NextRequest('http://localhost/api/clickup/callback?code=abc')
    req.cookies.set('callbackUrl', 'https://evil.com')
    const res = await GET(req)
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/setup')
    expect(res.headers.get('location')).not.toContain('evil.com')
  })
})

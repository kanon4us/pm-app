import { NextRequest } from 'next/server'
import { proxy } from '@/proxy'

jest.mock('next-auth/jwt', () => ({
  decode: jest.fn(),
}))

import { decode } from 'next-auth/jwt'
const mockDecode = decode as jest.Mock

const NEXTAUTH_SECRET = 'test-secret'
process.env.NEXTAUTH_SECRET = NEXTAUTH_SECRET

function makeRequest(url: string, cookieValue?: string): NextRequest {
  const req = new NextRequest(url)
  if (cookieValue) {
    req.cookies.set('authjs.session-token', cookieValue)
  }
  return req
}

describe('proxy — public paths', () => {
  it('passes /setup through without checking session', async () => {
    const res = await proxy(makeRequest('http://localhost/setup'))
    expect(res.status).not.toBe(302)
    expect(res.headers.get('location')).toBeNull()
  })

  it('passes /api/clickup/connect through', async () => {
    const res = await proxy(makeRequest('http://localhost/api/clickup/connect'))
    expect(res.headers.get('location')).toBeNull()
  })

  it('passes /api/clickup/callback through', async () => {
    const res = await proxy(makeRequest('http://localhost/api/clickup/callback?code=abc'))
    expect(res.headers.get('location')).toBeNull()
  })

  it('passes /api/github/connect through', async () => {
    const res = await proxy(makeRequest('http://localhost/api/github/connect'))
    expect(res.headers.get('location')).toBeNull()
  })

  it('passes /api/github/callback through', async () => {
    const res = await proxy(makeRequest('http://localhost/api/github/callback?code=abc'))
    expect(res.headers.get('location')).toBeNull()
  })

  it('passes /api/webhooks/clickup through', async () => {
    const res = await proxy(makeRequest('http://localhost/api/webhooks/clickup'))
    expect(res.headers.get('location')).toBeNull()
  })

  it('passes /api/vault/consolidation/process through (QStash signature-authed)', async () => {
    const res = await proxy(makeRequest('http://localhost/api/vault/consolidation/process'))
    expect(res.headers.get('location')).toBeNull()
    expect(res.status).not.toBe(401)
  })

  it('passes /api/vault/consolidation/write through (QStash signature-authed)', async () => {
    const res = await proxy(makeRequest('http://localhost/api/vault/consolidation/write'))
    expect(res.headers.get('location')).toBeNull()
    expect(res.status).not.toBe(401)
  })

  it('passes /api/features/f1/figma-layout through (plugin token-authed)', async () => {
    const res = await proxy(makeRequest('http://localhost/api/features/f1/figma-layout'))
    expect(res.headers.get('location')).toBeNull()
    expect(res.status).not.toBe(401)
  })

  it('passes /api/features/f1/figma-file through (plugin token-authed)', async () => {
    const res = await proxy(makeRequest('http://localhost/api/features/f1/figma-file'))
    expect(res.headers.get('location')).toBeNull()
    expect(res.status).not.toBe(401)
  })
})

describe('proxy — ClickUp OAuth redirect', () => {
  it('redirects /?code=abc to /api/clickup/callback?code=abc', async () => {
    const res = await proxy(makeRequest('http://localhost/?code=abc123'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/api/clickup/callback')
    expect(res.headers.get('location')).toContain('code=abc123')
  })
})

describe('proxy — unauthenticated requests', () => {
  beforeEach(() => mockDecode.mockResolvedValue(null))

  it('redirects to /setup when decode throws', async () => {
    mockDecode.mockRejectedValue(new Error('decryption failed'))
    const res = await proxy(makeRequest('http://localhost/sprint'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/setup')
  })

  it('returns 401 when decode throws on API request', async () => {
    mockDecode.mockRejectedValue(new Error('decryption failed'))
    const res = await proxy(makeRequest('http://localhost/api/sprint'))
    expect(res.status).toBe(401)
  })

  it('redirects unauthenticated page request to /setup', async () => {
    const res = await proxy(makeRequest('http://localhost/sprint'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/setup')
  })

  it('sets callbackUrl cookie when redirecting page request', async () => {
    const res = await proxy(makeRequest('http://localhost/sprint'))
    const cookie = res.cookies.get('callbackUrl')
    expect(cookie?.value).toBe('/sprint')
  })

  it('returns 401 JSON for unauthenticated API request', async () => {
    const res = await proxy(makeRequest('http://localhost/api/sprint'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('still gates /api/vault/doc-review — consolidation prefix must not expose the UI routes', async () => {
    const res = await proxy(makeRequest('http://localhost/api/vault/doc-review'))
    expect(res.status).toBe(401)
  })

  it('still gates /api/features/f1/publish-payload — session-gated, not token-gated', async () => {
    const res = await proxy(makeRequest('http://localhost/api/features/f1/publish-payload'))
    expect(res.status).toBe(401)
  })

  it('still gates /api/features/f1 — the base feature route stays session-gated', async () => {
    const res = await proxy(makeRequest('http://localhost/api/features/f1'))
    expect(res.status).toBe(401)
  })
})

describe('proxy — authenticated requests', () => {
  beforeEach(() => mockDecode.mockResolvedValue({ sub: '123', email: 'user@test.com' }))

  it('passes authenticated page request through', async () => {
    const res = await proxy(makeRequest('http://localhost/sprint', 'valid-token'))
    expect(res.headers.get('location')).toBeNull()
  })

  it('passes authenticated API request through', async () => {
    const res = await proxy(makeRequest('http://localhost/api/sprint', 'valid-token'))
    expect(res.headers.get('location')).toBeNull()
    expect(res.status).not.toBe(401)
  })
})

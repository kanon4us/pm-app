# Access Control — ClickUp Login Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate all app routes behind ClickUp OAuth login by extending `proxy.ts` with a JWT session check, threading a post-login redirect through a cookie, and adding a client-side 401 handler.

**Architecture:** `proxy.ts` reads the NextAuth JWT cookie on every request using `decode()` from `next-auth/jwt`. Unauthenticated page requests redirect to `/setup` with a short-lived `callbackUrl` cookie; API requests return 401 JSON. After OAuth completes, `callback/route.ts` reads and validates the cookie and redirects to the original path. A `lib/fetch.ts` wrapper handles 401s in client components by hard-redirecting to `/setup`.

**Tech Stack:** Next.js 16 App Router proxy, `next-auth/jwt` (decode), Jest + ts-jest (node + jsdom environments)

---

### Task 1: `lib/fetch.ts` — client-side 401 handler

**Files:**
- Create: `lib/fetch.ts`
- Create: `__tests__/lib/fetch.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `__tests__/lib/fetch.test.tsx` (jsdom environment — `.tsx` extension):

```ts
import { apiFetch } from '@/lib/fetch'

describe('apiFetch', () => {
  const originalLocation = window.location

  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: '' },
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    })
  })

  it('returns the response for successful requests', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const res = await apiFetch('/api/sprint')
    expect(res.status).toBe(200)
    expect(window.location.href).toBe('')
  })

  it('redirects to /setup on 401', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 }))
    await apiFetch('/api/sprint')
    expect(window.location.href).toBe('/setup')
  })

  it('returns non-401 error responses without redirecting', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('error', { status: 500 }))
    const res = await apiFetch('/api/sprint')
    expect(res.status).toBe(500)
    expect(window.location.href).toBe('')
  })

  it('passes init options through to fetch', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    await apiFetch('/api/sprint', { method: 'POST', body: '{}' })
    expect(global.fetch).toHaveBeenCalledWith('/api/sprint', { method: 'POST', body: '{}' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --testPathPattern="__tests__/lib/fetch" --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/fetch'`

- [ ] **Step 3: Implement `lib/fetch.ts`**

```ts
export async function apiFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init)
  if (res.status === 401) {
    window.location.href = '/setup'
  }
  return res
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- --testPathPattern="__tests__/lib/fetch" --no-coverage
```

Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add lib/fetch.ts __tests__/lib/fetch.test.tsx
git commit -m "feat: add apiFetch wrapper with 401 redirect to /setup"
```

---

### Task 2: Extend `proxy.ts` — auth gate + callbackUrl cookie

**Files:**
- Modify: `proxy.ts`
- Create: `__tests__/proxy.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/proxy.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --testPathPattern="__tests__/proxy" --no-coverage
```

Expected: FAIL — most tests fail because proxy has no auth logic yet

- [ ] **Step 3: Implement the new `proxy.ts`**

```ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { decode } from 'next-auth/jwt'

const PUBLIC_PATHS = [
  '/setup',
  '/api/clickup/connect',
  '/api/clickup/callback',
  '/api/github/connect',
  '/api/github/callback',
  '/api/webhooks/clickup',
]

function isSafeRedirect(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//') && !url.includes('://')
}

export async function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl

  // 1. Public paths — no auth required
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  // 2. ClickUp OAuth redirect — forward /?code=... to callback handler
  if (pathname === '/' && searchParams.has('code')) {
    const callbackUrl = new URL('/api/clickup/callback', request.url)
    callbackUrl.search = searchParams.toString()
    return NextResponse.redirect(callbackUrl)
  }

  // 3. Session check
  const isSecure = request.url.startsWith('https://')
  const cookieName = isSecure ? '__Secure-authjs.session-token' : 'authjs.session-token'
  const token = await decode({
    token: request.cookies.get(cookieName)?.value,
    secret: process.env.NEXTAUTH_SECRET!,
    salt: cookieName,
  })

  if (!token) {
    // API requests get 401 JSON
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Page requests redirect to /setup with callbackUrl cookie
    const redirectTo = new URL('/setup', request.url)
    const response = NextResponse.redirect(redirectTo)
    const returnPath = pathname + (request.nextUrl.search || '')
    if (isSafeRedirect(returnPath)) {
      response.cookies.set('callbackUrl', returnPath, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 10 * 60, // 10 minutes
      })
    }
    return response
  }

  // 4. Authenticated — proceed
  // TODO: service account / AI agent auth
  // const authHeader = request.headers.get('Authorization')
  // if (authHeader?.startsWith('Bearer ')) {
  //   const apiToken = authHeader.slice(7)
  //   if (await isValidServiceToken(apiToken)) return NextResponse.next()
  // }
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|_next/data|favicon.ico|.*\\.svg$|.*\\.png$|.*\\.ico$).*)'],
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- --testPathPattern="__tests__/proxy" --no-coverage
```

Expected: PASS — all tests

- [ ] **Step 5: Commit**

```bash
git add proxy.ts __tests__/proxy.test.ts
git commit -m "feat: add auth gate to proxy with callbackUrl cookie and public allowlist"
```

---

### Task 3: Update `callback/route.ts` — redirect to callbackUrl after login

**Files:**
- Modify: `app/api/clickup/callback/route.ts` (line 64)

- [ ] **Step 1: Write the failing test**

Add to the existing test file (or note: there is no existing test for this route — create `__tests__/api/clickup/callback.test.ts`):

```ts
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

global.fetch = jest.fn()
  .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }))
  .mockResolvedValueOnce(new Response(JSON.stringify({ user: { email: 'u@test.com', username: 'u', id: 1, profilePicture: null } }), { status: 200 }))

describe('GET /api/clickup/callback', () => {
  beforeEach(() => {
    (global.fetch as jest.Mock).mockReset()
    ;(global.fetch as jest.Mock)
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --testPathPattern="__tests__/api/clickup/callback" --no-coverage
```

Expected: FAIL — redirect always goes to `/setup`, ignoring cookie

- [ ] **Step 3: Update `app/api/clickup/callback/route.ts`**

Replace lines 64–72 (the redirect + cookie set block) with:

```ts
  // Determine post-login redirect destination
  function isSafeRedirect(url: string): boolean {
    return url.startsWith('/') && !url.startsWith('//') && !url.includes('://')
  }
  const callbackUrlCookie = request.cookies.get('callbackUrl')?.value ?? ''
  const destination = isSafeRedirect(callbackUrlCookie) ? callbackUrlCookie : '/setup'

  const response = NextResponse.redirect(new URL(destination, request.url))
  response.cookies.set(cookieName, sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isSecure,
    maxAge: 30 * 24 * 60 * 60,
  })
  // Clear the callbackUrl cookie now that we've consumed it
  response.cookies.delete('callbackUrl')
  return response
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- --testPathPattern="__tests__/api/clickup/callback" --no-coverage
```

Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add app/api/clickup/callback/route.ts __tests__/api/clickup/callback.test.ts
git commit -m "feat: redirect to callbackUrl after ClickUp OAuth login"
```

---

### Task 4: Update `app/sprint/page.tsx` — use `apiFetch`

**Files:**
- Modify: `app/sprint/page.tsx`

- [ ] **Step 1: Add the import**

At the top of `app/sprint/page.tsx`, add:

```ts
import { apiFetch } from '@/lib/fetch'
```

- [ ] **Step 2: Replace all `fetch(` calls with `apiFetch(`**

Run this to verify the count first:

```bash
grep -c "fetch(" app/sprint/page.tsx
```

Expected: `10` (10 raw fetch calls)

Now replace — open `app/sprint/page.tsx` and replace every `fetch(` with `apiFetch(`. There should be no remaining raw `fetch(` calls after this step (other than in comments).

Verify:

```bash
grep -n "fetch(" app/sprint/page.tsx
```

Expected: 0 lines (all replaced)

- [ ] **Step 3: Run the full test suite**

```bash
npm test --no-coverage
```

Expected: all existing tests pass, no regressions

- [ ] **Step 4: Commit**

```bash
git add app/sprint/page.tsx
git commit -m "feat: use apiFetch in sprint page for 401 session expiry handling"
```

---

### Task 5: Full test run + deploy

- [ ] **Step 1: Run full test suite**

```bash
npm test --no-coverage
```

Expected: all tests pass

- [ ] **Step 2: Deploy to production**

```bash
vercel --prod
```

Expected: READY, no build warnings about deprecated `middleware` file

- [ ] **Step 3: Smoke test the auth gate**

1. Open a private/incognito window
2. Visit `https://viscap.edgefixautomation.com/sprint`
3. Expected: redirected to `/setup`
4. Click "Connect ClickUp" and complete OAuth
5. Expected: redirected back to `/sprint` (not `/setup`)
6. Visit `https://viscap.edgefixautomation.com/` — expected: loads Trigger Queue (authenticated)

# Access Control — ClickUp Login Gate

**Date:** 2026-04-10
**Status:** Approved

## Problem

All pages and API routes in the Viscap PM app are currently publicly accessible with no authentication required. Any user can reach `/`, `/sprint`, `/triggers/config`, and all API endpoints without logging in.

## Goal

Require every user to authenticate via ClickUp OAuth before accessing any part of the app. The existing ClickUp OAuth flow (`/setup` → ClickUp → callback → session cookie) becomes the mandatory entry point.

## Approach

Extend `proxy.ts` with a session gate. The proxy runs before every request, checks for a valid NextAuth JWT session cookie, and redirects or rejects unauthenticated requests. No per-page changes needed — the gate is enforced in one place.

## Public Allowlist

The following routes bypass the auth check entirely:

| Route | Reason |
|---|---|
| `/setup` | Login page — must be reachable without a session |
| `/api/clickup/connect` | Initiates ClickUp OAuth — requires no session |
| `/api/clickup/callback` | Completes ClickUp OAuth and sets the session cookie |
| `/api/github/connect` | Initiates GitHub OAuth |
| `/api/github/callback` | Completes GitHub OAuth |
| `/api/webhooks/clickup` | Receives ClickUp webhook events — called by ClickUp servers, uses HMAC secret auth (already verified inside the route via `verifyClickUpSignature()`) |

## Session Check

Uses `decode()` from `@auth/core/jwt` to cryptographically verify the NextAuth session cookie. No database call — purely JWT signature verification. Cookie name is environment-aware:

- HTTPS: `__Secure-authjs.session-token`
- HTTP: `authjs.session-token`

The `salt` matches what the ClickUp callback sets, so existing sessions remain valid across the change.

**Token expiration:** `decode()` returns null for expired tokens. Expired sessions redirect to `/setup` for re-login. No silent refresh — ClickUp's OAuth flow does not issue refresh tokens.

## Response Behavior

| Request type | Unauthenticated response |
|---|---|
| Page request (non-`/api/`) | `302` redirect to `/setup?callbackUrl=<encoded-path>` |
| API request (`/api/…`) | `401 JSON { error: 'Unauthorized' }` |

## callbackUrl Deep Linking

When redirecting a page request to `/setup`, the proxy appends the original path as `?callbackUrl=<encoded-path>`. The ClickUp callback route reads a `callbackUrl` cookie (set before the OAuth redirect) and redirects the user there after successful login.

**Open redirect protection:** The callbackUrl is validated before use — it must start with `/` and must not start with `//` or contain `://`. Any invalid value falls back to `/`. This prevents an attacker from crafting a link like `?callbackUrl=https://malicious-site.com`.

```ts
function isSafeRedirect(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//') && !url.includes('://')
}
```

Flow:
1. Unauthenticated user visits `/sprint`
2. Proxy redirects to `/setup?callbackUrl=%2Fsprint`, also sets a short-lived `callbackUrl` cookie
3. User completes ClickUp OAuth
4. Callback route reads `callbackUrl` cookie → validates it → redirects to `/sprint`

## Frontend 401 Handling

No fetch wrapper currently exists — all client-side fetches are raw `fetch()` calls (e.g., in `app/sprint/page.tsx`). Without handling, a 401 from an expired session will cause silent data fetch failures and infinite loading states.

A thin `lib/fetch.ts` wrapper will be added that checks the response status and performs a hard redirect to `/setup` on 401:

```ts
export async function apiFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init)
  if (res.status === 401) {
    window.location.href = '/setup'
    return res // unreachable but satisfies types
  }
  return res
}
```

All client-side `fetch()` calls in page components are updated to use `apiFetch()`.

## Execution Order in proxy.ts

1. Public allowlist check → `next()` if matched
2. ClickUp OAuth redirect (`/?code=…`) → forward to `/api/clickup/callback`
3. Session decode → redirect (with validated callbackUrl) or 401 if invalid
4. `next()` — authenticated, proceed

## Matcher

```ts
export const config = {
  matcher: ['/((?!_next/static|_next/image|_next/data|favicon.ico|.*\\.svg$|.*\\.png$|.*\\.ico$).*)'],
}
```

Excludes Next.js internals and common static file extensions from the public folder. Extension-based exclusions are kept minimal — only types that actually exist in `public/` (`.svg`, `.png`, `.ico`). New static asset types should be added here when introduced.

## Future: Service Account / Agent Auth

When AI agents or service accounts need to call Viscap PM APIs, add a `Authorization: Bearer <token>` header check in the proxy before the session cookie check:

```ts
// TODO: service account / AI agent auth
// const authHeader = request.headers.get('Authorization')
// if (authHeader?.startsWith('Bearer ')) {
//   const token = authHeader.slice(7)
//   if (await isValidServiceToken(token)) return NextResponse.next()
// }
```

Standard JWT Bearer tokens are the target format. This is out of scope for the current implementation.

## Files Changed

| File | Change |
|---|---|
| `proxy.ts` | Add auth gate, expand matcher, validate callbackUrl |
| `app/api/clickup/callback/route.ts` | Read `callbackUrl` cookie, validate, redirect after login |
| `lib/fetch.ts` | New: thin fetch wrapper with 401 → `/setup` redirect |
| `app/sprint/page.tsx` | Swap `fetch()` → `apiFetch()` |

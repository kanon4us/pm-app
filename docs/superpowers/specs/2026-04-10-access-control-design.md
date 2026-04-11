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

When redirecting a page request to `/setup`, the proxy appends the original path as `?callbackUrl=<encoded-path>`. The ClickUp callback route reads this value (passed through as a cookie set before the OAuth redirect) and redirects the user there after a successful login instead of always landing on `/`.

Flow:
1. Unauthenticated user visits `/sprint`
2. Proxy redirects to `/setup?callbackUrl=%2Fsprint`, also sets a `callbackUrl` cookie
3. User completes ClickUp OAuth
4. Callback route reads `callbackUrl` cookie → redirects to `/sprint`

## Execution Order in proxy.ts

1. Public allowlist check → `next()` if matched
2. ClickUp OAuth redirect (`/?code=…`) → forward to `/api/clickup/callback`
3. Session decode → redirect (with callbackUrl) or 401 if invalid
4. `next()` — authenticated, proceed

## Matcher

```ts
export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico|.*\\.svg$|.*\\.png$|.*\\.jpg$|.*\\.ico$).*)',
}
```

Expanded from `'/'` to cover all routes. Static assets (Next.js internals and public folder files like SVGs) are excluded to avoid unnecessary overhead and incorrect auth redirects.

## Future: Service Account / Agent Auth

When AI agents or service accounts need to call Viscap PM APIs, add a header-based check in the proxy before the session cookie check:

```ts
// TODO: add header-based auth for service accounts
// const apiKey = request.headers.get('Authorization')
// if (apiKey && isValidApiKey(apiKey)) return NextResponse.next()
```

This is out of scope for the current implementation.

## No Changes Required

- `lib/auth.ts` — unchanged
- Individual pages — no per-page auth checks needed
- Webhook route — HMAC verification already in place inside the route

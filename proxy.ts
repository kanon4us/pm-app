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
  '/api/webhooks/slack',
  '/api/cron/slack-stale-check',
]

function isSafeRedirect(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//') && !url.includes('://')
}

export async function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl

  // 1. Public paths — no auth required
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
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
  let token = null
  try {
    token = await decode({
      token: request.cookies.get(cookieName)?.value,
      secret: process.env.NEXTAUTH_SECRET!,
      salt: cookieName,
    })
  } catch {
    token = null
  }

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
        secure: isSecure,
      })
    }
    return response
  }

  // 4. Authenticated — proceed
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.svg$|.*\\.png$|.*\\.ico$).*)'],
}

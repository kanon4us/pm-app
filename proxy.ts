import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl

  // ClickUp only allows base URL as redirect — forward OAuth params to NextAuth callback
  if (pathname === '/' && searchParams.has('code')) {
    const callbackUrl = new URL('/api/clickup/callback', request.url)
    callbackUrl.search = searchParams.toString()
    return NextResponse.redirect(callbackUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: '/',
}

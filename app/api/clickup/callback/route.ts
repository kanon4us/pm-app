import { NextRequest, NextResponse } from 'next/server'
import { encode } from 'next-auth/jwt'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import type { InsertDto } from '@/lib/supabase/types'

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  if (!code) return NextResponse.redirect(new URL('/setup', request.url))

  // Exchange code for access token
  const tokenRes = await fetch('https://api.clickup.com/api/v2/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.CLICKUP_CLIENT_ID,
      client_secret: process.env.CLICKUP_CLIENT_SECRET,
      code,
    }),
  })
  if (!tokenRes.ok) return NextResponse.redirect(new URL('/setup?error=token', request.url))
  const { access_token } = await tokenRes.json()

  // Get ClickUp user info
  const userRes = await fetch('https://api.clickup.com/api/v2/user', {
    headers: { Authorization: `Bearer ${access_token}` },
  })
  if (!userRes.ok) return NextResponse.redirect(new URL('/setup?error=user', request.url))
  const { user: cuUser } = await userRes.json()

  // Upsert user + store token in Supabase
  const supabase = await getSupabaseServiceClient()
  const userInsert: InsertDto<'users'> = { email: cuUser.email }
  const { data: dbUser } = await supabase
    .from('users')
    .upsert(userInsert, { onConflict: 'email' })
    .select('id')
    .single()

  if (dbUser) {
    const tokenInsert: InsertDto<'oauth_tokens'> = {
      user_id: dbUser.id,
      provider: 'clickup',
      access_token,
      refresh_token: null,
      token_expires_at: null,
    }
    await supabase.from('oauth_tokens').upsert(tokenInsert, { onConflict: 'user_id,provider' })
  }

  // Create NextAuth v5 session cookie manually
  const isSecure = request.url.startsWith('https://')
  const cookieName = isSecure ? '__Secure-authjs.session-token' : 'authjs.session-token'
  const sessionToken = await encode({
    token: {
      name: cuUser.username,
      email: cuUser.email,
      picture: cuUser.profilePicture ?? null,
      sub: String(cuUser.id),
    },
    secret: process.env.NEXTAUTH_SECRET!,
    salt: cookieName,
  })

  // Determine post-login redirect destination — validate callbackUrl to prevent open redirect
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
}

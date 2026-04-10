import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const code = searchParams.get('code')
  const state = searchParams.get('state')

  const cookieStore = await cookies()
  const savedState = cookieStore.get('github_oauth_state')?.value
  cookieStore.delete('github_oauth_state')

  if (!code || !state || state !== savedState) {
    return NextResponse.redirect(new URL('/setup?error=github_state', request.url))
  }

  // Exchange code for access token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  })
  if (!tokenRes.ok) return NextResponse.redirect(new URL('/setup?error=github_token', request.url))
  const { access_token, error } = await tokenRes.json()
  if (error || !access_token) return NextResponse.redirect(new URL('/setup?error=github_token', request.url))

  // Get authenticated user from session
  const session = await auth()
  if (!session?.user?.email) return NextResponse.redirect(new URL('/setup?error=session', request.url))

  const supabase = await getSupabaseServiceClient()
  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.redirect(new URL('/setup?error=user', request.url))

  await supabase.from('oauth_tokens').upsert(
    { user_id: user.id, provider: 'github', access_token },
    { onConflict: 'user_id,provider' }
  )

  return NextResponse.redirect(new URL('/setup', request.url))
}

import NextAuth from 'next-auth'
import type { NextAuthConfig } from 'next-auth'
import { getSupabaseServiceClient } from './supabase/server'
import type { InsertDto } from './supabase/types'

export const authConfig: NextAuthConfig = {
  providers: [
    {
      id: 'clickup',
      name: 'ClickUp',
      type: 'oauth',
      authorization: {
        url: 'https://app.clickup.com/api',
        params: { scope: '' },
      },
      token: 'https://api.clickup.com/api/v2/oauth/token',
      userinfo: 'https://api.clickup.com/api/v2/user',
      clientId: process.env.CLICKUP_CLIENT_ID,
      clientSecret: process.env.CLICKUP_CLIENT_SECRET,
      profile(profile) {
        const p = profile as { user: { id: number; username: string; email: string; profilePicture: string } }
        return {
          id: String(p.user.id),
          name: p.user.username,
          email: p.user.email,
          image: p.user.profilePicture,
        }
      },
    },
  ],
  callbacks: {
    async signIn({ user, account }) {
      if (!user.email || !account) return false
      const supabase = await getSupabaseServiceClient()

      // Upsert user
      const userInsert: InsertDto<'users'> = { email: user.email }
      const { data: dbUser, error: userError } = await supabase
        .from('users')
        .upsert(userInsert, { onConflict: 'email' })
        .select('id')
        .single()

      if (userError || !dbUser) return false

      // Store ClickUp token
      const tokenInsert: InsertDto<'oauth_tokens'> = {
        user_id: dbUser.id,
        provider: 'clickup',
        access_token: account.access_token!,
        refresh_token: account.refresh_token ?? null,
        token_expires_at: account.expires_at
          ? new Date(account.expires_at * 1000).toISOString()
          : null,
      }
      await supabase.from('oauth_tokens').upsert(tokenInsert, { onConflict: 'user_id,provider' })

      return true
    },
    async session({ session }) {
      if (!session.user?.email) return session
      const supabase = await getSupabaseServiceClient()
      const { data } = await supabase
        .from('users')
        .select('id')
        .eq('email', session.user.email)
        .single()
      if (data) (session.user as typeof session.user & { dbId: string }).dbId = data.id
      return session
    },
  },
  pages: { signIn: '/setup' },
}

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig)

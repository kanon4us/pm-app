import NextAuth from 'next-auth'
import type { NextAuthConfig } from 'next-auth'
import { getSupabaseServiceClient } from './supabase/server'

export const authConfig: NextAuthConfig = {
  providers: [],
  callbacks: {
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
  session: { strategy: 'jwt' },
}

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig)

export async function getSessionUser(): Promise<{ email: string; dbId?: string } | null> {
  const session = await auth()
  if (!session?.user?.email) return null
  return session.user as { email: string; dbId?: string }
}

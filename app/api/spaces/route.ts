import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildClickUpClient } from '@/lib/clickup/client'

// GET /api/spaces — returns all ClickUp spaces for the signed-in user
export async function GET() {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()
  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { data: token } = await supabase
    .from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'clickup').single()
  if (!token) return NextResponse.json({ error: 'ClickUp not connected' }, { status: 400 })

  const client = buildClickUpClient(token.access_token)
  const teams = await client.getTeams()
  const spaces: Array<{ id: string; name: string; teamId: string }> = []

  for (const team of teams) {
    const teamSpaces = await client.getSpaces(team.id)
    spaces.push(...teamSpaces.map((s) => ({ id: s.id, name: s.name, teamId: team.id })))
  }

  return NextResponse.json({ spaces, teamId: teams[0]?.id })
}

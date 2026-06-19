import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

// GET /api/dev-team - list dev team members
export async function GET() {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()
  const { data: members, error } = await supabase
    .from('dev_team_members')
    .select('id, name, slack_id, clickup_email, active, created_at, updated_at')
    .order('name', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ members })
}

// POST /api/dev-team - create a dev team member
export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { name, slack_id, clickup_email, active } = body
  if (!name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 })
  if (!slack_id?.trim()) return NextResponse.json({ error: 'Slack ID is required' }, { status: 400 })

  const supabase = await getSupabaseServiceClient()
  const { data: member, error } = await supabase
    .from('dev_team_members')
    .insert({
      name: name.trim(),
      slack_id: slack_id.trim(),
      clickup_email: clickup_email?.trim() || null,
      active: active ?? true,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'A member with this Slack ID already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ member }, { status: 201 })
}

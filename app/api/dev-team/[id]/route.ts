import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

// PUT /api/dev-team/[id] - update a dev team member
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body = await request.json()
  const { name, slack_id, clickup_email, active } = body

  const updateData: Record<string, string | boolean | null> = { updated_at: new Date().toISOString() }
  if (name !== undefined) updateData.name = name.trim()
  if (slack_id !== undefined) updateData.slack_id = slack_id.trim()
  if (clickup_email !== undefined) updateData.clickup_email = clickup_email?.trim() || null
  if (active !== undefined) updateData.active = active

  const supabase = await getSupabaseServiceClient()
  const { data: member, error } = await supabase
    .from('dev_team_members')
    .update(updateData)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'A member with this Slack ID already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!member) return NextResponse.json({ error: 'Member not found' }, { status: 404 })
  return NextResponse.json({ member })
}

// DELETE /api/dev-team/[id] - remove a dev team member
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const supabase = await getSupabaseServiceClient()
  const { error } = await supabase.from('dev_team_members').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

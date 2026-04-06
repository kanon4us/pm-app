import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { triggerId }: { triggerId: string } = await req.json()
  if (!triggerId) return NextResponse.json({ error: 'triggerId required' }, { status: 400 })

  const supabase = await getSupabaseServiceClient()
  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { error } = await supabase
    .from('trigger_queue')
    .update({ status: 'approved', approved_by: user.id, updated_at: new Date().toISOString() })
    .eq('id', triggerId)
    .eq('status', 'pending') // Only approve pending triggers

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Plan 2 will pick up 'approved' triggers and run the PM Agent
  return NextResponse.json({ ok: true })
}

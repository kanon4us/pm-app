import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { triggerId }: { triggerId: string } = await req.json()
  if (!triggerId) return NextResponse.json({ error: 'triggerId required' }, { status: 400 })

  const supabase = await getSupabaseServiceClient()

  const { error } = await supabase
    .from('trigger_queue')
    .update({ status: 'dismissed', updated_at: new Date().toISOString() })
    .eq('id', triggerId)
    .eq('status', 'pending')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

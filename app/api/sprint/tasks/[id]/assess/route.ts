import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

type Params = { params: Promise<{ id: string }> }

// GET /api/sprint/tasks/[id]/assess — list all assessment conversations for a task
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()

  const { data: conversations } = await supabase
    .from('assessment_conversations')
    .select('id, status, fvi_score, final_scores, effort, risk, created_at, completed_at')
    .eq('task_id', id)
    .order('created_at', { ascending: false })

  return NextResponse.json({ conversations: conversations ?? [] })
}

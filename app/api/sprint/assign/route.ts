import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

// PATCH /api/sprint/assign — assign or unassign tasks to a sprint
// Body: { taskIds: string[], sprintId: string | null }
export async function PATCH(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { taskIds, sprintId }: { taskIds: string[]; sprintId: string | null } = await req.json()
  if (!taskIds?.length) return NextResponse.json({ error: 'taskIds is required' }, { status: 400 })

  const supabase = await getSupabaseServiceClient()
  const { error } = await supabase
    .from('tasks')
    .update({ sprint_id: sprintId })
    .in('id', taskIds)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}

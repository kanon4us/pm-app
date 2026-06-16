import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

// GET /api/sprint/tasks — all tasks with their list name and sprint assignment
export async function GET() {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()

  const [{ data: tasks }, { data: lists }] = await Promise.all([
    supabase.from('tasks').select('id, clickup_task_id, name, status, sprint_id, fvi_score, cost_effort, cost_risk, inverted_influence, is_feature_flagged, git_branch, custom_fields, list_id, is_archived').eq('is_archived', false).order('created_at', { ascending: true }),
    supabase.from('lists').select('id, name'),
  ])

  const listNames = new Map((lists ?? []).map((l) => [l.id, l.name]))

  const result = (tasks ?? []).map((t) => ({
    ...t,
    listName: listNames.get(t.list_id) ?? t.list_id,
  }))

  return NextResponse.json({ tasks: result })
}

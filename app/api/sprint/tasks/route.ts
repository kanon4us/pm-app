import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

// GET /api/sprint/tasks — tasks with their list name and sprint assignment.
// Optional ?status=<value> narrows to one ClickUp status (case-insensitive) to
// keep the query small; ?status=all or omitted returns every non-archived task.
export async function GET(req: Request) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()

  const statusParam = new URL(req.url).searchParams.get('status')
  const statusFilter = statusParam && statusParam.toLowerCase() !== 'all' ? statusParam : null

  // custom_fields is intentionally NOT selected here — it is a large per-row
  // JSON blob only the task detail drawer needs, and the drawer fetches it live
  // from ClickUp via GET /api/sprint/tasks/[id]. Pulling it for every row bloated
  // this query (a contributor to the Sprint Planner's slow/heavy loads).
  let tasksQuery = supabase
    .from('tasks')
    .select('id, clickup_task_id, name, status, sprint_id, fvi_score, cost_effort, cost_risk, inverted_influence, is_feature_flagged, git_branch, list_id, is_archived')
    .eq('is_archived', false)
    .order('created_at', { ascending: true })
  if (statusFilter) tasksQuery = tasksQuery.ilike('status', statusFilter)

  const [{ data: tasks, error: tasksError }, { data: lists, error: listsError }] = await Promise.all([
    tasksQuery,
    supabase.from('lists').select('id, name'),
  ])

  // Surface DB errors instead of silently returning an empty list. (A swallowed
  // "column does not exist" error here previously made the Sprint Planner show
  // zero tasks when the is_archived migration had not been applied.)
  if (tasksError) return NextResponse.json({ error: tasksError.message }, { status: 500 })
  if (listsError) return NextResponse.json({ error: listsError.message }, { status: 500 })

  const listNames = new Map((lists ?? []).map((l) => [l.id, l.name]))

  const result = (tasks ?? []).map((t) => ({
    ...t,
    listName: listNames.get(t.list_id) ?? t.list_id,
  }))

  return NextResponse.json({ tasks: result })
}

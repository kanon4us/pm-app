import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildClickUpClient } from '@/lib/clickup/client'
import { detectArchivalChanges } from '@/lib/clickup/archive-detection'
import { groupStatusUpdates } from '@/lib/clickup/status-updates'

// POST /api/sprint/tasks/sync-status — refresh task statuses from ClickUp into Supabase
export async function POST() {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()

  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { data: token } = await supabase
    .from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'clickup').single()
  if (!token) return NextResponse.json({ error: 'ClickUp not connected' }, { status: 400 })

  const { data: tasks } = await supabase
    .from('tasks')
    .select('id, clickup_task_id, list_id, status, is_archived')

  if (!tasks || tasks.length === 0) return NextResponse.json({ updated: 0 })

  const client = buildClickUpClient(token.access_token)

  // Group tasks by list so we can batch-fetch per list
  const byList = new Map<string, typeof tasks>()
  for (const t of tasks) {
    const group = byList.get(t.list_id) ?? []
    group.push(t)
    byList.set(t.list_id, group)
  }

  // Build a clickup_task_id → new status map, tracking which lists we actually
  // fetched successfully. A failed list fetch must NOT cause its tasks to be
  // treated as archived (see archival logic below).
  const statusMap = new Map<string, string>()
  const fetchedListIds = new Set<string>()
  await Promise.all(
    [...byList.keys()].map(async (listId) => {
      try {
        const cuTasks = await client.getTasks(listId)
        for (const ct of cuTasks) {
          statusMap.set(ct.id, ct.status.status)
        }
        fetchedListIds.add(listId)
      } catch {
        // Non-fatal: skip lists that fail (e.g. deleted lists). Their tasks are
        // intentionally left untouched rather than being marked archived.
      }
    })
  )

  // Decide archival/reactivation. Only tasks whose list was fetched
  // successfully can be archived — see detectArchivalChanges for why a partial
  // fetch must not mass-archive (and blank the Sprint Planner).
  const activeTaskIds = new Set(statusMap.keys())
  const { archivedIds, reactivatedIds } = detectArchivalChanges({ tasks, activeTaskIds, fetchedListIds })

  // Batch update archived status
  if (archivedIds.length > 0) {
    await supabase.from('tasks').update({ is_archived: true }).in('id', archivedIds)
  }

  if (reactivatedIds.length > 0) {
    await supabase.from('tasks').update({ is_archived: false }).in('id', reactivatedIds)
  }

  // Update tasks whose status changed — ONE batched UPDATE per distinct new
  // status (was: one parallel UPDATE per task via Promise.all, which fanned out
  // N concurrent writes and could exhaust the PostgREST connection pool on a
  // large sync, wedging every other query). Distinct statuses are few, so this
  // is a short sequential loop.
  let updated = archivedIds.length + reactivatedIds.length
  const statusGroups = groupStatusUpdates(tasks, statusMap)
  for (const [newStatus, ids] of statusGroups) {
    const { error } = await supabase.from('tasks').update({ status: newStatus }).in('id', ids)
    if (!error) updated += ids.length
  }

  return NextResponse.json({ updated })
}

import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildClickUpClient } from '@/lib/clickup/client'

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
    .select('id, clickup_task_id, list_id, status')

  if (!tasks || tasks.length === 0) return NextResponse.json({ updated: 0 })

  const client = buildClickUpClient(token.access_token)

  // Group tasks by list so we can batch-fetch per list
  const byList = new Map<string, typeof tasks>()
  for (const t of tasks) {
    const group = byList.get(t.list_id) ?? []
    group.push(t)
    byList.set(t.list_id, group)
  }

  // Build a clickup_task_id → new status map
  const statusMap = new Map<string, string>()
  await Promise.all(
    [...byList.keys()].map(async (listId) => {
      try {
        const cuTasks = await client.getTasks(listId)
        for (const ct of cuTasks) {
          statusMap.set(ct.id, ct.status.status)
        }
      } catch {
        // Non-fatal: skip lists that fail (e.g. deleted lists)
      }
    })
  )

  // Update only tasks whose status changed
  let updated = 0
  await Promise.all(
    tasks.map(async (t) => {
      const newStatus = statusMap.get(t.clickup_task_id)
      if (newStatus === undefined || newStatus === t.status) return
      await supabase.from('tasks').update({ status: newStatus }).eq('id', t.id)
      updated++
    })
  )

  return NextResponse.json({ updated })
}

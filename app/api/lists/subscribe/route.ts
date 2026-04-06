import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildClickUpClient } from '@/lib/clickup/client'
import type { Json } from '@/lib/supabase/types'

// POST /api/lists/subscribe — subscribe to up to 10 lists, register webhooks, import tasks
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { listIds, teamId }: { listIds: string[]; teamId: string } = await req.json()
  if (!listIds?.length || listIds.length > 10)
    return NextResponse.json({ error: 'Provide 1–10 list IDs' }, { status: 400 })

  const supabase = await getSupabaseServiceClient()
  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { data: token } = await supabase
    .from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'clickup').single()
  if (!token) return NextResponse.json({ error: 'ClickUp not connected' }, { status: 400 })

  const client = buildClickUpClient(token.access_token)
  const webhookEndpoint = `${process.env.NEXTAUTH_URL}/api/webhooks/clickup`
  const results: Array<{ listId: string; taskCount: number }> = []

  for (const listId of listIds) {
    // Register ClickUp webhook
    const webhook = await client.createWebhook(teamId, webhookEndpoint, process.env.CLICKUP_WEBHOOK_SECRET!)

    // Upsert list record
    const { data: list } = await supabase
      .from('lists')
      .upsert(
        { user_id: user.id, clickup_list_id: listId, name: listId, webhook_id: webhook.webhook.id, synced_at: new Date().toISOString() },
        { onConflict: 'user_id,clickup_list_id' }
      )
      .select('id')
      .single()

    if (!list) continue

    // Import all tasks from this list
    const tasks = await client.getTasks(listId)
    if (tasks.length > 0) {
      await supabase.from('tasks').upsert(
        tasks.map((t) => ({
          clickup_task_id: t.id,
          list_id: list.id,
          name: t.name,
          status: t.status.status,
          custom_fields: (t.custom_fields ?? []) as unknown as Json, // custom_fields is a JSON-compatible array from ClickUp API
        })),
        { onConflict: 'clickup_task_id' }
      )
    }

    results.push({ listId, taskCount: tasks.length })
  }

  return NextResponse.json({ ok: true, results })
}

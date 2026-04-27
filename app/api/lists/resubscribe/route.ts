import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildClickUpClient } from '@/lib/clickup/client'
import type { Json } from '@/lib/supabase/types'

// POST /api/lists/resubscribe — re-register webhooks for all subscribed lists and re-sync task statuses
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { teamId }: { teamId: string } = await req.json()
  if (!teamId) return NextResponse.json({ error: 'teamId is required' }, { status: 400 })

  const supabase = await getSupabaseServiceClient()
  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { data: token } = await supabase
    .from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'clickup').single()
  if (!token) return NextResponse.json({ error: 'ClickUp not connected' }, { status: 400 })

  const { data: lists } = await supabase
    .from('lists')
    .select('id, clickup_list_id, webhook_id')
    .eq('user_id', user.id)

  if (!lists?.length) return NextResponse.json({ error: 'No subscribed lists found' }, { status: 404 })

  const client = buildClickUpClient(token.access_token)
  const webhookEndpoint = `${process.env.NEXTAUTH_URL}/api/webhooks/clickup`
  const results: Array<{ listId: string; webhookId: string | null; tasksSynced: number; error?: string }> = []

  for (const list of lists) {
    let newWebhookId: string | null = null

    // Delete stale webhook from ClickUp
    if (list.webhook_id) {
      try {
        await client.deleteWebhook(list.webhook_id)
      } catch {
        // Stale ID — already gone or never valid, continue
      }
    }

    // Register fresh webhook
    try {
      const webhook = await client.createWebhook(teamId, webhookEndpoint, process.env.CLICKUP_WEBHOOK_SECRET!)
      newWebhookId = webhook.webhook.id
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`Webhook registration failed for list ${list.clickup_list_id}: ${message}`)
      results.push({ listId: list.clickup_list_id, webhookId: null, tasksSynced: 0, error: message })
      continue
    }

    // Update webhook_id on the list record
    await supabase.from('lists').update({ webhook_id: newWebhookId, synced_at: new Date().toISOString() }).eq('id', list.id)

    // Re-sync current task statuses from ClickUp
    let tasksSynced = 0
    try {
      const tasks = await client.getTasks(list.clickup_list_id)
      if (tasks.length > 0) {
        await supabase.from('tasks').upsert(
          tasks.map((t) => ({
            clickup_task_id: t.id,
            list_id: list.id,
            name: t.name,
            status: t.status.status,
            custom_fields: (t.custom_fields ?? []) as unknown as Json,
            synced_at: new Date().toISOString(),
          })),
          { onConflict: 'clickup_task_id' }
        )
        tasksSynced = tasks.length
      }
    } catch (err) {
      console.warn(`Task sync failed for list ${list.clickup_list_id}:`, err)
    }

    results.push({ listId: list.clickup_list_id, webhookId: newWebhookId, tasksSynced })
  }

  return NextResponse.json({ ok: true, webhookEndpoint, results })
}

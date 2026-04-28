import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildClickUpClient } from '@/lib/clickup/client'
import type { Json } from '@/lib/supabase/types'

// POST /api/lists/resubscribe — register one team webhook and re-sync task statuses for all subscribed lists
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

  // Delete all webhooks in ClickUp pointing at our endpoint (handles orphans not tracked in Supabase)
  try {
    const existing = await client.listWebhooks(teamId)
    const ours = existing.filter((w) => w.endpoint === webhookEndpoint)
    for (const w of ours) {
      try { await client.deleteWebhook(w.id) } catch { /* ignore */ }
    }
  } catch (err) {
    console.warn('Could not list existing webhooks:', err)
  }

  // Create a single team-level webhook. ClickUp generates its own signing secret
  // and returns it in webhook.secret — that's the HMAC key for X-Signature verification.
  let teamWebhookId: string
  let clickupSecret: string
  try {
    const webhook = await client.createWebhook(teamId, webhookEndpoint)
    teamWebhookId = webhook.webhook.id
    clickupSecret = webhook.webhook.secret
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Webhook registration failed: ${message}`)
    return NextResponse.json({ error: `ClickUp webhook registration failed: ${message}` }, { status: 502 })
  }

  // Store the shared webhook ID on every list and re-sync task statuses
  const syncResults: Array<{ listId: string; tasksSynced: number; error?: string }> = []

  for (const list of lists) {
    await supabase.from('lists').update({ webhook_id: teamWebhookId, synced_at: new Date().toISOString() }).eq('id', list.id)

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
      }
      syncResults.push({ listId: list.clickup_list_id, tasksSynced: tasks.length })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`Task sync failed for list ${list.clickup_list_id}: ${message}`)
      syncResults.push({ listId: list.clickup_list_id, tasksSynced: 0, error: message })
    }
  }

  return NextResponse.json({ ok: true, webhookEndpoint, webhookId: teamWebhookId, clickupSecret, lists: syncResults })
}

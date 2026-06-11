// app/api/settings/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

// Editable runtime settings — whitelist prevents arbitrary key injection.
const ALLOWED_KEYS = ['pm_slack_user_id', 'marketing_slack_user_id', 'uiux_notification_channel']

export async function GET() {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase.from('app_settings') as any)
    .select('key, value, updated_at, updated_by')
    .in('key', ALLOWED_KEYS)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ settings: data ?? [] })
}

export async function PUT(request: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body.key !== 'string' || typeof body.value !== 'string') {
    return NextResponse.json({ error: 'Expected { key, value }' }, { status: 400 })
  }
  if (!ALLOWED_KEYS.includes(body.key)) {
    return NextResponse.json({ error: `Unknown setting: ${body.key}` }, { status: 400 })
  }

  const supabase = await getSupabaseServiceClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.from('app_settings') as any)
    .update({ value: body.value.trim(), updated_at: new Date().toISOString(), updated_by: session.user.email })
    .eq('key', body.key)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

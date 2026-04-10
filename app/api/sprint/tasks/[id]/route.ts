import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildClickUpClient } from '@/lib/clickup/client'
import type { Json } from '@/lib/supabase/types'

type Params = { params: Promise<{ id: string }> }

const DB_FIELDS = ['fvi_score', 'cost_effort', 'cost_risk', 'inverted_influence'] as const
type DbField = typeof DB_FIELDS[number]

// GET /api/sprint/tasks/[id] — fetch full task details including ClickUp description
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()

  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { data: task } = await supabase
    .from('tasks')
    .select('clickup_task_id')
    .eq('id', id)
    .single()
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const { data: token } = await supabase
    .from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'clickup').single()
  if (!token) return NextResponse.json({ error: 'ClickUp not connected' }, { status: 400 })

  const client = buildClickUpClient(token.access_token)
  const cuTask = await client.getTask(task.clickup_task_id)

  // Normalize custom field values — ClickUp returns complex objects for some types
  const customFields = (cuTask.custom_fields ?? []).map((f) => {
    let value = f.value
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Dropdown/label/sprint types return an object — extract the most useful scalar
      const obj = value as Record<string, unknown>
      value = obj.label ?? obj.name ?? obj.value ?? String(value)
    }
    if (Array.isArray(value)) {
      value = (value as Array<{ label?: string; name?: string }>)
        .map((v) => v.label ?? v.name ?? String(v))
        .join(', ')
    }
    return { id: f.id, name: f.name, value }
  })

  return NextResponse.json({ description: cuTask.description ?? '', customFields })
}

// PATCH /api/sprint/tasks/[id] — save edited custom fields and apply DB column mappings
// Body: { customFields: Array<{id, name, value}>, mappings: Record<fieldName, dbField> }
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { customFields, mappings }: {
    customFields: Array<{ id: string; name: string; value: unknown }>
    mappings: Record<string, string>
  } = await req.json()

  const supabase = await getSupabaseServiceClient()

  // Build the DB column updates from mappings
  const dbUpdate: Record<string, number | null> = {}
  for (const [fieldName, dbField] of Object.entries(mappings)) {
    if (!DB_FIELDS.includes(dbField as DbField)) continue
    const field = customFields.find((f) => f.name === fieldName)
    const num = field ? Number(field.value) : NaN
    dbUpdate[dbField] = isNaN(num) ? null : num
  }

  const { error } = await supabase
    .from('tasks')
    .update({ custom_fields: customFields as unknown as Json, ...dbUpdate })
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

const DB_FIELDS = ['fvi_score', 'cost_effort', 'cost_risk', 'inverted_influence'] as const
type DbField = typeof DB_FIELDS[number]

// POST /api/sprint/tasks/apply-mappings
// Body: { mappings: Record<fieldName, dbField> }
// Iterates all tasks, reads custom_fields, and updates mapped DB columns
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { mappings }: { mappings: Record<string, string> } = await req.json()

  // Only keep valid DB field mappings
  const validMappings = Object.entries(mappings).filter(([, dbField]) =>
    DB_FIELDS.includes(dbField as DbField)
  )
  if (!validMappings.length) return NextResponse.json({ updated: 0 })

  const supabase = await getSupabaseServiceClient()
  const { data: tasks } = await supabase.from('tasks').select('id, custom_fields')
  if (!tasks?.length) return NextResponse.json({ updated: 0 })

  let updated = 0
  for (const task of tasks) {
    const fields = task.custom_fields as Array<{ id: string; name: string; value: unknown }> | null
    if (!Array.isArray(fields)) continue

    const dbUpdate: Record<string, number | null> = {}
    for (const [fieldName, dbField] of validMappings) {
      const field = fields.find((f) => f.name === fieldName)
      const num = field ? Number(field.value) : NaN
      dbUpdate[dbField] = isNaN(num) ? null : num
    }

    await supabase.from('tasks').update(dbUpdate).eq('id', task.id)
    updated++
  }

  return NextResponse.json({ updated })
}

import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

// GET /api/fields — returns all unique custom field names across imported tasks
export async function GET() {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()
  const { data: tasks } = await supabase.from('tasks').select('custom_fields')

  const seen = new Map<string, string>()
  for (const task of tasks ?? []) {
    const fields = task.custom_fields as Array<{ id: string; name: string }> | null
    if (!Array.isArray(fields)) continue
    for (const f of fields) {
      if (!seen.has(f.name)) seen.set(f.name, f.id)
    }
  }

  return NextResponse.json({
    fields: [...seen.entries()].map(([name, id]) => ({ id, name })),
  })
}

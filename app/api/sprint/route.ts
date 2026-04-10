import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import type { InsertDto } from '@/lib/supabase/types'

// GET /api/sprint — list all sprints
export async function GET() {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()
  const { data: sprints } = await supabase
    .from('sprints')
    .select('*')
    .order('created_at', { ascending: false })

  return NextResponse.json({ sprints: sprints ?? [] })
}

// POST /api/sprint — create a sprint
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { name, start_date, end_date, cost_budget } = await req.json()
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  const supabase = await getSupabaseServiceClient()
  const insert: InsertDto<'sprints'> = { name, start_date, end_date, cost_budget }
  const { data, error } = await supabase.from('sprints').insert(insert).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ sprint: data })
}

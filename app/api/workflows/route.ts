import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

// GET /api/workflows - List all workflows
export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()

  // Summary mode returns a lightweight projection for dropdowns; otherwise
  // return an explicit column allowlist. The projection is never taken from
  // client input to avoid exposing arbitrary/embedded columns.
  const { searchParams } = new URL(request.url)
  const summaryMode = searchParams.get('summary') === 'true'

  const fields = summaryMode
    ? 'id, name'
    : 'id, name, description, sop_impacted, education_impacted, scribehow_impacted, is_deprecated, created_at, updated_at'

  const { data: workflows, error } = await supabase
    .from('workflows_registry')
    .select(fields)
    .order('name', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ workflows })
}

// POST /api/workflows - Create a new workflow
export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { name, description, sop_impacted, education_impacted, scribehow_impacted } = body

  if (!name?.trim()) {
    return NextResponse.json({ error: 'Workflow name is required' }, { status: 400 })
  }

  const supabase = await getSupabaseServiceClient()

  const { data: workflow, error } = await supabase
    .from('workflows_registry')
    .insert({
      name: name.trim(),
      description: description?.trim() || null,
      sop_impacted: sop_impacted ?? false,
      education_impacted: education_impacted ?? false,
      scribehow_impacted: scribehow_impacted ?? false,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'A workflow with this name already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ workflow }, { status: 201 })
}

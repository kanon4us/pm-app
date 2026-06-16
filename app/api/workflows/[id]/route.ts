import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

// PUT /api/workflows/[id] - Update a workflow
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body = await request.json()
  const { name, description, sop_impacted, education_impacted, scribehow_impacted, is_deprecated } = body

  const supabase = await getSupabaseServiceClient()

  const updateData: Record<string, any> = {}
  if (name !== undefined) updateData.name = name.trim()
  if (description !== undefined) updateData.description = description?.trim() || null
  if (sop_impacted !== undefined) updateData.sop_impacted = sop_impacted
  if (education_impacted !== undefined) updateData.education_impacted = education_impacted
  if (scribehow_impacted !== undefined) updateData.scribehow_impacted = scribehow_impacted
  if (is_deprecated !== undefined) updateData.is_deprecated = is_deprecated

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const { data: workflow, error } = await supabase
    .from('workflows_registry')
    .update(updateData)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'A workflow with this name already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!workflow) {
    return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })
  }

  return NextResponse.json({ workflow })
}

// DELETE /api/workflows/[id] - Delete a workflow
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const supabase = await getSupabaseServiceClient()

  // Check if workflow is referenced in assessments
  const { data: references, error: refError } = await supabase
    .from('assessment_workflows')
    .select('id')
    .eq('workflow_id', id)
    .limit(1)

  if (refError) return NextResponse.json({ error: refError.message }, { status: 500 })

  if (references && references.length > 0) {
    return NextResponse.json(
      { error: 'Cannot delete workflow that is referenced by assessments. Mark as deprecated instead.' },
      { status: 409 }
    )
  }

  const { error } = await supabase
    .from('workflows_registry')
    .delete()
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}

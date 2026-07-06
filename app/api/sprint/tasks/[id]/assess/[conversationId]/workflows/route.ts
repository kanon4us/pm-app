import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { normalizeWorkflowName, escapeLikePattern } from '@/lib/workflows/normalize'

type RegistryRow = {
  id: string
  name: string
  sop_impacted: boolean
  education_impacted: boolean
  scribehow_impacted: boolean
}

const REGISTRY_FIELDS = 'id, name, sop_impacted, education_impacted, scribehow_impacted'

// POST /api/sprint/tasks/[id]/assess/[conversationId]/workflows
// Upsert one affected workflow into workflows_registry and link it to the assessment.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; conversationId: string }> }
) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { conversationId } = await params
  const bodyJson = await request.json()
  const { name, sopImpacted, educationImpacted, scribehowImpacted } = bodyJson as {
    name?: unknown
    sopImpacted?: unknown
    educationImpacted?: unknown
    scribehowImpacted?: unknown
  }

  if (typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'Workflow name is required' }, { status: 400 })
  }

  const trimmedName = name.trim()
  const normalized = normalizeWorkflowName(trimmedName)
  const incoming = {
    sop: sopImpacted === true,
    education: educationImpacted === true,
    scribehow: scribehowImpacted === true,
  }
  const supabase = await getSupabaseServiceClient()

  // Case-insensitive lookup (escape LIKE wildcards so the name matches literally).
  async function findExisting(): Promise<RegistryRow | null> {
    const { data, error } = await supabase
      .from('workflows_registry')
      .select(REGISTRY_FIELDS)
      .ilike('name', escapeLikePattern(trimmedName))
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as unknown as RegistryRow[]
    return rows.find((r) => normalizeWorkflowName(r.name) === normalized) ?? null
  }

  // OR-merge the incoming impact flags onto an existing row (never clears a flag).
  async function updateFlags(row: RegistryRow): Promise<RegistryRow> {
    const { data, error } = await supabase
      .from('workflows_registry')
      .update({
        sop_impacted: row.sop_impacted || incoming.sop,
        education_impacted: row.education_impacted || incoming.education,
        scribehow_impacted: row.scribehow_impacted || incoming.scribehow,
      })
      .eq('id', row.id)
      .select(REGISTRY_FIELDS)
      .single()
    if (error || !data) throw new Error(error?.message ?? 'Update failed')
    return data as unknown as RegistryRow
  }

  let workflow: RegistryRow
  let action: 'created' | 'updated'

  try {
    const existing = await findExisting()
    if (existing) {
      workflow = await updateFlags(existing)
      action = 'updated'
    } else {
      const { data, error } = await supabase
        .from('workflows_registry')
        .insert({
          name: trimmedName,
          sop_impacted: incoming.sop,
          education_impacted: incoming.education,
          scribehow_impacted: incoming.scribehow,
        })
        .select(REGISTRY_FIELDS)
        .single()

      if (error) {
        // Concurrent create (or a dup the case-insensitive lookup missed): re-find and update.
        if (error.code === '23505') {
          const raced = await findExisting()
          if (!raced) return NextResponse.json({ error: error.message }, { status: 500 })
          workflow = await updateFlags(raced)
          action = 'updated'
        } else {
          return NextResponse.json({ error: error.message }, { status: 500 })
        }
      } else {
        workflow = data as unknown as RegistryRow
        action = 'created'
      }
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Upsert failed' }, { status: 500 })
  }

  // Best-effort link: the registry row (what /workflows reads) already landed.
  const { error: linkError } = await supabase
    .from('assessment_workflows')
    .insert({ assessment_id: conversationId, workflow_id: workflow.id })
  if (linkError && linkError.code !== '23505') {
    console.error('[assess/workflows] junction link failed (non-fatal):', linkError.message)
  }

  return NextResponse.json({ workflow, action })
}

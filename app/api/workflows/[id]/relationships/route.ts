import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

const RELATIONSHIP_TYPES = ['related', 'depends_on', 'enables'] as const
type RelationshipType = (typeof RELATIONSHIP_TYPES)[number]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

// GET /api/workflows/[id]/relationships — related workflows in either direction
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid workflow id' }, { status: 400 })

  const supabase = await getSupabaseServiceClient()

  // Edges touching this workflow on either side (id is UUID-validated above)
  const { data: rels, error } = await supabase
    .from('workflow_relationships')
    .select('workflow_id, related_workflow_id, relationship_type, created_at')
    .or(`workflow_id.eq.${id},related_workflow_id.eq.${id}`)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const edges = rels ?? []
  const otherIds = [...new Set(edges.map((r) => (r.workflow_id === id ? r.related_workflow_id : r.workflow_id)))]

  // Resolve names for the workflows on the other end of each edge
  const names = new Map<string, string>()
  if (otherIds.length > 0) {
    const { data: others, error: nameError } = await supabase
      .from('workflows_registry')
      .select('id, name')
      .in('id', otherIds)
    if (nameError) return NextResponse.json({ error: nameError.message }, { status: 500 })
    for (const w of others ?? []) names.set(w.id, w.name)
  }

  const relationships = edges.map((r) => {
    const outgoing = r.workflow_id === id
    const relatedId = outgoing ? r.related_workflow_id : r.workflow_id
    return {
      related_workflow_id: relatedId,
      name: names.get(relatedId) ?? relatedId,
      relationship_type: r.relationship_type,
      // 'outgoing' = this workflow is the source (e.g. this depends_on related);
      // 'incoming' = this workflow is the target (e.g. related depends_on this).
      direction: outgoing ? 'outgoing' : 'incoming',
      created_at: r.created_at,
    }
  })

  return NextResponse.json({ relationships })
}

// POST /api/workflows/[id]/relationships — create a relationship to another workflow
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid workflow id' }, { status: 400 })

  const body = await request.json().catch(() => null)
  const relatedId = body?.related_workflow_id
  const relationshipType: RelationshipType = body?.relationship_type ?? 'related'

  if (!isUuid(relatedId)) {
    return NextResponse.json({ error: 'related_workflow_id must be a valid workflow id' }, { status: 400 })
  }
  if (relatedId === id) {
    return NextResponse.json({ error: 'A workflow cannot be related to itself' }, { status: 400 })
  }
  if (!RELATIONSHIP_TYPES.includes(relationshipType)) {
    return NextResponse.json(
      { error: `relationship_type must be one of: ${RELATIONSHIP_TYPES.join(', ')}` },
      { status: 400 }
    )
  }

  const supabase = await getSupabaseServiceClient()

  // The related workflow must exist (clean 404 instead of a raw FK violation)
  const { data: related } = await supabase
    .from('workflows_registry')
    .select('id')
    .eq('id', relatedId)
    .single()
  if (!related) {
    return NextResponse.json({ error: 'Related workflow not found' }, { status: 404 })
  }

  // Bidirectional cycle prevention: reject if an edge already exists between
  // this pair in EITHER direction (both ids are UUID-validated above).
  const { data: existing, error: existErr } = await supabase
    .from('workflow_relationships')
    .select('workflow_id')
    .or(
      `and(workflow_id.eq.${id},related_workflow_id.eq.${relatedId}),and(workflow_id.eq.${relatedId},related_workflow_id.eq.${id})`
    )
    .limit(1)
  if (existErr) return NextResponse.json({ error: existErr.message }, { status: 500 })
  if (existing && existing.length > 0) {
    return NextResponse.json({ error: 'These workflows are already related' }, { status: 409 })
  }

  const { data: relationship, error } = await supabase
    .from('workflow_relationships')
    .insert({ workflow_id: id, related_workflow_id: relatedId, relationship_type: relationshipType })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'These workflows are already related' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ relationship }, { status: 201 })
}

// DELETE /api/workflows/[id]/relationships?related_workflow_id=... — remove an edge (either direction)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid workflow id' }, { status: 400 })

  const relatedId = request.nextUrl.searchParams.get('related_workflow_id')
  if (!isUuid(relatedId)) {
    return NextResponse.json({ error: 'related_workflow_id query param must be a valid workflow id' }, { status: 400 })
  }

  const supabase = await getSupabaseServiceClient()

  // Remove the edge regardless of which workflow created it (ids UUID-validated)
  const { error } = await supabase
    .from('workflow_relationships')
    .delete()
    .or(
      `and(workflow_id.eq.${id},related_workflow_id.eq.${relatedId}),and(workflow_id.eq.${relatedId},related_workflow_id.eq.${id})`
    )

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}

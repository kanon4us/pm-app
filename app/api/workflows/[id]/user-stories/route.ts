import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

// GET /api/workflows/[id]/user-stories - List all user stories for a workflow
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const supabase = await getSupabaseServiceClient()

  const { data: stories, error } = await supabase
    .from('workflow_user_stories')
    .select(`
      *,
      workflow_story_prototypes (*)
    `)
    .eq('workflow_id', id)
    .order('display_order', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ stories })
}

// POST /api/workflows/[id]/user-stories - Create a new user story
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id: workflowId } = await params
  const body = await request.json()
  const { title, as_a, i_want, so_that, figma_url } = body

  if (!title || !as_a || !i_want || !so_that) {
    return NextResponse.json(
      { error: 'Missing required fields: title, as_a, i_want, so_that' },
      { status: 400 }
    )
  }

  const supabase = await getSupabaseServiceClient()

  // Use RPC function for atomic creation
  const { data: storyId, error } = await supabase.rpc('create_user_story_with_prototype', {
    p_workflow_id: workflowId,
    p_title: title,
    p_as_a: as_a,
    p_i_want: i_want,
    p_so_that: so_that,
    p_figma_url: figma_url || ''
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Fetch the created story with prototypes
  const { data: story } = await supabase
    .from('workflow_user_stories')
    .select(`
      *,
      workflow_story_prototypes (*)
    `)
    .eq('id', storyId)
    .single()

  return NextResponse.json({ story }, { status: 201 })
}

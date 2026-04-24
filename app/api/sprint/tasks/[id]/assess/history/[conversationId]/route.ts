import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

type Params = { params: Promise<{ id: string; conversationId: string }> }

// PATCH /api/sprint/tasks/[id]/assess/history/[conversationId]
// Body: { isArchived: boolean }
// Archives or unarchives an assessment run.
// Scopes the update to both conversationId and task_id — a zero-row result signals the conversation
// does not exist or does not belong to this task. Note: user ownership is not enforced beyond
// session authentication (single-tenant app, all authenticated users share a workspace).
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id, conversationId } = await params
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (typeof (body as Record<string, unknown>)?.isArchived !== 'boolean') {
    return NextResponse.json({ error: 'isArchived must be a boolean' }, { status: 400 })
  }
  const { isArchived } = body as { isArchived: boolean }

  const supabase = await getSupabaseServiceClient()

  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { data, error } = await supabase
    .from('assessment_conversations')
    .update({ is_archived: isArchived })
    .eq('id', conversationId)
    .eq('task_id', id)
    .select('id')

  if (error) {
    console.error('[assess/history PATCH] DB error:', error)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }

  // If no rows were updated, the conversation doesn't exist or doesn't belong to this task
  if (!data || data.length === 0) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  return NextResponse.json({ ok: true })
}

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

type Params = { params: Promise<{ id: string; conversationId: string }> }

// GET /api/sprint/tasks/[id]/assess/[conversationId]/resume
// Returns the persisted state of an in-progress assessment so the UI can reopen
// it at the score-review step instead of starting a fresh run. We restore the
// proposed scores (kept current as interview answers come in) and the affected
// workflows; phase-specific state (current question, finalize proposal) is not
// persisted, so resume lands the user at scoring_review to review/approve.
export async function GET(req: NextRequest, { params }: Params) {
  const { id, conversationId } = await params
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()

  const { data: conv, error } = await supabase
    .from('assessment_conversations')
    .select('id, task_id, status, proposed_scores, affected_workflows')
    .eq('id', conversationId)
    .eq('task_id', id)
    .single()

  if (error || !conv) return NextResponse.json({ error: 'Assessment not found' }, { status: 404 })
  if (conv.status !== 'in_progress') {
    return NextResponse.json({ error: 'This assessment is no longer in progress' }, { status: 409 })
  }

  return NextResponse.json({
    conversationId: conv.id,
    proposedScores: conv.proposed_scores ?? [],
    affectedWorkflows: conv.affected_workflows ?? [],
  })
}

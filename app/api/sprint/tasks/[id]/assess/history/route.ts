import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

type Params = { params: Promise<{ id: string }> }

function riskLevel(multiplier: number | null): string {
  if (multiplier === 1.0) return 'Routine'
  if (multiplier === 1.2) return 'Standard'
  if (multiplier === 1.5) return 'Moderate'
  if (multiplier === 2.0) return 'High'
  if (multiplier === 3.0) return 'Critical'
  return 'Unknown'
}

// GET /api/sprint/tasks/[id]/assess/history
// Returns all assessment conversations for the task (complete, in_progress, abandoned)
// including role data joined from conversation_role_assessments + role_registry.
// Frontend is responsible for filtering by status and is_archived.
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()

  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // Fetch all conversations for the task with roles joined via Supabase nested select
  const { data: rows, error } = await supabase
    .from('assessment_conversations')
    .select(`
      id, task_id, status, fvi_score, effort, risk,
      final_scores, affected_workflows, completed_at, created_at, is_archived,
      conversation_role_assessments (
        id,
        role_id,
        usage_frequency,
        claude_proposed_frequency,
        user_override_frequency,
        claude_reasoning,
        user_reasoning,
        role_registry ( role_name, team_domain, influence_type, weight )
      )
    `)
    .eq('task_id', id)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[assess/history GET] DB error:', error)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }

  if (!rows || rows.length === 0) return NextResponse.json({ runs: [] })

  const runs = (rows as Array<Record<string, unknown>>).map((ac) => {
    const craRows = (ac.conversation_role_assessments as Array<Record<string, unknown>> | null) ?? []
    const roles = craRows
      .filter((cra) => cra.role_id != null)
      .map((cra) => {
        const rr = cra.role_registry as Record<string, unknown> | null
        const userOverride = cra.user_override_frequency as number | null
        const claudeProposed = cra.claude_proposed_frequency as number | null
        const usageFreq = cra.usage_frequency as number
        return {
          roleId: cra.role_id as string,
          roleName: rr?.role_name as string ?? '',
          teamDomain: rr?.team_domain as string ?? '',
          influenceType: rr?.influence_type as 'DM' | 'NDM' ?? 'DM',
          weight: rr?.weight as number ?? 0,
          usageFrequency: userOverride ?? claudeProposed ?? usageFreq,
          claudeProposedFrequency: claudeProposed,
          claudeReasoning: cra.claude_reasoning as string | null,
          userOverrideFrequency: userOverride,
          userReasoning: cra.user_reasoning as string | null,
          isUserOverride: userOverride !== null,
        }
      })

    return {
      conversationId: ac.id as string,
      status: ac.status as string,
      isArchived: ac.is_archived as boolean,
      fviScore: ac.fvi_score as number | null,
      effort: ac.effort as number | null,
      risk: ac.risk as number | null,
      riskLevel: riskLevel(ac.risk as number | null),
      completedAt: ac.completed_at as string | null,
      createdAt: ac.created_at as string,
      finalScores: (ac.final_scores as Array<Record<string, unknown>> | null) ?? [],
      affectedWorkflows: (ac.affected_workflows as Array<Record<string, unknown>> | null) ?? [],
      roles,
    }
  })

  return NextResponse.json({ runs })
}

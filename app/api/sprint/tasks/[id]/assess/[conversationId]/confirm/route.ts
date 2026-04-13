import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildClickUpClient } from '@/lib/clickup/client'
import { computeFullFVI } from '@/lib/fvi'
import type { RoleAssessment, ObjectiveScore } from '@/lib/fvi'
import type { Json } from '@/lib/supabase/types'

type Params = { params: Promise<{ id: string; conversationId: string }> }

// POST /api/sprint/tasks/[id]/assess/[conversationId]/confirm
// Fast step: computes FVI, saves all scores to Supabase, updates ClickUp task description.
// Vault branch creation, ClickUp custom field write-back, and kickoff comment are in /bundle.
export async function POST(req: NextRequest, { params }: Params) {
  const { id, conversationId } = await params
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const {
    scores,             // Array<{ objectiveId, score, objectiveName, objectiveOwner, reasoning }>
    roles,              // Array<{ roleId, roleName, influenceType, weight, usageFrequency, teamDomain }>
    effort,             // number (total dev-days)
    risk,               // number (1.0, 1.2, 1.5, 2.0, 3.0)
    updatedDescription, // string | null
    vaultSpecContent,   // string | null — persisted for /bundle to read
  } = body

  const supabase = await getSupabaseServiceClient()

  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { data: conv } = await supabase
    .from('assessment_conversations')
    .select('id, task_id')
    .eq('id', conversationId)
    .eq('task_id', id)
    .single()
  if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

  const { data: task } = await supabase
    .from('tasks')
    .select('id, clickup_task_id, name')
    .eq('id', id)
    .single()
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  // ── Compute FVI ──────────────────────────────────────────────────────────────
  const objectiveScores: ObjectiveScore[] = scores.map((s: { objectiveId: number; score: number }) => ({
    objectiveId: s.objectiveId,
    score: s.score,
  }))
  const roleAssessments: RoleAssessment[] = roles.map((r: { roleName: string; influenceType: string; weight: number; usageFrequency: number }) => ({
    roleName: r.roleName,
    influenceType: r.influenceType as 'DM' | 'NDM',
    weight: r.weight,
    usageFrequency: r.usageFrequency,
  }))
  const fviResult = computeFullFVI(objectiveScores, roleAssessments, effort, risk)

  // ── Save objective_assessments ────────────────────────────────────────────────
  await Promise.all(
    scores.map((s: { objectiveId: number; score: number; reasoning?: string }) =>
      supabase.from('objective_assessments').upsert(
        { task_id: id, objective_id: s.objectiveId, score: s.score, reasoning: s.reasoning ?? null },
        { onConflict: 'task_id,objective_id' }
      )
    )
  )

  // ── Save conversation role assessments ────────────────────────────────────────
  const { data: roleRows } = await supabase.from('role_registry').select('id, role_name, team_domain')
  const roleIdMap = new Map((roleRows ?? []).map((r) => [`${r.role_name}::${r.team_domain}`, r.id]))
  await Promise.all(
    roles.map((r: { roleName: string; teamDomain: string; usageFrequency: number }) => {
      const roleId = roleIdMap.get(`${r.roleName}::${r.teamDomain}`)
      if (!roleId) return Promise.resolve()
      return supabase.from('conversation_role_assessments').insert({
        conversation_id: conversationId,
        role_id: roleId,
        usage_frequency: r.usageFrequency,
      })
    })
  )

  // ── Merge computed scores into tasks.mapped_fields ────────────────────────────
  const mappedUpdate: Record<string, number | string | null> = {
    decision_maker_score: Math.round(fviResult.iDmNorm * 1000) / 1000,
    nondecision_maker_score: Math.round(fviResult.iNdmNorm * 1000) / 1000,
  }
  for (const s of scores as Array<{ objectiveId: number; score: number; reasoning?: string }>) {
    if (s.objectiveId >= 1 && s.objectiveId <= 7) {
      mappedUpdate[`obj_${s.objectiveId}_score`] = s.score
      if (s.reasoning) mappedUpdate[`obj_${s.objectiveId}_desc`] = s.reasoning
    }
  }
  const { data: existingTask } = await supabase.from('tasks').select('mapped_fields').eq('id', id).single()
  const mergedMapped = { ...(existingTask?.mapped_fields as Record<string, unknown> ?? {}), ...mappedUpdate }

  // ── Persist to Supabase ───────────────────────────────────────────────────────
  await Promise.all([
    supabase.from('tasks').update({
      fvi_score: fviResult.fviScore,
      cost_effort: effort,
      cost_risk: risk,
      inverted_influence: Math.round(fviResult.invertedInfluence * 1000) / 1000,
      mapped_fields: mergedMapped as Json,
    }).eq('id', id),

    supabase.from('assessment_conversations').update({
      status: 'complete',
      final_scores: scores as unknown as Json,
      effort,
      risk,
      fvi_score: fviResult.fviScore,
      completed_at: new Date().toISOString(),
      vault_spec_content: vaultSpecContent ?? null,
    }).eq('id', conversationId),
  ])

  // ── ClickUp description write-back (non-fatal) ───────────────────────────────
  if (updatedDescription) {
    const { data: cuToken } = await supabase
      .from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'clickup').single()
    if (cuToken?.access_token) {
      try {
        const cu = buildClickUpClient(cuToken.access_token)
        await cu.updateTask(task.clickup_task_id, { description: updatedDescription })
      } catch (err) {
        console.error(`[assess:confirm task=${id}] ClickUp description update failed:`, err)
      }
    }
  }

  return NextResponse.json({
    fviScore: fviResult.fviScore,
    decision: fviResult.decision,
    objTotal: fviResult.objTotal,
    invertedInfluence: fviResult.invertedInfluence,
    iDmNorm: fviResult.iDmNorm,
    iNdmNorm: fviResult.iNdmNorm,
    trojanHorse: fviResult.trojanHorse,
    effort,
    risk,
  })
}

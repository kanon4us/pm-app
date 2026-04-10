import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildClickUpClient } from '@/lib/clickup/client'
import { writeVaultFile, vaultBranchName } from '@/lib/github/vault'
import { computeFullFVI } from '@/lib/fvi'
import type { RoleAssessment, ObjectiveScore } from '@/lib/fvi'
import type { Json } from '@/lib/supabase/types'

type Params = { params: Promise<{ id: string; conversationId: string }> }

// POST /api/sprint/tasks/[id]/assess/[conversationId]/confirm
// Final step: user has confirmed scores, roles, effort, risk.
// Computes FVI, saves everything, writes vault spec, updates ClickUp.
export async function POST(req: NextRequest, { params }: Params) {
  const { id, conversationId } = await params
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const {
    scores,       // Array<{ objectiveId, score, objectiveName, objectiveOwner, reasoning }>
    roles,        // Array<{ roleId, roleName, influenceType, weight, usageFrequency }>
    effort,       // number (total dev-days)
    risk,         // number (1.0, 1.2, 1.5, 2.0, 3.0)
    updatedDescription, // string | null — updated task description from Claude
    vaultSpecContent,   // string | null — vault spec stub markdown
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

  // ── Compute FVI ─────────────────────────────────────────────────────────────
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

  // ── Save objective_assessments ──────────────────────────────────────────────
  await Promise.all(
    scores.map((s: { objectiveId: number; score: number; reasoning?: string }) =>
      supabase.from('objective_assessments').upsert(
        { task_id: id, objective_id: s.objectiveId, score: s.score, reasoning: s.reasoning ?? null },
        { onConflict: 'task_id,objective_id' }
      )
    )
  )

  // ── Save conversation role assessments ──────────────────────────────────────
  // Lookup role IDs
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

  // ── Update tasks table ──────────────────────────────────────────────────────
  await supabase.from('tasks').update({
    fvi_score: fviResult.fviScore,
    cost_effort: effort,
    cost_risk: risk,
    inverted_influence: Math.round(fviResult.invertedInfluence * 1000) / 1000,
  }).eq('id', id)

  // ── Update assessment_conversations ────────────────────────────────────────
  await supabase.from('assessment_conversations').update({
    status: 'complete',
    final_scores: scores as unknown as Json,
    effort,
    risk,
    fvi_score: fviResult.fviScore,
    completed_at: new Date().toISOString(),
  }).eq('id', conversationId)

  // ── ClickUp description write-back (non-fatal) ─────────────────────────────
  if (updatedDescription) {
    const { data: cuToken } = await supabase.from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'clickup').single()
    if (cuToken?.access_token) {
      try {
        const cu = buildClickUpClient(cuToken.access_token)
        await cu.updateTask(task.clickup_task_id, { description: updatedDescription })
      } catch { /* non-fatal */ }
    }
  }

  // ── Vault spec write-back (non-fatal) ──────────────────────────────────────
  let vaultSpecUrl: string | null = null
  if (vaultSpecContent) {
    const { data: ghToken } = await supabase.from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'github').single()
    if (ghToken?.access_token) {
      try {
        const slug = task.name.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-').slice(0, 40)
        const path = `FeaturePlanning/_Active/${task.clickup_task_id}-${slug}.md`
        const written = await writeVaultFile(
          ghToken.access_token,
          path,
          vaultSpecContent,
          `PM Agent: FVI assessment for ${task.name} (${new Date().toISOString().slice(0, 10)})`
        )
        vaultSpecUrl = written?.url ?? null
      } catch { /* non-fatal */ }
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
    vaultSpecUrl,
  })
}

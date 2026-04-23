import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildClickUpClient } from '@/lib/clickup/client'
import { writeVaultFile, createVaultBranch, vaultBranchName } from '@/lib/github/vault'
import { computeFullFVI, RISK_LEVELS } from '@/lib/fvi'
import { buildAssessmentDoc } from '@/lib/bundle-docs/assessment'
import type { Json } from '@/lib/supabase/types'

export const maxDuration = 300

type Params = { params: Promise<{ id: string }> }

// ── Bundle content generators ─────────────────────────────────────────────────

type FVIResult = ReturnType<typeof computeFullFVI>

function buildKickoffPrompt(
  taskName: string,
  clickupTaskId: string,
  fvi: FVIResult,
  effort: number,
  risk: number,
  vaultBranch: string
): string {
  return `# Kickoff Prompt — ${taskName}

> Posted by PM Agent on FVI assessment approval. Use this as your opening message when starting a Claude session on this feature.

**ClickUp Task:** ${clickupTaskId}
**Vault Branch:** \`${vaultBranch}\`
**FVI Score:** ${fvi.fviScore} — ${fvi.decision.replace(/-/g, ' ')}
**Effort:** ${effort} dev-day${effort !== 1 ? 's' : ''} | **Risk multiplier:** ${risk}x
**Trojan Horse flag:** ${fvi.trojanHorse ? '⚠️ YES — review objective scores before proceeding' : 'No'}

## Your Mission

You are a developer starting work on **${taskName}**. The vault spec, roles-affected, and plan-draft files are in this branch. Your first actions:

1. Read \`spec.md\` for the full feature context and acceptance criteria.
2. Read \`roles-affected.md\` to understand whose workflows this touches.
3. Read \`plan-draft.md\` and fill in the Engineering Plan before moving to Architecting.
4. Confirm the Kickoff Checklist in the Sprint Planner is fully green before writing code.

## FVI Context

| Objective Total | Inverted Influence | Decision |
|----------------|-------------------|----------|
| ${fvi.objTotal} / 70 | ${fvi.invertedInfluence.toFixed(3)} | ${fvi.decision} |
`
}

function buildRolesAffected(
  taskName: string,
  roles: Array<{ roleName: string; teamDomain?: string; influenceType: string; weight: number; usageFrequency: number }>,
  fvi: FVIResult
): string {
  const freq = (f: number) => ['', 'Access Default', 'Access Sometimes', 'Uses Sometimes', 'Uses Every Day'][f] ?? String(f)
  const dmRoles = roles.filter((r) => r.influenceType === 'DM')
  const ndmRoles = roles.filter((r) => r.influenceType === 'NDM')

  const table = (list: typeof roles) =>
    list.length === 0
      ? '_None_\n'
      : `| Role | Team | Weight | Usage | Score |\n|------|------|--------|-------|-------|\n` +
        list.map((r) => `| ${r.roleName} | ${r.teamDomain ?? '—'} | ${r.weight} | ${freq(r.usageFrequency)} | ${r.weight * r.usageFrequency} |`).join('\n') + '\n'

  return `# Roles Affected — ${taskName}

## Decision-Maker Roles (DM)

${table(dmRoles)}
## Non-Decision-Maker Roles (NDM)

${table(ndmRoles)}
## FVI Influence Summary

| I_DM (norm) | I_NDM (norm) | Inverted Influence |
|-------------|--------------|-------------------|
| ${fvi.iDmNorm.toFixed(3)} | ${fvi.iNdmNorm.toFixed(3)} | ${fvi.invertedInfluence.toFixed(3)} |
`
}

function buildSpecStub(
  taskName: string,
  clickupTaskId: string,
  fvi: FVIResult,
  effort: number,
  risk: number,
  scores: Array<{ objectiveId: number; score: number; objectiveName?: string; reasoning?: string }>
): string {
  const riskLabel = RISK_LEVELS.find((r) => r.multiplier === risk)?.label ?? `${risk}x`
  const scoreLines = scores
    .sort((a, b) => a.objectiveId - b.objectiveId)
    .map((s) => `- **Obj ${s.objectiveId}${s.objectiveName ? ` — ${s.objectiveName}` : ''}:** ${s.score > 0 ? '+' : ''}${s.score}${s.reasoning ? `  \n  _${s.reasoning}_` : ''}`)
    .join('\n')

  return `# Feature Spec — ${taskName}

> Auto-generated stub by PM Agent (assessment had no Q&A — all objectives scored from task context).
> Fill in the sections below before moving to Architecting status.

**ClickUp:** ${clickupTaskId}
**FVI:** ${fvi.fviScore} — ${fvi.decision}
**Effort:** ${effort} dev-day${effort !== 1 ? 's' : ''} | **Risk:** ${riskLabel} (${risk}x)

---

## Problem Statement

_What user pain or business gap does this address? Who experiences it?_

## Proposed Solution

_High-level approach. What changes, what stays the same._

## Acceptance Criteria

- [ ] _Define done — measurable outcomes, not implementation steps_

## Objective Scores

${scoreLines}

## Open Questions

_List blockers or unknowns that must be resolved before Architecting._
`
}

const DB_KEYWORDS_RE = /\b(index|migration|schema|database|db|query|table|column|foreign key|join)\b/i
const FE_KEYWORDS_RE = /\b(component|drawer|modal|form|view|screen|ui|frontend|page|layout|button|input)\b/i
const BE_KEYWORDS_RE = /\b(api|webhook|endpoint|route|server|database|migration|query|backend|worker|job|cron)\b/i

function buildPlanDraft(
  taskName: string,
  clickupTaskId: string,
  fvi: FVIResult,
  effort: number,
  risk: number,
  scores: Array<{ objectiveId: number; score: number; objectiveName?: string; reasoning?: string }>,
  vaultSpecContent: string | null
): string {
  const riskLabel = RISK_LEVELS.find((r) => r.multiplier === risk)?.label ?? `${risk}x`

  const riskItems: string[] = []
  for (const s of scores) {
    if (!s.reasoning?.trim()) continue
    const isHighRiskObjective = risk >= 2.0 && s.score < 0
    const hasDbKeyword = DB_KEYWORDS_RE.test(s.reasoning)
    if (isHighRiskObjective || hasDbKeyword) {
      const prefix = s.objectiveName ? `[${s.objectiveName}] ` : ''
      riskItems.push(`- [ ] ${prefix}${s.reasoning.trim()}`)
    }
  }

  const searchText = `${taskName} ${vaultSpecContent ?? ''}`.toLowerCase()
  const suggestSplit = effort >= 3 && FE_KEYWORDS_RE.test(searchText) && BE_KEYWORDS_RE.test(searchText)

  const riskSection = riskItems.length > 0
    ? `## Risk Reduction Checklist (Research Needed)\n\n> Risk multiplier: **${riskLabel} (${risk}x)**. Resolve or document each item before moving to Architecting.\n\n${riskItems.join('\n')}\n\n---\n\n`
    : ''

  const splitSection = suggestSplit
    ? `## Proposed Decomposition\n\n> Both frontend and backend scope detected across ${effort} dev-day${effort !== 1 ? 's' : ''}.\n> Recommended: break into FE and BE child tasks during Architecting. Reference parent \`${clickupTaskId}\` in each child task description.\n\n- **Frontend:** _(describe UI scope)_\n- **Backend:** _(describe API / data scope)_\n\n_Create child tasks in ClickUp linked to \`${clickupTaskId}\` before moving to Architecting status._\n\n---\n\n`
    : ''

  return `# Plan Draft — ${taskName}

> Stub generated by PM Agent at FVI assessment. Complete the Engineering Plan sections during the Architecting phase before moving this task to Architecting status in ClickUp.

**FVI:** ${fvi.fviScore} | **Decision:** ${fvi.decision}
**Effort:** ${effort} dev-day${effort !== 1 ? 's' : ''} | **Risk:** ${riskLabel} (${risk}x)

---

${riskSection}${splitSection}## Problem Statement

_What problem does this solve? Who experiences it?_

## Proposed Solution

_High-level approach. What changes, what stays the same._

## Engineering Plan

_Populated during Architecting. List the files, APIs, and DB changes._

## Acceptance Criteria

_Pulled from spec.md — confirm they are still accurate before coding starts._

## Open Questions

_List any blockers or unknowns that need resolution before implementation._
`
}

function buildClaudeMdBlock(
  taskName: string,
  clickupTaskId: string,
  vaultBranch: string,
  fvi: FVIResult,
  roles: Array<{ roleName: string; teamDomain?: string; influenceType: string; weight: number; usageFrequency: number }>
): string {
  const topDmRoles = roles
    .filter((r) => r.influenceType === 'DM')
    .sort((a, b) => b.weight * b.usageFrequency - a.weight * a.usageFrequency)
    .slice(0, 3)

  const skillLines = topDmRoles.length > 0
    ? topDmRoles.map((r) => {
        const slug = r.roleName.toLowerCase().replace(/\s+/g, '-')
        return `- \`documentation/AI Tools/Skills/user-perspective/${slug}.md\` (${r.roleName}, score: ${r.weight * r.usageFrequency})`
      }).join('\n')
    : '- _(No DM roles identified — check roles-affected.md)_'

  return `<!-- CLAUDE.md injection for: ${taskName} -->
<!-- Remove this block when task reaches Deployed status -->

## Active Feature Context

**Feature:** ${taskName}
**ClickUp:** ${clickupTaskId}
**Vault branch:** \`${vaultBranch}\`
**FVI:** ${fvi.fviScore} (${fvi.decision})${fvi.trojanHorse ? '\n**⚠️ Trojan Horse flag is set — high data value but low modularity/user-success scores. Proceed with caution.**' : ''}

### Vault Files (read before coding)

- \`spec.md\` — acceptance criteria and feature context
- \`roles-affected.md\` — whose workflows this touches
- \`plan-draft.md\` — engineering plan (fill in during Architecting)
- \`kickoff-prompt.md\` — your session opening context

### User-Perspective SKILLs (Kickoff Checklist gate #2)

Load these before drafting user stories or acceptance criteria:

${skillLines}

### Figma (Kickoff Checklist gate #3)

The Figma Selection Link is embedded in \`spec.md\` by the PM Agent when the designer shares a component link during the Architecting phase. **Do not proceed to Architecting status until that link is present in spec.md.** If you cannot find it, ask the PM to run the Architecting trigger before you continue.

### Focus Constraints

- Scope every change to this feature only. Do not refactor unrelated code.
- If a change would touch auth, billing, or permissions, stop and flag it.
- All new files go in the branch — do not merge to main until ROI is validated.
- Run tests before marking any task as Ready for QA.
<!-- END CLAUDE.md injection -->
`
}

// ── Route handler ─────────────────────────────────────────────────────────────

// POST /api/sprint/tasks/[id]/bundle
// Heavy step: fetches live ClickUp field IDs, writes all FVI scores to ClickUp custom fields,
// creates vault branch, writes resource bundle, posts kickoff comment with branch name.
// Call after /confirm has persisted scores and vault_spec_content.
// Body: { conversationId: string, mappings: Record<fieldName, dbField>, figmaLink?: string, designReview?: { steps: unknown[]; divergenceNotes: string | null } }
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { conversationId, mappings, figmaLink, designReview } = await req.json() as {
    conversationId: string
    mappings: Record<string, string>
    figmaLink?: string
    designReview?: { steps: unknown[]; divergenceNotes?: string | null }
  }
  if (!conversationId) return NextResponse.json({ error: 'conversationId required' }, { status: 400 })

  const supabase = await getSupabaseServiceClient()

  // ── Load session user ─────────────────────────────────────────────────────────
  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // ── Load task + conversation in parallel ──────────────────────────────────────
  const [{ data: task }, { data: conv }] = await Promise.all([
    supabase.from('tasks').select('id, clickup_task_id, name').eq('id', id).single(),
    supabase.from('assessment_conversations')
      .select('id, effort, risk, fvi_score, final_scores, vault_spec_content')
      .eq('id', conversationId)
      .eq('task_id', id)
      .single(),
  ])
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  if (!conv.effort || !conv.risk) return NextResponse.json({ error: 'Assessment not yet confirmed' }, { status: 400 })

  // ── Types for columns not yet in generated Supabase types ─────────────────────
  type RoleRegistryJoin = { role_name: string; team_domain: string; influence_type: string; weight: number }
  type RoleAssessFullRow = {
    claude_proposed_frequency: number | null
    user_override_frequency: number | null
    claude_reasoning: string | null
    user_reasoning: string | null
    role_registry: RoleRegistryJoin
  }
  // ── Load objective scores + role assessments in parallel ──────────────────────
  const [{ data: objAssessments }, { data: roleAssessRows }, { data: roleAssessFull }, { data: objRegistry }] = await Promise.all([
    supabase.from('objective_assessments')
      .select('objective_id, score, reasoning')
      .eq('task_id', id),
    supabase.from('conversation_role_assessments')
      .select('usage_frequency, role_id')
      .eq('conversation_id', conversationId),
    // Fetch override columns + role_registry join for assessment.md
    // to-one join: role_registry returns as a nested object per row
    (supabase.from('conversation_role_assessments')
      .select('claude_proposed_frequency, user_override_frequency, claude_reasoning, user_reasoning, role_registry!inner(role_name, team_domain, influence_type, weight)')
      .eq('conversation_id', conversationId)) as unknown as Promise<{ data: RoleAssessFullRow[] | null }>,
    supabase.from('objectives_registry')
      .select('objective_id, name, owner_name'),
  ])

  if (!roleAssessFull) {
    console.error(`[bundle task=${id}] roleAssessFull query returned null — assessment.md will have empty roles`)
  }

  // Resolve role details from registry
  const roleIds = (roleAssessRows ?? []).map((r) => r.role_id)
  const { data: roleRegistryRows } = roleIds.length > 0
    ? await supabase.from('role_registry')
        .select('id, role_name, team_domain, influence_type, weight')
        .in('id', roleIds)
    : { data: [] }

  const roleById = new Map((roleRegistryRows ?? []).map((r) => [r.id, r]))
  const roles = (roleAssessRows ?? []).flatMap((r) => {
    const reg = roleById.get(r.role_id)
    if (!reg) return []
    return [{ roleName: reg.role_name, teamDomain: reg.team_domain, influenceType: reg.influence_type as 'DM' | 'NDM', weight: reg.weight, usageFrequency: r.usage_frequency }]
  })

  const rolesForDoc = (roleAssessFull ?? []).map(ra => {
    const reg = ra.role_registry
    return {
      roleName: reg.role_name,
      teamDomain: reg.team_domain,
      influenceType: reg.influence_type as 'DM' | 'NDM',
      weight: reg.weight,
      claudeProposedFrequency: ra.claude_proposed_frequency ?? 0,
      userOverrideFrequency: ra.user_override_frequency ?? null,
      claudeReasoning: ra.claude_reasoning ?? null,
      userReasoning: ra.user_reasoning ?? null,
    }
  })

  const objNameMap = new Map((objRegistry ?? []).map(o => [o.objective_id, { name: o.name, owner: o.owner_name }]))

  const objectivesForDoc = (objAssessments ?? []).map(s => ({
    objectiveId: s.objective_id,
    objectiveName: objNameMap.get(s.objective_id)?.name ?? `Objective ${s.objective_id}`,
    objectiveOwner: objNameMap.get(s.objective_id)?.owner ?? '',
    score: s.score,
    reasoning: s.reasoning ?? '',
  }))

  // ── Re-run FVI from persisted data ───────────────────────────────────────────
  const objectiveScores = (objAssessments ?? []).map((s) => ({ objectiveId: s.objective_id, score: s.score }))
  const roleAssessments = roles.map((r) => ({ roleName: r.roleName, influenceType: r.influenceType, weight: r.weight, usageFrequency: r.usageFrequency }))
  const fviResult = computeFullFVI(objectiveScores, roleAssessments, conv.effort, conv.risk)

  // ── Build the complete db-field → value map ───────────────────────────────────
  const dbFieldValues: Record<string, number | string | null> = {
    fvi_score: fviResult.fviScore,
    cost_effort: conv.effort,
    cost_risk: conv.risk,
    inverted_influence: Math.round(fviResult.invertedInfluence * 1000) / 1000,
    decision_maker_score: Math.round(fviResult.iDmNorm * 1000) / 1000,
    nondecision_maker_score: Math.round(fviResult.iNdmNorm * 1000) / 1000,
  }
  for (const s of objAssessments ?? []) {
    if (s.objective_id >= 1 && s.objective_id <= 7) {
      dbFieldValues[`obj_${s.objective_id}_score`] = s.score
      if (s.reasoning) dbFieldValues[`obj_${s.objective_id}_desc`] = s.reasoning
    }
  }

  // ── Fetch external tokens ─────────────────────────────────────────────────────
  const [{ data: cuToken }, { data: ghToken }] = await Promise.all([
    supabase.from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'clickup').single(),
    supabase.from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'github').single(),
  ])
  const ghAccessToken = ghToken?.access_token ?? process.env.GITHUB_TOKEN

  // ── Create bundle_generations record ──────────────────────────────────────────
  const { data: bundleGen } = await supabase.from('bundle_generations').insert({
    task_id: id,
    conversation_id: conversationId,
    generated_by: user.id,
  }).select('id').single()

  const filesWritten: string[] = []
  const clickupFieldsWritten: string[] = []
  let clickupCommentPosted = false
  let vaultBranch: string | null = null
  let vaultSpecUrl: string | null = null
  const errors: string[] = []

  // ── 1. ClickUp custom field write-back ────────────────────────────────────────
  // Fetch live task from ClickUp to get current field UUIDs (Supabase snapshot may be stale)
  if (cuToken?.access_token && mappings && typeof mappings === 'object') {
    try {
      const cu = buildClickUpClient(cuToken.access_token)
      const cuTask = await cu.getTask(task.clickup_task_id)
      const nameToFieldId = new Map(
        (cuTask.custom_fields ?? []).map((f: { id: string; name: string }) => [f.name, f.id])
      )
      // Invert mappings: dbField → ClickUp field name
      const dbFieldToName = new Map(
        Object.entries(mappings as Record<string, string>)
          .filter(([, dbField]) => dbField)
          .map(([name, dbField]) => [dbField, name])
      )

      await Promise.all(
        Object.entries(dbFieldValues).map(async ([dbField, value]) => {
          if (value === null) return
          const fieldName = dbFieldToName.get(dbField)
          if (!fieldName) return
          const fieldId = nameToFieldId.get(fieldName)
          if (!fieldId) return
          try {
            await cu.setCustomField(task.clickup_task_id, fieldId, value)
            clickupFieldsWritten.push(dbField)
          } catch (err) {
            console.error(`[bundle task=${id}] setCustomField(${dbField}) failed:`, err)
          }
        })
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[bundle task=${id}] ClickUp field write-back failed:`, err)
      errors.push(`clickup_fields: ${msg}`)
    }
  }

  // ── 2. Vault resource bundle ──────────────────────────────────────────────────
  const specContent = conv.vault_spec_content ?? buildSpecStub(
    task.name,
    task.clickup_task_id,
    fviResult,
    conv.effort,
    conv.risk,
    (objAssessments ?? []).map((s) => ({ objectiveId: s.objective_id, score: s.score, reasoning: s.reasoning ?? undefined }))
  )

  if (ghAccessToken) {
    try {
      const slug = vaultBranchName(task.clickup_task_id, task.name).replace(`docs/feature/${task.clickup_task_id}-`, '')
      const dir = `FeaturePlanning/_Active/${task.clickup_task_id}-${slug}`
      const today = new Date().toISOString().slice(0, 10)
      const commit = (file: string) => `PM Agent: ${file} for ${task.name} (${today})`

      const pmAppCommitSha = process.env.NEXT_PUBLIC_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev'
      const riskLevelLabel = RISK_LEVELS.find(r => r.multiplier === conv.risk)?.label ?? `${conv.risk}x`

      vaultBranch = await createVaultBranch(ghAccessToken, task.clickup_task_id, task.name)

      // spec.md — gating write
      const written = await writeVaultFile(ghAccessToken, `${dir}/spec.md`, specContent, commit('FVI assessment'), vaultBranch)
      if (!written) throw new Error('spec.md write returned null')
      vaultSpecUrl = written.url
      filesWritten.push('spec.md')

      await supabase.from('tasks').update({ git_branch: vaultBranch }).eq('id', id)

      // Build score array with reasoning for plan-draft
      const scoresWithReasoning = (objAssessments ?? []).map((s) => ({
        objectiveId: s.objective_id,
        score: s.score,
        reasoning: s.reasoning ?? undefined,
      }))

      // Secondary files — each non-fatal
      const assessmentContent = buildAssessmentDoc({
        taskName: task.name,
        clickupId: task.clickup_task_id,
        objectives: objectivesForDoc,
        roles: rolesForDoc,
        fvi: fviResult,
        effort: conv.effort,
        riskLevel: riskLevelLabel,
        riskMultiplier: conv.risk,
        conversationId,
        pmAppCommitSha,
      })

      await writeVaultFile(ghAccessToken, `${dir}/assessment.md`, assessmentContent, commit('FVI assessment doc'), vaultBranch)
        .then(() => filesWritten.push('assessment.md'))
        .catch((err) => console.error(`[bundle task=${id}] assessment.md failed:`, err))

      await writeVaultFile(ghAccessToken, `${dir}/roles-affected.md`, buildRolesAffected(task.name, roles, fviResult), commit('roles affected'), vaultBranch)
        .then(() => filesWritten.push('roles-affected.md'))
        .catch((err) => console.error(`[bundle task=${id}] roles-affected.md failed:`, err))

      await writeVaultFile(ghAccessToken, `${dir}/plan-draft.md`, buildPlanDraft(task.name, task.clickup_task_id, fviResult, conv.effort, conv.risk, scoresWithReasoning, specContent), commit('plan draft'), vaultBranch)
        .then(() => filesWritten.push('plan-draft.md'))
        .catch((err) => console.error(`[bundle task=${id}] plan-draft.md failed:`, err))

      const kickoffContent = buildKickoffPrompt(task.name, task.clickup_task_id, fviResult, conv.effort, conv.risk, vaultBranch)

      await writeVaultFile(ghAccessToken, `${dir}/kickoff-prompt.md`, kickoffContent, commit('kickoff prompt'), vaultBranch)
        .then(() => filesWritten.push('kickoff-prompt.md'))
        .catch((err) => console.error(`[bundle task=${id}] kickoff-prompt.md failed:`, err))

      await writeVaultFile(ghAccessToken, `${dir}/claude-md-block.md`, buildClaudeMdBlock(task.name, task.clickup_task_id, vaultBranch, fviResult, roles), commit('CLAUDE.md injection'), vaultBranch)
        .then(() => filesWritten.push('claude-md-block.md'))
        .catch((err) => console.error(`[bundle task=${id}] claude-md-block.md failed:`, err))

      // guided-tour.json — 8th bundle file (non-fatal)
      if (Array.isArray(designReview?.steps) && designReview.steps.length > 0) {
        const guidedTour = {
          generatedAt: new Date().toISOString(),
          figmaLink: figmaLink ?? null,
          steps: designReview.steps,
          divergenceNotes: designReview.divergenceNotes ?? null,
        }
        await writeVaultFile(ghAccessToken, `${dir}/guided-tour.json`, JSON.stringify(guidedTour, null, 2), commit('guided tour'), vaultBranch)
          .then(() => filesWritten.push('guided-tour.json'))
          .catch((err) => {
            console.error(`[bundle task=${id}] guided-tour.json failed:`, err)
            errors.push('guided_tour_write_failed')
          })
      }

      // ── 3. ClickUp kickoff comment (with branch name) ───────────────────────
      if (cuToken?.access_token) {
        try {
          const cu = buildClickUpClient(cuToken.access_token)
          const kickoffContent = buildKickoffPrompt(task.name, task.clickup_task_id, fviResult, conv.effort, conv.risk, vaultBranch)
          await cu.createTaskComment(task.clickup_task_id, kickoffContent)
          clickupCommentPosted = true
        } catch (err) {
          console.error(`[bundle task=${id}] ClickUp kickoff comment failed:`, err)
          errors.push('clickup_comment: failed')
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[bundle task=${id}] Vault bundle failed:`, err)
      errors.push(`vault: ${msg}`)
      vaultBranch = null
    }
  }

  // ── Update bundle_generations record ─────────────────────────────────────────
  if (bundleGen?.id) {
    await supabase.from('bundle_generations').update({
      vault_branch: vaultBranch,
      vault_spec_url: vaultSpecUrl,
      files_written: filesWritten,
      clickup_fields_written: clickupFieldsWritten,
      clickup_comment_posted: clickupCommentPosted,
      error_details: errors.length > 0 ? (errors as unknown as Json) : null,
      completed_at: new Date().toISOString(),
    }).eq('id', bundleGen.id)
  }

  return NextResponse.json({
    vaultBranch,
    vaultSpecUrl,
    filesWritten,
    clickupFieldsWritten,
    clickupCommentPosted,
    errors: errors.length > 0 ? errors : undefined,
  })
}

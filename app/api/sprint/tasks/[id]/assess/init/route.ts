import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildClickUpClient } from '@/lib/clickup/client'
import { searchFeatureSpecs, searchVault, extractKeywords, readVaultFile, readDevObjectives } from '@/lib/github/vault'
import Anthropic from '@anthropic-ai/sdk'
import { mergeRolesWithRegistry } from '@/lib/role-merge'

export const maxDuration = 300

type Params = { params: Promise<{ id: string }> }

const CLAUDE_MODEL = 'claude-opus-4-6'

// POST /api/sprint/tasks/[id]/assess/init
// Gathers vault context + other tasks, pre-scores all 7 objectives, generates first question.
export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()

  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // ── Fetch the task ──────────────────────────────────────────────────────────
  const { data: task } = await supabase
    .from('tasks')
    .select('id, name, status, clickup_task_id, fvi_score, cost_effort, cost_risk, inverted_influence, custom_fields')
    .eq('id', id)
    .single()
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  // ── ClickUp: fresh description + custom fields ──────────────────────────────
  let clickupDescription = ''
  let customFields: Array<{ id: string; name: string; value: unknown }> = []
  let figmaLink = ''
  const { data: cuToken } = await supabase.from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'clickup').single()
  if (cuToken?.access_token) {
    try {
      const cu = buildClickUpClient(cuToken.access_token)
      const cuTask = await cu.getTask(task.clickup_task_id)
      clickupDescription = cuTask.description ?? ''
      customFields = (cuTask.custom_fields ?? []).map((f) => {
        let value = f.value
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          const obj = value as Record<string, unknown>
          value = obj.label ?? obj.name ?? obj.value ?? String(value)
        }
        if (Array.isArray(value)) {
          value = (value as Array<{ label?: string; name?: string }>).map((v) => v.label ?? v.name ?? String(v)).join(', ')
        }
        return { id: f.id, name: f.name, value }
      })
      const figmaField = customFields.find((f) => f.name === 'Figma')
      figmaLink = figmaField ? String(figmaField.value ?? '') : ''
    } catch { /* non-fatal */ }
  }

  // ── Other tasks in the system ───────────────────────────────────────────────
  const { data: allTasks } = await supabase
    .from('tasks')
    .select('id, name, status, fvi_score, sprint_id')
    .neq('id', id)
    .order('created_at', { ascending: false })
  const { data: sprints } = await supabase.from('sprints').select('id, name, status')
  const sprintMap = new Map((sprints ?? []).map((s) => [s.id, s.name]))
  const otherTasksSummary = (allTasks ?? []).slice(0, 40).map((t) => ({
    name: t.name,
    status: t.status,
    fvi: t.fvi_score != null ? t.fvi_score.toFixed(2) : 'unscored',
    sprint: t.sprint_id ? (sprintMap.get(t.sprint_id) ?? 'Unknown Sprint') : 'Backlog',
  }))

  // ── Previous assessments for this task ─────────────────────────────────────
  const { data: prevConvs } = await supabase
    .from('assessment_conversations')
    .select('id, created_at, fvi_score, final_scores, status')
    .eq('task_id', id)
    .eq('status', 'complete')
    .order('created_at', { ascending: false })
    .limit(2)
  const isReassessment = (prevConvs?.length ?? 0) > 0
  const lastAssessment = prevConvs?.[0] ?? null

  // ── Objectives and roles from DB ───────────────────────────────────────────
  const { data: objectives } = await supabase.from('objectives_registry').select('*').order('objective_id')
  const { data: allRolesRaw } = await supabase
    .from('role_registry')
    .select('id, role_name, team_domain, influence_type, weight')
    .eq('is_active', true)
    .order('team_domain')
    .order('influence_type')
    .order('weight', { ascending: false })
  // Map DB `id` → `role_id` to satisfy RegistryRole interface
  const allRoles = (allRolesRaw ?? []).map((r) => ({
    role_id: r.id,
    role_name: r.role_name,
    team_domain: r.team_domain,
    influence_type: r.influence_type as 'DM' | 'NDM',
    weight: r.weight,
  }))

  // ── Vault search ────────────────────────────────────────────────────────────
  const { data: ghToken } = await supabase.from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'github').single()
  const vaultConnected = !!ghToken?.access_token
  const ghAccessToken = ghToken?.access_token ?? process.env.GITHUB_TOKEN
  const vaultFilesRead: string[] = []
  let vaultContext = ''

  let devObjectivesContent = ''

  if (ghAccessToken) {
    try {
      const keywords = extractKeywords(task.name)
      const [specResults, broadResults, devObjContent] = await Promise.all([
        searchFeatureSpecs(ghAccessToken, keywords),
        searchVault(ghAccessToken, keywords, 3),
        readDevObjectives(ghAccessToken),
      ])
      devObjectivesContent = devObjContent

      const allResults = [...specResults, ...broadResults].slice(0, 5)
      for (const r of allResults) {
        if (!vaultFilesRead.includes(r.path)) {
          vaultFilesRead.push(r.path)
          vaultContext += `\n\n---\nFile: ${r.path}\n${r.snippet}`
        }
      }
    } catch { /* non-fatal */ }
  }

  // ── Figma thumbnail ─────────────────────────────────────────────────────────
  let figmaThumbUrl: string | null = null
  if (figmaLink) {
    const { data: figmaToken } = await supabase.from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'figma').single()
    if (figmaToken?.access_token) {
      try {
        const fileMatch = figmaLink.match(/figma\.com\/(?:file|design)\/([^/?]+)/)
        if (fileMatch?.[1]) {
          const thumbRes = await fetch(`https://api.figma.com/v1/files/${fileMatch[1]}/thumbnails`, {
            headers: { 'X-Figma-Token': figmaToken.access_token },
          })
          if (thumbRes.ok) {
            const thumbData = await thumbRes.json()
            figmaThumbUrl = thumbData.thumbnails?.[0]?.url ?? null
          }
        }
      } catch { /* non-fatal */ }
    }
  }

  // ── Build Claude prompt ─────────────────────────────────────────────────────
  // Use live DevObjectives files from the vault as the canonical source of truth.
  // Fall back to DB-seeded data only when the vault is not connected.
  const objectivesText = devObjectivesContent ||
    (objectives ?? []).map((o) =>
      `Objective ${o.objective_id} — ${o.name} (Owner: ${o.owner_name})\nMandate: ${o.mandate}\nScore matrix: ${JSON.stringify(o.score_matrix)}`
    ).join('\n\n')

  const rolesText = (allRoles ?? []).map((r) =>
    `${r.role_name} (${r.team_domain}, ${r.influence_type}, weight ${r.weight})`
  ).join(', ')

  const otherTasksText = otherTasksSummary.map((t) =>
    `- "${t.name}" | Status: ${t.status} | FVI: ${t.fvi} | Location: ${t.sprint}`
  ).join('\n')

  const reassessmentContext = isReassessment && lastAssessment
    ? `\n\nPREVIOUS ASSESSMENT (${lastAssessment.created_at.slice(0, 10)}): FVI was ${lastAssessment.fvi_score?.toFixed(2) ?? 'N/A'}. Previous scores: ${JSON.stringify(lastAssessment.final_scores)}. Note what may have changed since then.`
    : ''

  const systemPrompt = `You are the Viscap PM Agent. Your role is to assess whether a ClickUp task should be prioritized in the product backlog by scoring it using the Feature Value Index (FVI) system.

You operate on a SUGGESTION-FIRST principle: pre-score all objectives based on available evidence, then ask questions ONLY for objectives you cannot score confidently. The goal is the minimum number of questions needed.

THE FVI FORMULA:
FVI = (ObjTotal + 64) / (InvertedInfluence × Effort × Risk)
InvertedInfluence = 1 − ((3 × I_DM_norm + I_NDM_norm) / 4)
I_DM_norm = sum(DM_role_weight × usage_freq) / 380
I_NDM_norm = sum(NDM_role_weight × usage_freq) / 224
Usage frequency: 1=Access Default, 2=Access Sometimes, 3=Uses Sometimes, 4=Uses Every Day
Risk levels: 1.0=Routine, 1.2=Standard, 1.5=Moderate, 2.0=High, 3.0=Critical

THE 7 OBJECTIVES, SCORE MATRICES, AND RISK FRAMEWORK (${devObjectivesContent ? 'sourced live from ViscapMedia/documentation/DevObjectives — canonical source of truth' : 'fallback: DB-seeded data — vault not connected'}):
${objectivesText}

AVAILABLE ROLES FOR INFLUENCE CALCULATION:
${rolesText}

TROJAN HORSE RULE: If Obj1(Data)=+5 AND (Obj2(Modular)≤-4 OR Obj3(UserSuccess)≤-4) → flag as Trojan Horse.

DECISION THRESHOLDS: >5=Build This Sprint | 2-5=Build Next Sprint | 0.5-2=Backlog | <0.5=Kill | Negative=Kill Immediately

Your response MUST be valid JSON matching this exact structure — no markdown, no explanation outside JSON:
{
  "proposedScores": [
    {"objectiveId":1,"objectiveName":"Data-Backed Decisions","objectiveOwner":"Architect of Truth","score":<-5 to 5>,"confidence":"high|medium|low","reasoning":"<1-2 sentences>","evidence":"<vault file path or task evidence, or 'No vault match found'>"}
  ],
  "firstQuestion": <null if all objectives high-confidence, otherwise: {"objectiveId":<1-7>,"objectiveName":"...","objectiveOwner":"...","question":"...","reasoning":"<why you can't score this without the answer>","evidence":"<what you found that prompted the question>","currentProposedScore":<score>}>,
  "totalEstimatedQuestions": <0-4>,
  "overlappingTasks": [{"taskName":"...","relationship":"duplicate|related|prerequisite","note":"...","sprintAssignment":"..."}],
  "costOfNotBuilding": "<2-3 sentences: what happens if this never gets built — user friction, workarounds, business risk>",
  "workflowGapAssessment": "<1-2 sentences: does this fix a broken workflow step or is it additive?>",
  "proposedRisk": {"level":"Routine|Standard|Moderate|High|Critical","multiplier":<1.0|1.2|1.5|2.0|3.0>,"reasoning":"<which risk checklist items triggered this>"},
  "proposedEffort": {"days":<number>,"reasoning":"<basis for estimate, reference similar tasks if known>"},
  "proposedRoles": [{"roleName":"...","teamDomain":"agency|brand","influenceType":"DM|NDM","weight":<number>,"usageFrequency":<1-4>,"reasoning":"<why this role is affected at this frequency>"}],
  "isReassessment": <true|false>,
  "previousScoreSummary": <null or "Previous FVI was X.XX. Key changes since then: ...">
}`

  const userMessage = `TASK TO ASSESS:
Name: ${task.name}
ClickUp ID: ${task.clickup_task_id}
Current Status: ${task.status}
Current FVI in DB: ${task.fvi_score != null ? task.fvi_score.toFixed(2) : 'Not yet scored'}

CLICKUP DESCRIPTION:
${clickupDescription || '(No description provided)'}

CUSTOM FIELDS:
${customFields.map((f) => `${f.name}: ${f.value ?? '—'}`).join('\n') || '(None)'}

VAULT CONTENT FOUND:
${vaultContext || '(Vault not connected or no relevant documents found)'}

OTHER TASKS IN THE SYSTEM (for overlap detection):
${otherTasksText || '(No other tasks)'}
${reassessmentContext}`

  const anthropic = new Anthropic()
  let response: Awaited<ReturnType<typeof anthropic.messages.create>>
  try {
    response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[assess:init task=${id}] Anthropic API error:`, err)
    return NextResponse.json({ error: `Claude API error: ${msg}` }, { status: 500 })
  }

  const textBlock = response.content.find((b) => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    return NextResponse.json({ error: 'No response from Claude' }, { status: 500 })
  }

  // Parse JSON — strip markdown fences if present
  let assessment: Record<string, unknown>
  try {
    const raw = textBlock.text.trim().replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '')
    assessment = JSON.parse(raw)
  } catch {
    const match = textBlock.text.match(/\{[\s\S]*\}/)
    if (!match) return NextResponse.json({ error: 'Failed to parse Claude response', raw: textBlock.text.slice(0, 500) }, { status: 500 })
    try { assessment = JSON.parse(match[0]) } catch {
      return NextResponse.json({ error: 'Failed to parse Claude response', raw: textBlock.text.slice(0, 500) }, { status: 500 })
    }
  }

  // ── Merge Claude's proposed roles with the full registry ───────────────────
  const claudeProposed: Array<{ roleName: string; usageFrequency: number; reasoning: string }> =
    (assessment.proposedRoles as Array<{ roleName: string; usageFrequency: number; reasoning: string }>) ?? []

  const fullRoles = mergeRolesWithRegistry(allRoles ?? [], claudeProposed)

  // ── Persist conversation ────────────────────────────────────────────────────
  const { data: conv } = await supabase
    .from('assessment_conversations')
    .insert({
      task_id: id,
      status: 'in_progress',
      vault_context: { filesRead: vaultFilesRead, hasVault: vaultConnected } as unknown as import('@/lib/supabase/types').Json,
      proposed_scores: assessment.proposedScores as unknown as import('@/lib/supabase/types').Json,
    })
    .select('id')
    .single()

  if (conv?.id && assessment.firstQuestion) {
    await supabase.from('assessment_messages').insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: (assessment.firstQuestion as Record<string, unknown>).question as string,
      objective_id: (assessment.firstQuestion as Record<string, unknown>).objectiveId as number,
      proposed_score: (assessment.firstQuestion as Record<string, unknown>).currentProposedScore as number,
      vault_evidence: (assessment.firstQuestion as Record<string, unknown>).evidence as string,
    })
  }

  return NextResponse.json({
    conversationId: conv?.id,
    ...assessment,
    proposedRoles: fullRoles,
    figmaThumbUrl,
    figmaLink,
    vaultConnected,
    vaultFilesRead,
    isReassessment,
  })
}

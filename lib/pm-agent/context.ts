/**
 * Fetches all context needed by the PM Agent from Supabase.
 * No external API calls — only Supabase reads.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

export interface AgentContext {
  task: {
    id: string
    clickupTaskId: string
    name: string
    status: string
    fviScore: number | null
    costEffort: number | null
    costRisk: number | null
    gitBranch: string | null
  }
  sprint: { name: string; costBudget: number; endDate: string | null } | null
  objectives: Array<{ objectiveId: number; score: number; reasoning: string | null }>
  /** SKILL.md content snapshots for the top 3 DM roles by influence score */
  skillSnapshots: Array<{ roleSlug: string; content: string }>
  config: {
    pmAgentAction: string
    writeBackOrder: string[]
    writeBackConfig: Record<string, unknown>
    onFailure: 'continue' | 'stop'
  }
}

export async function buildAgentContext(
  supabase: SupabaseClient<Database>,
  taskId: string,
  configId: string
): Promise<AgentContext | null> {
  const [{ data: task }, { data: config }] = await Promise.all([
    supabase
      .from('tasks')
      .select('id, clickup_task_id, name, status, fvi_score, cost_effort, cost_risk, git_branch, sprint_id')
      .eq('id', taskId)
      .single(),
    supabase
      .from('trigger_configs')
      .select('pm_agent_action, write_back_order, write_back_config, on_failure')
      .eq('id', configId)
      .single(),
  ])

  if (!task || !config) return null

  // Sprint (if assigned)
  let sprint: AgentContext['sprint'] = null
  if (task.sprint_id) {
    const { data: sprintRow } = await supabase
      .from('sprints')
      .select('name, cost_budget, end_date')
      .eq('id', task.sprint_id)
      .single()
    if (sprintRow) {
      sprint = { name: sprintRow.name, costBudget: sprintRow.cost_budget, endDate: sprintRow.end_date }
    }
  }

  // Objective assessments
  const { data: objectives } = await supabase
    .from('objective_assessments')
    .select('objective_id, score, reasoning')
    .eq('task_id', taskId)
    .order('objective_id')

  // Top DM SKILL snapshots from the most recent complete assessment
  let skillSnapshots: AgentContext['skillSnapshots'] = []

  const { data: latestConv } = await supabase
    .from('assessment_conversations')
    .select('id')
    .eq('task_id', taskId)
    .eq('status', 'complete')
    .order('completed_at', { ascending: false })
    .limit(1)
    .single()

  if (latestConv) {
    type RoleRow = {
      usage_frequency: number
      role_registry: { role_name: string; influence_type: string; weight: number }
    }

    const { data: roleAssessments } = await supabase
      .from('conversation_role_assessments')
      .select('usage_frequency, role_registry!inner(role_name, influence_type, weight)')
      .eq('conversation_id', latestConv.id)

    if (roleAssessments?.length) {
      const topSlugs = (roleAssessments as unknown as RoleRow[])
        .filter((r) => r.role_registry.influence_type === 'DM')
        .sort((a, b) => b.role_registry.weight * b.usage_frequency - a.role_registry.weight * a.usage_frequency)
        .slice(0, 3)
        .map((r) => r.role_registry.role_name.toLowerCase().replace(/\s+/g, '-'))

      if (topSlugs.length) {
        const { data: skills } = await supabase
          .from('skills_library')
          .select('role_slug, content_snapshot')
          .in('role_slug', topSlugs)
          .not('content_snapshot', 'is', null)

        skillSnapshots = (skills ?? []).map((s) => ({
          roleSlug: s.role_slug,
          content: s.content_snapshot!,
        }))
      }
    }
  }

  return {
    task: {
      id: task.id,
      clickupTaskId: task.clickup_task_id,
      name: task.name,
      status: task.status,
      fviScore: task.fvi_score,
      costEffort: task.cost_effort,
      costRisk: task.cost_risk,
      gitBranch: task.git_branch,
    },
    sprint,
    objectives: (objectives ?? []).map((o) => ({
      objectiveId: o.objective_id,
      score: o.score,
      reasoning: o.reasoning,
    })),
    skillSnapshots,
    config: {
      pmAgentAction: config.pm_agent_action,
      writeBackOrder: config.write_back_order,
      writeBackConfig: config.write_back_config as Record<string, unknown>,
      onFailure: config.on_failure,
    },
  }
}

// lib/features/gatekeeper.ts
// The prototyping gatekeeper: when a ClickUp task is flagged Ready-for-Prototype
// (status in CLICKUP_PROTOTYPE_STATUSES, or the proto-ready tag), scaffold-or-find
// the feature, enrich it with deep ClickUp metadata (description, objectives, FVI),
// and set its app identity so the chat loop targets the right codebase.
//
// Idempotent by design: ClickUp retries and repeat transitions re-enrich the same
// feature (matched via feature_tasks) — they never duplicate it, never downgrade
// planning_phase, and never clobber a PM's manual app choice after planning began.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/lib/supabase/types'
import { buildClickUpClient, type ClickUpTask } from '@/lib/clickup/client'
import {
  extractFviScore,
  extractObjectivesJson,
  resolveAppIdentity,
  type ClickUpCustomField,
} from '@/lib/features/gatekeeper-extract'

type Db = SupabaseClient<Database>

export interface GatekeeperResult {
  featureId: string
  created: boolean
  app: string
  appSource: string
}

export async function activateFeatureFromTask(
  db: Db,
  clickupTaskId: string,
  prefetched?: ClickUpTask,
  opts?: { scaffoldIfMissing?: boolean },
): Promise<GatekeeperResult | null> {
  let cuTask = prefetched
  if (!cuTask) {
    const { data: tokenRow } = await db
      .from('oauth_tokens').select('access_token').eq('provider', 'clickup').limit(1).single()
    if (!tokenRow) {
      console.warn('[gatekeeper] no ClickUp token — cannot enrich task', clickupTaskId)
      return null
    }
    cuTask = await buildClickUpClient(tokenRow.access_token).getTask(clickupTaskId)
  }
  const fields = (cuTask.custom_fields ?? []) as ClickUpCustomField[]
  const tags = (cuTask.tags ?? []).map((t) => t.name)

  // Local task row (for FVI fallback + feature linkage); auto-import if missing.
  const task = await findOrImportTask(db, cuTask)

  const app = resolveAppIdentity({
    tags,
    listRepoFullName: task ? await listRepoFullName(db, task.list_id) : null,
    fields,
  })

  const enrichment = {
    clickup_details: cuTask.description?.trim() || null,
    objectives_json: (extractObjectivesJson(fields) as unknown as Json) ?? null,
    fvi_score: extractFviScore(fields) ?? task?.fvi_score ?? null,
  }

  // Existing feature for this task? (feature_tasks is the dedupe key.)
  const existing = task ? await findFeatureForTask(db, task.id) : null

  if (existing) {
    const { error } = await db.from('features').update({
      ...enrichment,
      // Auto-routing must not clobber a manual choice once planning is underway:
      // only (re)route while the feature is still in the planning phase.
      ...(existing.planning_phase === 'planning' ? { app: app.app } : {}),
    }).eq('id', existing.id)
    if (error) throw new Error(`gatekeeper enrich failed: ${error.message}`)
    console.log('[gatekeeper] enriched feature', existing.id, 'app:', app.app, `(${app.source})`)
    return { featureId: existing.id, created: false, app: app.app, appSource: app.source }
  }

  // No feature yet for this task. Enrichment-only callers (objectives sync,
  // manual re-sync) pass scaffoldIfMissing:false so we never create a feature
  // from a task that hasn't cleared the prototype-ready admission gate.
  if (opts?.scaffoldIfMissing === false) {
    console.log('[gatekeeper] skip scaffold (enrich-only) for task', clickupTaskId)
    return null
  }

  const { data: created, error } = await db.from('features').insert({
    name: cuTask.name,
    description: firstParagraph(cuTask.description),
    status: 'active',
    app: app.app,
    ...enrichment,
  }).select('id').single()
  if (error || !created) throw new Error(`gatekeeper scaffold failed: ${error?.message}`)

  if (task) {
    const { error: linkErr } = await db.from('feature_tasks').insert({ feature_id: created.id, task_id: task.id })
    if (linkErr && linkErr.code !== '23505') {
      console.warn('[gatekeeper] task link failed for feature', created.id, linkErr.message)
    }
  }

  console.log('[gatekeeper] scaffolded feature', created.id, 'from task', clickupTaskId, 'app:', app.app, `(${app.source})`)
  return { featureId: created.id, created: true, app: app.app, appSource: app.source }
}

interface LocalTask { id: string; list_id: string; fvi_score: number | null }

async function findOrImportTask(db: Db, cuTask: ClickUpTask): Promise<LocalTask | null> {
  const { data: task } = await db
    .from('tasks').select('id, list_id, fvi_score').eq('clickup_task_id', cuTask.id).single()
  if (task) return task

  const { data: list } = await db.from('lists').select('id').eq('clickup_list_id', cuTask.list.id).limit(1).single()
  if (!list) return null
  const { data: inserted } = await db.from('tasks').insert({
    clickup_task_id: cuTask.id,
    list_id: list.id,
    name: cuTask.name,
    status: cuTask.status?.status ?? 'unknown',
    custom_fields: (cuTask.custom_fields ?? []) as unknown as Json,
    synced_at: new Date().toISOString(),
  }).select('id, list_id, fvi_score').single()
  return inserted ?? null
}

async function listRepoFullName(db: Db, listId: string): Promise<string | null> {
  const { data: list } = await db.from('lists').select('repo_registry_id').eq('id', listId).single()
  if (!list?.repo_registry_id) return null
  const { data: repo } = await db
    .from('repo_registry').select('github_repo_full_name').eq('id', list.repo_registry_id).single()
  return repo?.github_repo_full_name ?? null
}

async function findFeatureForTask(
  db: Db,
  taskId: string
): Promise<{ id: string; planning_phase: string } | null> {
  const { data } = await db
    .from('feature_tasks')
    .select('features(id, planning_phase)')
    .eq('task_id', taskId)
    .limit(1)
  const row = data?.[0]?.features as { id: string; planning_phase: string } | { id: string; planning_phase: string }[] | null | undefined
  if (!row) return null
  return Array.isArray(row) ? (row[0] ?? null) : row
}

function firstParagraph(text: string | null | undefined): string | null {
  if (!text) return null
  const para = text.trim().split(/\n\s*\n/)[0]?.trim()
  if (!para) return null
  return para.length > 500 ? `${para.slice(0, 497)}…` : para
}

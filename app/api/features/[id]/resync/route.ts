import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { getClickupTaskIdForFeature, getFeature } from '@/lib/features/client'
import { activateFeatureFromTask } from '@/lib/features/gatekeeper'

// Fetches the ClickUp task + re-extracts objectives/FVI; give it a little room.
export const maxDuration = 60

/**
 * Manually re-sync a feature's metadata from its ASSOCIATED ClickUp task —
 * re-extracting objectives_json / FVI / description that may have been filled in
 * (or approved) after the feature was scaffolded. Enrich-only: it resolves the
 * task from feature_tasks and passes scaffoldIfMissing:false, so it can only ever
 * update the existing feature, never create one from an unrelated task.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const clickupTaskId = await getClickupTaskIdForFeature(id)
  if (!clickupTaskId) {
    return NextResponse.json({ error: 'No ClickUp task associated with this feature' }, { status: 400 })
  }

  const db = await getSupabaseServiceClient()
  const result = await activateFeatureFromTask(db, clickupTaskId, undefined, { scaffoldIfMissing: false })
  if (!result) {
    return NextResponse.json(
      { error: 'Re-sync failed (no ClickUp token, or the task is no longer linked)' },
      { status: 502 },
    )
  }

  const feature = await getFeature(id)
  const oj = feature?.objectives_json as { objectives?: unknown[] } | null
  const objectivesCount = Array.isArray(oj?.objectives) ? oj.objectives.length : 0
  return NextResponse.json({ ok: true, objectivesCount })
}

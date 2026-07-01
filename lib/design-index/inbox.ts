// lib/design-index/inbox.ts
import { parseFigmaUrl } from '../figma/client'
import type { DesignIndex, Feature, UserStory } from './types'
import type { PendingEntry, PendingReason } from '../design-migration/types'

export interface InboxRow {
  clickupTaskId: string
  title: string
  figmaUrl: string | null
}
export interface PendingFile {
  version: number
  entries: PendingEntry[]
}
export interface ApplyCtx {
  pathExists: (glob: string) => boolean
}
export type ApplyOutcome = 'promoted' | 'recorded-pending' | 'new-stub' | 'noop'
export interface ApplyResult {
  clickupTaskId: string
  outcome: ApplyOutcome
}

function knownClickupIds(index: DesignIndex, entries: PendingEntry[]): Set<string> {
  const ids = new Set<string>()
  for (const f of index.features) for (const s of f.userStories) ids.add(s.clickupId)
  for (const e of entries) if (e.assignedClickupId) ids.add(e.assignedClickupId)
  return ids
}

/** A pending entry becomes a valid Feature only when every gate is satisfied. */
function tryBuildFeature(e: PendingEntry, ctx: ApplyCtx): Feature | null {
  const p = e.partial
  if (!p.id || !p.app || !p.section || !p.feature) return null
  if (!p.figmaFileKey || !p.figmaFileUrl) return null
  if (!p.codePaths || p.codePaths.length === 0) return null
  if (!e.assignedClickupId || !e.figmaNodeId) return null
  if (!p.codePaths.every((g) => ctx.pathExists(g))) return null
  const story: UserStory = {
    clickupId: e.assignedClickupId,
    title: e.title ?? e.assignedClickupId,
    status: 'in-design',
    figmaPageNodeId: e.figmaNodeId,
    sourceOfTruthNodeId: e.figmaNodeId,
    sandboxNodeId: e.figmaNodeId,
  }
  return {
    id: p.id,
    app: p.app,
    section: p.section,
    feature: p.feature,
    figmaFileKey: p.figmaFileKey,
    figmaFileUrl: p.figmaFileUrl,
    codePaths: p.codePaths,
    userStories: [story],
  }
}

function recomputeReasons(e: PendingEntry, ctx: ApplyCtx): PendingReason[] {
  const p = e.partial
  const reasons: PendingReason[] = []
  if (!p.app || !p.feature) reasons.push('unassigned-feature')
  if (!p.codePaths || p.codePaths.length === 0 || !p.codePaths.every((g) => ctx.pathExists(g))) {
    reasons.push('unassigned-codepaths')
  }
  if (!e.figmaNodeId) reasons.push('unassigned-figma')
  if (!e.assignedClickupId) reasons.push('placeholder-clickup')
  return reasons
}

export function applyInboxToIndex(
  index: DesignIndex,
  pending: PendingFile,
  rows: InboxRow[],
  ctx: ApplyCtx
): { index: DesignIndex; pending: PendingFile; results: ApplyResult[] } {
  const features = [...index.features]
  const entries = pending.entries.map((e) => ({ ...e, partial: { ...e.partial } }))
  const ids = knownClickupIds(index, entries)
  const results: ApplyResult[] = []

  // 1. Apply each inbox row.
  for (const row of rows) {
    if (ids.has(row.clickupTaskId)) {
      results.push({ clickupTaskId: row.clickupTaskId, outcome: 'noop' })
      continue
    }
    const parsed = row.figmaUrl ? parseFigmaUrl(row.figmaUrl) : null
    const fileKey = parsed?.fileKey
    const nodeId = parsed?.nodeId
    const match = fileKey
      ? entries.find((e) => e.partial.figmaFileKey === fileKey && !e.assignedClickupId)
      : undefined
    if (match) {
      match.assignedClickupId = row.clickupTaskId
      match.title = row.title
      if (nodeId) match.figmaNodeId = nodeId
      results.push({ clickupTaskId: row.clickupTaskId, outcome: 'recorded-pending' })
    } else {
      entries.push({
        featureId: `ticket-${row.clickupTaskId}`,
        reason: [],
        partial: { figmaFileKey: fileKey, figmaFileUrl: row.figmaUrl ?? undefined, codePaths: [] },
        assignedClickupId: row.clickupTaskId,
        title: row.title,
        figmaNodeId: nodeId,
      })
      results.push({ clickupTaskId: row.clickupTaskId, outcome: 'new-stub' })
    }
    ids.add(row.clickupTaskId)
  }

  // 2. Promote every entry that now satisfies all gates; recompute reasons for the rest.
  const stillPending: PendingEntry[] = []
  for (const e of entries) {
    const feat = tryBuildFeature(e, ctx)
    if (feat) {
      features.push(feat)
      const existing = results.find((r) => r.clickupTaskId === e.assignedClickupId)
      if (existing) existing.outcome = 'promoted'
    } else {
      e.reason = recomputeReasons(e, ctx)
      stillPending.push(e)
    }
  }

  return {
    index: { ...index, features },
    pending: { version: pending.version, entries: stillPending },
    results,
  }
}

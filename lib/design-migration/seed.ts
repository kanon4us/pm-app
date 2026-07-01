// lib/design-migration/seed.ts
import { featureIdFor } from './manifest'
import type { DesignIndex, Feature, UserStory } from '../design-index/types'
import type {
  IndexSplit,
  ManifestFile,
  MigrationManifest,
  PendingEntry,
  PendingReason,
} from './types'

function isPlaceholder(clickupId: string): boolean {
  return clickupId.startsWith('PENDING-')
}

function toFeature(f: ManifestFile): Feature {
  const userStories: UserStory[] = f.pages.map((p) => ({
    clickupId: p.clickupId,
    title: p.name,
    status: 'shipped', // legacy designs mirror the live product (spec §6)
    figmaPageNodeId: p.nodeId,
    sourceOfTruthNodeId: p.nodeId,
    sandboxNodeId: p.nodeId,
  }))
  return {
    id: featureIdFor(f.app!, f.targetSection!, f.targetFeature!),
    app: f.app!,
    section: f.targetSection!,
    feature: f.targetFeature!,
    figmaFileKey: f.sourceFileKey,
    figmaFileUrl: f.sourceFileUrl,
    codePaths: f.codePaths,
    userStories,
  }
}

function pendingReasons(f: ManifestFile): PendingReason[] {
  const reasons: PendingReason[] = []
  if (f.unassigned && (!f.app || !f.targetFeature)) reasons.push('unassigned-feature')
  if (f.codePaths.length === 0) reasons.push('unassigned-codepaths')
  if (f.pages.some((p) => isPlaceholder(p.clickupId))) reasons.push('placeholder-clickup')
  return reasons
}

export function manifestToIndexEntries(manifest: MigrationManifest): IndexSplit {
  const reconciled: Feature[] = []
  const pending: PendingEntry[] = []

  for (const f of manifest.files) {
    if (f.zone === 'archive') continue // archived originals aren't indexed
    const reasons = pendingReasons(f)
    if (reasons.length === 0 && f.app && f.targetSection && f.targetFeature) {
      reconciled.push(toFeature(f))
    } else {
      pending.push({
        featureId:
          f.app && f.targetSection && f.targetFeature
            ? featureIdFor(f.app, f.targetSection, f.targetFeature)
            : `unassigned-${f.sourceFileKey}`,
        reason: reasons.length > 0 ? reasons : ['unassigned-feature'],
        partial: {
          id:
            f.app && f.targetSection && f.targetFeature
              ? featureIdFor(f.app, f.targetSection, f.targetFeature)
              : undefined,
          app: f.app ?? undefined,
          section: f.targetSection ?? undefined,
          feature: f.targetFeature ?? undefined,
          figmaFileKey: f.sourceFileKey,
          figmaFileUrl: f.sourceFileUrl,
          codePaths: f.codePaths,
        },
      })
    }
  }

  return { reconciled, pending }
}

export function toDesignIndex(features: Feature[]): DesignIndex {
  return {
    version: 1,
    apps: {
      web: { figmaProject: '▣ WEB APP' },
      cms: { figmaProject: '▣ CMS APP' },
      mobile: { figmaProject: '▣ MOBILE APP' },
    },
    features,
  }
}

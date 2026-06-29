// lib/design-index/validate.ts
import { parseFigmaUrl } from '@/lib/figma/client'
import {
  ACTIVE_STATUSES,
  MAX_ACTIVE_STORIES,
  type DesignIndex,
  type UserStoryStatus,
  type ValidationContext,
} from '@/lib/design-index/types'

const VALID_STATUSES: ReadonlySet<UserStoryStatus> = new Set([
  'in-design',
  'approved',
  'shipped',
  'archived',
])

const VALID_APPS = new Set(['web', 'cms', 'mobile'])

/**
 * Validates a design index. Pure: all external facts arrive via `ctx`.
 * Returns a list of human-readable error strings; empty means valid.
 */
export function validateDesignIndex(index: DesignIndex, ctx: ValidationContext): string[] {
  const errors: string[] = []

  if (typeof index.version !== 'number') {
    errors.push(`version must be a number (got ${typeof index.version})`)
  }
  if (!index.apps || typeof index.apps !== 'object') {
    errors.push('apps must be an object')
  }
  if (!Array.isArray(index.features)) {
    errors.push('features must be an array')
    return errors // nothing further to check
  }

  const declaredApps = new Set(Object.keys(index.apps ?? {}))

  for (const f of index.features) {
    const where = `feature "${f.id ?? '(missing id)'}"`

    if (!f.id) errors.push(`${where}: missing id`)
    if (!VALID_APPS.has(f.app)) errors.push(`${where}: app "${f.app}" is not a known app`)
    if (!declaredApps.has(f.app)) errors.push(`${where}: app "${f.app}" is not declared in apps`)
    if (!f.section) errors.push(`${where}: missing section`)
    if (!f.feature) errors.push(`${where}: missing feature`)

    // Figma URL ↔ fileKey parity (reuses lib/figma/client.ts).
    const parsed = f.figmaFileUrl ? parseFigmaUrl(f.figmaFileUrl) : null
    if (!parsed) {
      errors.push(`${where}: figmaFileUrl is not a parseable Figma URL`)
    } else if (parsed.fileKey !== f.figmaFileKey) {
      errors.push(
        `${where}: figmaFileKey "${f.figmaFileKey}" does not match key in figmaFileUrl "${parsed.fileKey}"`
      )
    }

    if (!Array.isArray(f.codePaths) || f.codePaths.length === 0) {
      errors.push(`${where}: codePaths must be a non-empty array`)
    } else {
      for (const glob of f.codePaths) {
        if (!ctx.pathExists(glob)) {
          errors.push(`${where}: codePaths entry "${glob}" resolves to no files`)
        }
      }
    }

    if (!Array.isArray(f.userStories)) {
      errors.push(`${where}: userStories must be an array`)
      continue
    }

    for (const s of f.userStories) {
      const sw = `${where} story "${s.clickupId ?? '(missing clickupId)'}"`
      if (!s.clickupId) errors.push(`${sw}: missing clickupId`)
      if (!s.title) errors.push(`${sw}: missing title`)
      if (!VALID_STATUSES.has(s.status)) errors.push(`${sw}: invalid status "${s.status}"`)
      if (!s.figmaPageNodeId) errors.push(`${sw}: missing figmaPageNodeId`)
      if (!s.sourceOfTruthNodeId) errors.push(`${sw}: missing sourceOfTruthNodeId`)
      if (!s.sandboxNodeId) errors.push(`${sw}: missing sandboxNodeId`)
    }

    const activeCount = f.userStories.filter((s) => ACTIVE_STATUSES.has(s.status)).length
    if (activeCount > MAX_ACTIVE_STORIES) {
      errors.push(
        `${where}: ${activeCount} active user-story pages exceed the cap of ${MAX_ACTIVE_STORIES} (anti-crash rule)`
      )
    }
  }

  // Cross-feature: unique feature ids and unique clickupIds (the join-key).
  const seenFeatureIds = new Set<string>()
  const seenClickupIds = new Set<string>()
  for (const f of index.features) {
    if (f.id) {
      if (seenFeatureIds.has(f.id)) errors.push(`duplicate feature id "${f.id}"`)
      seenFeatureIds.add(f.id)
    }
    for (const s of f.userStories ?? []) {
      if (!s.clickupId) continue
      if (seenClickupIds.has(s.clickupId)) {
        errors.push(`duplicate clickupId "${s.clickupId}" (join-key must be unique)`)
      }
      seenClickupIds.add(s.clickupId)
      if (ctx.knownClickupIds && !ctx.knownClickupIds.has(s.clickupId)) {
        errors.push(`clickupId "${s.clickupId}" not found in known ClickUp tasks`)
      }
    }
  }

  return errors
}

export { ACTIVE_STATUSES, MAX_ACTIVE_STORIES }

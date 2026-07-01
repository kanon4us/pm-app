// lib/design-migration/verify.ts
import type { FigmaInventory, MigrationManifest } from './types'

export interface DriftReport {
  drift: boolean
  missing: string[] // manifest fileKeys absent from fresh inventory
  extra: string[]   // fresh inventory fileKeys absent from manifest
}

export function diffManifestVsInventory(
  manifest: MigrationManifest,
  fresh: FigmaInventory
): DriftReport {
  const manifestKeys = new Set(manifest.files.map((f) => f.sourceFileKey))
  const freshKeys = new Set(fresh.files.map((f) => f.fileKey))

  const missing = [...manifestKeys].filter((k) => !freshKeys.has(k))
  const extra = [...freshKeys].filter((k) => !manifestKeys.has(k))

  return { drift: missing.length > 0 || extra.length > 0, missing, extra }
}

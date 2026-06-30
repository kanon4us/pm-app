// lib/design-migration/types.ts
import type { Feature } from '../design-index/types'

export interface FigmaInventoryFile {
  projectName: string
  fileKey: string
  fileName: string
  fileUrl: string
  pages: { nodeId: string; name: string }[]
  frameCount: number
}

export interface FigmaInventory {
  fetchedAt: string
  files: FigmaInventoryFile[]
}

export type Zone = 'foundations' | 'product' | 'flows' | 'archive'
export type AppKeyOrNull = 'web' | 'cms' | 'mobile' | null

export interface ManifestPage {
  nodeId: string
  name: string
  clickupId: string
  inferredFromPageName: boolean
}

export interface ManifestFile {
  sourceFileKey: string
  sourceFileUrl: string
  zone: Zone
  app: AppKeyOrNull
  targetSection: string | null
  targetFeature: string | null
  codePaths: string[]
  unassigned: boolean
  oversized: boolean
  pages: ManifestPage[]
}

export interface MigrationManifest {
  version: number
  builtAt: string
  files: ManifestFile[]
}

export type PendingReason =
  | 'placeholder-clickup'
  | 'unassigned-codepaths'
  | 'unassigned-feature'

export interface PendingEntry {
  featureId: string
  reason: PendingReason[]
  partial: Partial<Feature>
}

export interface IndexSplit {
  reconciled: Feature[]
  pending: PendingEntry[]
}

/** frameCount above this flags a file for a Phase-4 split. Tunable post-inventory. */
export const OVERSIZED_FRAME_THRESHOLD = 40

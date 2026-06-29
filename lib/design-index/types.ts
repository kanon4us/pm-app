// lib/design-index/types.ts

export type AppKey = 'web' | 'cms' | 'mobile'

export type UserStoryStatus = 'in-design' | 'approved' | 'shipped' | 'archived'

/** A status that counts against the per-file anti-crash page cap. */
export const ACTIVE_STATUSES: ReadonlySet<UserStoryStatus> = new Set([
  'in-design',
  'approved',
])

/** Max ACTIVE user-story pages allowed per feature file (anti-crash rule, spec §5.3). */
export const MAX_ACTIVE_STORIES = 5

export interface UserStory {
  clickupId: string
  title: string
  status: UserStoryStatus
  figmaPageNodeId: string
  sourceOfTruthNodeId: string
  sandboxNodeId: string
  githubIssue?: number
  lastPr?: number
  previewUrl?: string
}

export interface Feature {
  id: string
  app: AppKey
  section: string
  feature: string
  figmaFileKey: string
  figmaFileUrl: string
  codePaths: string[]
  userStories: UserStory[]
}

export interface DesignIndex {
  version: number
  apps: Record<string, { figmaProject: string }>
  features: Feature[]
}

/** Injected facts the pure validator needs from the outside world. */
export interface ValidationContext {
  /** Returns true if a codePaths glob resolves to at least one real path. */
  pathExists: (glob: string) => boolean
  /** Known ClickUp ids; when null the ClickUp join-key check is skipped. */
  knownClickupIds: ReadonlySet<string> | null
}

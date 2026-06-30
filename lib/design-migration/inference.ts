// lib/design-migration/inference.ts
import type { AppKeyOrNull } from './types'

/** Source Figma project/file name → app. Refined during Phase 1 review. */
const WEB_PROJECTS = new Set([
  'Viscap UI', 'ActorHub', 'Actor Hub', 'Performance Hub', 'Perfomance Hub',
  'Creatives', 'Settings', 'Ideation', 'B-Doc', 'Brand Intranet',
  'Phase&Sprints', 'Phase & Sprints', 'Media Library', 'Login / Sign Up',
])
const CMS_PROJECTS = new Set(['CMS', 'CMS Web Application'])
const MOBILE_PROJECTS = new Set(['MVP Mobile App'])
const ARCHIVE_PROJECTS = new Set(['Media Sync Desktop App', 'Desktop'])

export function inferApp(projectName: string, _fileName: string): AppKeyOrNull {
  if (MOBILE_PROJECTS.has(projectName)) return 'mobile'
  if (CMS_PROJECTS.has(projectName)) return 'cms'
  if (ARCHIVE_PROJECTS.has(projectName)) return null
  if (WEB_PROJECTS.has(projectName)) return 'web'
  return null
}

export function inferSectionFeature(name: string): { section: string; feature: string } {
  const sep = name.includes(' — ') ? ' — ' : name.includes(' / ') ? ' / ' : null
  if (!sep) return { section: name.trim(), feature: name.trim() }
  const [section, ...rest] = name.split(sep)
  return { section: section.trim(), feature: rest.join(sep).trim() }
}

/** Section → real repo dirs. Seeded from the current route map; refined in Phase 1. */
const CODE_PATHS_BY_SECTION: Record<string, string[]> = {
  'Performance Hub': ['app/sprint/**'],
  'Phase&Sprints': ['app/sprint/**'],
  'Phase & Sprints': ['app/sprint/**'],
  'Settings': ['app/setup/**', 'lib/field-config.ts'],
  'Ideation': ['app/features/**'],
  'B-Doc': ['app/features/**'],
}

export function inferCodePaths(section: string, _feature: string): string[] {
  return CODE_PATHS_BY_SECTION[section] ?? []
}

const US_PATTERN = /^(US-\d+)/

export function inferClickupId(
  pageName: string,
  featureId: string,
  index: number
): { clickupId: string; inferredFromPageName: boolean } {
  const m = pageName.match(US_PATTERN)
  if (m) return { clickupId: m[1], inferredFromPageName: true }
  return { clickupId: `PENDING-${featureId}-${index}`, inferredFromPageName: false }
}

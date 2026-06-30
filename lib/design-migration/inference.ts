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
  // Normalize manual structural delimiters: the legacy designer used em dash,
  // forward slash, and backslash interchangeably (e.g. "Billing & Usage\Settings").
  const normalized = name.replace(/\\/g, '/').trim()
  const parts = normalized
    .split(/\s*[—/]\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length >= 2) {
    return { section: parts[0], feature: parts.slice(1).join(' / ') }
  }
  return { section: normalized, feature: normalized }
}

/**
 * Project name → repo dirs. Primary anchor for single-area Figma projects whose
 * file names are too noisy to parse a reliable section from.
 */
const CODE_PATHS_BY_PROJECT: Record<string, string[]> = {
  'ActorHub': ['app/actor-hub/**', 'components/actors/**'],
  'Actor Hub': ['app/actor-hub/**', 'components/actors/**'],
  'Creatives': ['app/creatives/**', 'components/creatives/**'],
  'Settings': ['app/settings/**', 'components/settings/**'],
  'Ideation': ['app/features/**'],
  'Performance Hub': ['app/sprint/**'],
  'Perfomance Hub': ['app/sprint/**'], // legacy typo in the real workspace
}

/**
 * Section → repo dirs. Fallback override for the mixed `Viscap UI` monolith,
 * which holds many sections in one project. Refined during Phase 1.
 */
const CODE_PATHS_BY_SECTION: Record<string, string[]> = {
  'Performance Hub': ['app/sprint/**'],
  'Phase&Sprints': ['app/sprint/**'],
  'Phase & Sprints': ['app/sprint/**'],
  'Ideation': ['app/features/**'],
  'B-Doc': ['app/features/**'],
  'Media Library': ['app/media/**', 'components/media/**'],
  'Brand Intranet': ['app/intranet/**', 'components/intranet/**'],
  'Login/Onboarding': ['app/(auth)/**', 'components/auth/**'],
  'Log In': ['app/(auth)/**', 'components/auth/**'],
  'Settings': ['app/settings/**', 'components/settings/**'],
  'Creatives': ['app/creatives/**', 'components/creatives/**'],
}

/**
 * Project name anchors single-area spaces; section lookup is the fallback for
 * mixed monolith files (e.g. inside `Viscap UI`).
 */
export function inferCodePaths(projectName: string, section: string, _feature: string): string[] {
  return CODE_PATHS_BY_PROJECT[projectName] ?? CODE_PATHS_BY_SECTION[section] ?? []
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

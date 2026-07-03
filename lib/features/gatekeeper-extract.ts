// lib/features/gatekeeper-extract.ts
// Pure extraction/mapping utilities for the ClickUp prototyping gatekeeper.
// Kept side-effect free so they are unit-testable; the orchestration (DB,
// ClickUp API) lives in lib/features/gatekeeper.ts.
import { APP_REGISTRY, APP_SLUGS, type AppSlug } from '@/lib/claude/apps'

export interface ClickUpCustomField {
  id?: string
  name?: string
  value?: unknown
}

/** Comma-separated env list → normalized status set (case-insensitive). */
export function parsePrototypeStatuses(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

export function isPrototypeStatus(status: string | undefined, statuses: string[]): boolean {
  return !!status && statuses.includes(status.trim().toLowerCase())
}

/** Tags that flag a task ready for prototyping (taskTagUpdated path). */
export function hasPrototypeTag(tags: string[], configured = 'proto-ready'): boolean {
  const want = configured.trim().toLowerCase()
  return tags.some((t) => t.trim().toLowerCase() === want)
}

/**
 * FVI from the ClickUp custom fields: a field whose name starts with "FVI"
 * (e.g. "FVI", "FVI Score") holding a numeric value or numeric string.
 */
export function extractFviScore(fields: ClickUpCustomField[] | undefined): number | null {
  for (const f of fields ?? []) {
    if (!f.name || !/^fvi\b/i.test(f.name.trim())) continue
    const v = typeof f.value === 'string' ? Number(f.value) : f.value
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return null
}

/**
 * Objectives: prefer an "Objectives"/"Goals" custom field; else pull the
 * section under an Objectives/Goals heading in the task description
 * (markdown `#`-headings, bold pseudo-headings, or "Objectives:" lines),
 * stopping at the next heading of any of those shapes.
 */
export function extractObjectives(
  fields: ClickUpCustomField[] | undefined,
  description: string | null | undefined
): string | null {
  for (const f of fields ?? []) {
    if (!f.name || !/^(objectives?|goals?)\b/i.test(f.name.trim())) continue
    if (typeof f.value === 'string' && f.value.trim()) return f.value.trim()
  }

  if (!description) return null
  const lines = description.split('\n')
  const isHeading = (line: string): string | null => {
    const m =
      line.match(/^#{1,6}\s+(.+?)\s*:?\s*$/) ??
      line.match(/^\*\*(.+?)\*\*\s*:?\s*$/) ??
      line.match(/^([A-Za-z][A-Za-z /&-]{2,40}):\s*$/)
    return m ? m[1].trim() : null
  }

  const start = lines.findIndex((l) => {
    const h = isHeading(l.trim())
    return !!h && /^(objectives?|goals?)$/i.test(h)
  })
  if (start === -1) return null

  const body: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeading(lines[i].trim())) break
    body.push(lines[i])
  }
  const text = body.join('\n').trim()
  return text || null
}

const TAG_APP_ALIASES: Record<string, AppSlug> = {
  'web-app': 'web',
  'education-cms': 'cms',
  cms: 'cms',
  'mobile-app': 'mobile',
  mobile: 'mobile',
  'desktop-app': 'desktop',
  desktop: 'desktop',
}

/**
 * App identity, layered:
 * 1. explicit tag — `app:<slug>`, a bare slug, or a known alias
 * 2. the list's linked repo (repo_registry.github_repo_full_name) matched
 *    against APP_REGISTRY repos
 * 3. default 'web'
 */
export function resolveAppIdentity(input: {
  tags: string[]
  listRepoFullName?: string | null
}): { app: AppSlug; source: 'tag' | 'list-repo' | 'default' } {
  for (const raw of input.tags) {
    const tag = raw.trim().toLowerCase()
    const explicit = tag.startsWith('app:') ? tag.slice(4) : tag
    if ((APP_SLUGS as string[]).includes(explicit)) return { app: explicit as AppSlug, source: 'tag' }
    if (TAG_APP_ALIASES[explicit]) return { app: TAG_APP_ALIASES[explicit], source: 'tag' }
  }

  if (input.listRepoFullName) {
    const repo = input.listRepoFullName.trim().toLowerCase()
    for (const slug of APP_SLUGS) {
      if (APP_REGISTRY[slug].repo.toLowerCase() === repo) return { app: slug, source: 'list-repo' }
    }
  }

  return { app: 'web', source: 'default' }
}

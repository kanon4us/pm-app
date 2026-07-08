// lib/features/gatekeeper-extract.ts
// Pure extraction/mapping utilities for the ClickUp prototyping gatekeeper.
// Kept side-effect free so they are unit-testable; the orchestration (DB,
// ClickUp API) lives in lib/features/gatekeeper.ts.
import { APP_REGISTRY, APP_SLUGS, type AppSlug } from '@/lib/claude/apps'

export interface ClickUpFieldOption {
  id?: string
  orderindex?: number
  name?: string
  label?: string
}

export interface ClickUpLabelOption {
  id?: string
  label?: string
  name?: string
  orderindex?: number
}
export interface ClickUpCustomField {
  id?: string
  name?: string
  value?: unknown
  type?: string
  type_config?: { options?: ClickUpLabelOption[] }
}

export interface FeatureObjective {
  index: number
  name: string
  notes: string
}
export interface ObjectivesJson {
  objectives: FeatureObjective[]
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

/** Display label of a drop_down field's stored value (matched by orderindex OR id). */
function optionLabel(field: ClickUpCustomField): string | null {
  const v = field.value
  if (v === null || v === undefined) return null
  const opt = (field.type_config?.options ?? []).find((o) => o.orderindex === v || o.id === v)
  const label = opt?.label ?? opt?.name
  return label ? label.trim() : null
}

const FIGMA_HOST = 'figma.com'

/**
 * Prototype-ready by custom fields: SOME field named "Design states" resolves to
 * the option label "In progress" AND a "Figma" field holds a figma.com link.
 * Resolve each drop_down's value to its own option label — never compare the raw
 * numeric value, which means different things across duplicate fields.
 */
export function isPrototypeReady(fields: ClickUpCustomField[] | undefined): boolean {
  const list = fields ?? []
  const designReady = list.some(
    (f) => f.name?.trim().toLowerCase() === 'design states' &&
      optionLabel(f)?.toLowerCase() === 'in progress'
  )
  if (!designReady) return false
  return list.some(
    (f) => f.name?.trim().toLowerCase() === 'figma' &&
      typeof f.value === 'string' && f.value.toLowerCase().includes(FIGMA_HOST)
  )
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

/**
 * Objectives as strict JSON for the UX pipeline. Reads the `Obj #1…#7 Notes`
 * text fields, pairing each with the strategic-objective NAME defined by the
 * `Objectives` labels field's option at `orderindex N-1` (verified positional
 * mapping). Scores / ObjTotal / Approved are prioritization signal and dropped.
 * Returns null when no objective carries notes.
 */
export function extractObjectivesJson(
  fields: ClickUpCustomField[] | undefined
): ObjectivesJson | null {
  const list = fields ?? []

  const objectivesField = list.find((f) => f.name?.trim().toLowerCase() === 'objectives')
  const labelByOrder = new Map<number, string>()
  for (const opt of objectivesField?.type_config?.options ?? []) {
    if (typeof opt.orderindex === 'number') {
      labelByOrder.set(opt.orderindex, (opt.label ?? opt.name ?? '').trim())
    }
  }

  const objectives: FeatureObjective[] = []
  for (let n = 1; n <= 7; n++) {
    const noteField = list.find((f) => new RegExp(`^Obj #${n} Notes$`, 'i').test(f.name?.trim() ?? ''))
    const notes = typeof noteField?.value === 'string' ? noteField.value.trim() : ''
    if (!notes) continue
    objectives.push({ index: n, name: labelByOrder.get(n - 1) ?? '', notes })
  }

  return objectives.length ? { objectives } : null
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

// "Relevant App" label options → app slug. Mac/Win → desktop is retained but
// desktop is slated for retirement (web + mobile are the near-term apps).
const RELEVANT_APP_LABEL_TO_SLUG: Record<string, AppSlug> = {
  web: 'web',
  ios: 'mobile',
  android: 'mobile',
  mac: 'desktop',
  win: 'desktop',
}

function relevantAppFromFields(fields: ClickUpCustomField[] | undefined): AppSlug | null {
  const field = (fields ?? []).find((f) => f.name?.trim().toLowerCase() === 'relevant app')
  if (!field) return null
  const raw = field.value
  const ids = Array.isArray(raw) ? raw : raw != null ? [raw] : []
  const opts = field.type_config?.options ?? []
  for (const id of ids) {
    const opt = opts.find((o) => o.id === id || o.orderindex === id)
    const label = (opt?.label ?? opt?.name)?.trim().toLowerCase()
    if (label && RELEVANT_APP_LABEL_TO_SLUG[label]) return RELEVANT_APP_LABEL_TO_SLUG[label]
  }
  return null
}

/**
 * App identity, layered:
 * 1. `Relevant App` custom field (labels) — resolved via its own options
 * 2. explicit tag — `app:<slug>`, a bare slug, or a known alias
 * 3. the list's linked repo (repo_registry.github_repo_full_name) matched
 *    against APP_REGISTRY repos
 * 4. default 'web'
 */
export function resolveAppIdentity(input: {
  tags: string[]
  listRepoFullName?: string | null
  fields?: ClickUpCustomField[]
}): { app: AppSlug; source: 'relevant-app' | 'tag' | 'list-repo' | 'default' } {
  const relevant = relevantAppFromFields(input.fields)
  if (relevant) return { app: relevant, source: 'relevant-app' }

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

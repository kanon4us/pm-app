// lib/design-index/inbox-trigger.ts

export function parseDesignIndexStatuses(env: string | undefined): string[] {
  if (!env) return []
  return env.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
}

export function isDesignIndexStatus(status: string, configured: string[]): boolean {
  return configured.includes(status.trim().toLowerCase())
}

interface CustomField {
  name?: string
  value?: unknown
}

/** Pulls the Figma URL from a ClickUp task's custom fields (the "Figma Link" field). */
export function extractFigmaUrl(fields: CustomField[] | undefined): string | null {
  if (!fields) return null
  const field = fields.find((f) => (f.name ?? '').toLowerCase().includes('figma'))
  const value = field?.value
  return typeof value === 'string' && value.length > 0 ? value : null
}

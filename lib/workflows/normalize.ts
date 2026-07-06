// lib/workflows/normalize.ts

/** Canonical form for case-insensitive workflow-name comparison. */
export function normalizeWorkflowName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Escape a value so it matches literally inside a Postgres LIKE/ILIKE pattern.
 * Backslash is the default escape char, so escape it first, then the wildcards.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1')
}

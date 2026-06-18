// lib/vault/author-routing.ts
// Pure function: resolve the routing key and Slack ID for a vault doc author.
// No I/O — fully unit-testable.

import type { VaultDoc } from '@/lib/vault/types'

export interface AuthorRoute {
  /** The email-like key used to identify the author (owner frontmatter or committer email). */
  key: string
  /** The Slack user ID to DM. */
  slackId: string
}

/**
 * Resolve the author route for a vault doc.
 *
 * Key precedence:
 *   1. `doc.frontmatter.owner` (if non-empty)
 *   2. `doc.lastCommitterEmail`
 *
 * Slack ID precedence:
 *   1. `slackMap[key]`
 *   2. `slackMap[doc.lastCommitterEmail]`  (when key ≠ committer and key not in map)
 *   3. `pmFallbackSlackId`
 */
export function resolveAuthor(
  doc: VaultDoc,
  slackMap: Record<string, string>,
  pmFallbackSlackId: string,
): AuthorRoute {
  const key = doc.frontmatter.owner?.trim() || doc.lastCommitterEmail

  const slackId =
    slackMap[key] ??
    slackMap[doc.lastCommitterEmail] ??
    pmFallbackSlackId

  return { key, slackId }
}

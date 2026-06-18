// lib/vault/closeout-body.ts

export interface CloseoutItem {
  authorKey: string
  docPath: string
  action: string
  answered: boolean
  audience?: string
}

/**
 * Returns the subset of items that are unanswered AND have audience 'support'.
 * Used by the cron to ping the PM about stale support risks.
 */
export function staleSupportItems(items: CloseoutItem[]): CloseoutItem[] {
  return items.filter(item => !item.answered && item.audience === 'support')
}

/**
 * Builds the consolidated weekly PR body.
 *
 * Structure:
 *   1. (optional) "## ⚠ Stale Support Risks" block — only when unanswered support items exist
 *   2. Per-author sections (### <authorKey>) for answered items, sorted alphabetically
 *
 * Returns "_No changes this cycle._" when neither block would render content.
 */
export function buildPrBody(items: CloseoutItem[]): string {
  const stale = staleSupportItems(items)
  const answered = items.filter(item => item.answered)

  const hasStale = stale.length > 0
  const hasAnswered = answered.length > 0

  if (!hasStale && !hasAnswered) {
    return '_No changes this cycle._'
  }

  const parts: string[] = []

  // Block 1: Stale Support Risks
  if (hasStale) {
    const riskLines = stale
      .map(item => `- \`${item.docPath}\` (owner: ${item.authorKey})`)
      .join('\n')

    parts.push(
      [
        '## ⚠ Stale Support Risks',
        '',
        'These support docs went unanswered this cycle and may give wrong answers on live tickets:',
        riskLines,
        '',
        '---',
      ].join('\n'),
    )
  }

  // Block 2: Per-author sections for answered items
  if (hasAnswered) {
    // Group by author, preserving input order within each group
    const authorMap = new Map<string, CloseoutItem[]>()
    for (const item of answered) {
      const existing = authorMap.get(item.authorKey)
      if (existing) {
        existing.push(item)
      } else {
        authorMap.set(item.authorKey, [item])
      }
    }

    // Sort authors alphabetically
    const sortedAuthors = [...authorMap.keys()].sort()

    const authorSections = sortedAuthors.map(author => {
      const docLines = authorMap.get(author)!
        .map(item => `- \`${item.docPath}\` — ${item.action}`)
        .join('\n')
      return `### ${author}\n${docLines}`
    })

    parts.push(authorSections.join('\n\n'))
  }

  return parts.join('\n')
}

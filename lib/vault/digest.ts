// Minimal local type — mirrors the one in blockkit.ts; no @slack/* packages in this project
type KnownBlock = Record<string, unknown>

// Slack block limit: a message may contain at most 50 blocks.
// We cap the rendered doc list at 25 to leave headroom for surrounding context
// (header, dividers, call-to-action blocks, etc.).
const MAX_DOC_BLOCKS = 25

/**
 * Builds a Slack Block Kit payload for the weekly vault review digest.
 *
 * Structure:
 *   - One `section` header: "N docs need review"
 *   - One `section` per doc (capped at MAX_DOC_BLOCKS = 25), each with a
 *     `button` accessory labelled "Review" whose action_id is `vault_review_open`
 *     and whose value is the doc's blockId (used to look up the doc when the
 *     button is clicked and a modal is opened).
 *   - If there are more than MAX_DOC_BLOCKS docs, a trailing `section` notes
 *     how many additional docs were omitted.
 */
export function buildDigestCard(
  docs: Array<{ path: string; blockId: string }>,
): KnownBlock[] {
  const totalCount = docs.length
  const rendered = docs.slice(0, MAX_DOC_BLOCKS)
  const overflow = totalCount - rendered.length

  const headerBlock: KnownBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${totalCount} doc${totalCount === 1 ? '' : 's'} need review*`,
    },
  }

  const docBlocks: KnownBlock[] = rendered.map((doc) => ({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: doc.path,
    },
    accessory: {
      type: 'button',
      text: {
        type: 'plain_text',
        text: 'Review',
        emoji: false,
      },
      action_id: 'vault_review_open',
      value: doc.blockId,
    },
  }))

  const blocks: KnownBlock[] = [headerBlock, ...docBlocks]

  if (overflow > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `_…and ${overflow} more doc${overflow === 1 ? '' : 's'} not shown. Open the vault to review all._`,
      },
    })
  }

  return blocks
}

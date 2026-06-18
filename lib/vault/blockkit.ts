// Minimal local type — no @slack/* packages in this project
type KnownBlock = Record<string, unknown>

export interface CardAction {
  id: string
  label: string
}

// Slack Block Kit limits:
//   section text (mrkdwn): 3000 chars max
//   button text:            75 chars max
//   actions elements:       25 max
const SECTION_TEXT_MAX = 3000
const BUTTON_LABEL_MAX = 75
const ELLIPSIS = '…'

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  // Trim to (max - 1) to leave room for the ellipsis character (1 char)
  return text.slice(0, max - 1) + ELLIPSIS
}

/**
 * Builds a two-block Slack Block Kit payload for a vault review question:
 *   1. A `section` block with mrkdwn text (doc path header + body).
 *   2. An `actions` block whose block_id is `args.blockId`, containing one
 *      `button` per action.
 *
 * All text values are truncated to Slack's published limits deterministically.
 */
export function buildQuestionCard(args: {
  docPath: string
  bodyText: string
  actions: CardAction[]
  blockId: string
}): KnownBlock[] {
  const { docPath, bodyText, actions, blockId } = args

  // Combine path header and body into a single mrkdwn string, then truncate.
  const rawText = `*${docPath}*\n${bodyText}`
  const sectionText = truncate(rawText, SECTION_TEXT_MAX)

  const sectionBlock: KnownBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: sectionText,
    },
  }

  const elements = actions.map((action) => ({
    type: 'button',
    text: {
      type: 'plain_text',
      text: truncate(action.label, BUTTON_LABEL_MAX),
      emoji: false,
    },
    action_id: action.id,
    value: action.id,
  }))

  const actionsBlock: KnownBlock = {
    type: 'actions',
    block_id: blockId,
    elements,
  }

  return [sectionBlock, actionsBlock]
}

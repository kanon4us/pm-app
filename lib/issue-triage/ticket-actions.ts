// Pure helpers for the in-thread ticket controls (Assign to me / Status).
// No Slack/ClickUp/DB I/O so they can be unit-tested.

export const ASSIGN_ACTION_ID = 'ticket_assign_me'
export const STATUS_ACTION_ID = 'ticket_set_status'

// The ClickUp list's exact statuses, in board order.
// TODO: fetch dynamically from the ClickUp List API so this can't drift.
export const CLICKUP_STATUSES = [
  'BACKLOG',
  'NEW ISSUE',
  'FEATURE PLANNING',
  'OBJECTIVE PLANNING',
  'UI/UX',
  'READY FOR UI/UX REVIEW',
  'DEV ARCHITECTURE',
  'READY FOR DEV',
  'DEV IMPL',
  'CODE REVIEW',
  'READY FOR QA',
  'QA IN PROGRESS',
  'QA APPROVED',
  'SENT TO STAGING',
  'DONE',
  'DEPLOYED',
  'ARCHIVE',
] as const

type Block = { type: string; [k: string]: unknown }

/** Map a dev's ClickUp email to their ClickUp user id (case/space-insensitive). */
export function resolveClickUpUserId(
  members: Array<{ id: number; email: string }>,
  email: string | null,
): number | null {
  if (!email) return null
  const norm = (e: string) => e.toLowerCase().trim()
  const target = norm(email)
  return members.find((m) => norm(m.email) === target)?.id ?? null
}

function statusSelect(initial?: string): Block {
  const opt = (s: string) => ({ text: { type: 'plain_text', text: s }, value: s })
  return {
    type: 'static_select',
    action_id: STATUS_ACTION_ID,
    placeholder: { type: 'plain_text', text: 'Set status' },
    options: CLICKUP_STATUSES.map(opt),
    ...(initial && (CLICKUP_STATUSES as readonly string[]).includes(initial) ? { initial_option: opt(initial) } : {}),
  }
}

/** The actions block with the Assign button (optional) and the Status dropdown. */
export function ticketControlsBlock(opts: { includeAssign: boolean; status?: string }): Block {
  const elements: Block[] = []
  if (opts.includeAssign) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Assign to me' },
      style: 'primary',
      action_id: ASSIGN_ACTION_ID,
    })
  }
  elements.push(statusSelect(opts.status))
  return { type: 'actions', elements }
}

/** Whether a message's blocks currently include the Assign-to-me button. */
export function hasAssignButton(blocks: Block[]): boolean {
  return blocks.some((b) => {
    if (b.type !== 'actions') return false
    const els = (b as { elements?: Array<{ action_id?: string }> }).elements
    return Array.isArray(els) && els.some((e) => e.action_id === ASSIGN_ACTION_ID)
  })
}

/**
 * Rebuild a ticket message's blocks after an action: keep the section(s), refresh
 * the controls (drop the Assign button once claimed; reflect the chosen status),
 * and append an optional context note.
 */
export function rebuildTicketBlocks(
  originalBlocks: Block[],
  opts: { keepAssign: boolean; status?: string; note?: string },
): Block[] {
  const sections = (originalBlocks ?? []).filter((b) => b.type === 'section')
  const blocks: Block[] = [...sections, ticketControlsBlock({ includeAssign: opts.keepAssign, status: opts.status })]
  if (opts.note) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: opts.note }] })
  return blocks
}

import {
  resolveClickUpUserId,
  ticketControlsBlock,
  rebuildTicketBlocks,
  hasAssignButton,
  ASSIGN_ACTION_ID,
  STATUS_ACTION_ID,
  CLICKUP_STATUSES,
} from '../../../lib/issue-triage/ticket-actions'

describe('resolveClickUpUserId', () => {
  const members = [
    { id: 1, email: 'Chad@ViscapMedia.com' },
    { id: 2, email: 'ali@viscapmedia.com' },
  ]
  it('matches case- and space-insensitively', () => {
    expect(resolveClickUpUserId(members, '  chad@viscapmedia.com ')).toBe(1)
    expect(resolveClickUpUserId(members, 'ALI@VISCAPMEDIA.COM')).toBe(2)
  })
  it('returns null for unknown or empty email', () => {
    expect(resolveClickUpUserId(members, 'nobody@x.com')).toBeNull()
    expect(resolveClickUpUserId(members, null)).toBeNull()
  })
})

describe('ticketControlsBlock', () => {
  it('includes the assign button + status select with all 17 statuses', () => {
    const b = ticketControlsBlock({ includeAssign: true }) as unknown as { elements: Array<Record<string, unknown>> }
    const ids = b.elements.map((e) => e.action_id)
    expect(ids).toContain(ASSIGN_ACTION_ID)
    expect(ids).toContain(STATUS_ACTION_ID)
    const select = b.elements.find((e) => e.action_id === STATUS_ACTION_ID) as { options: unknown[] }
    expect(select.options).toHaveLength(CLICKUP_STATUSES.length)
  })
  it('omits the assign button when includeAssign is false and sets initial status', () => {
    const b = ticketControlsBlock({ includeAssign: false, status: 'DEV IMPL' }) as unknown as { elements: Array<Record<string, unknown>> }
    expect(b.elements.map((e) => e.action_id)).not.toContain(ASSIGN_ACTION_ID)
    const select = b.elements.find((e) => e.action_id === STATUS_ACTION_ID) as { initial_option?: { value: string } }
    expect(select.initial_option?.value).toBe('DEV IMPL')
  })
})

describe('rebuildTicketBlocks + hasAssignButton', () => {
  const original = [
    { type: 'section', text: { type: 'mrkdwn', text: 'Ticket: login broken' } },
    ticketControlsBlock({ includeAssign: true }),
  ]
  it('detects the assign button', () => {
    expect(hasAssignButton(original)).toBe(true)
  })
  it('keeps the section, drops the assign button on claim, adds a note', () => {
    const out = rebuildTicketBlocks(original, { keepAssign: false, note: 'Assigned to <@U1>' })
    expect(out[0].type).toBe('section')
    expect(hasAssignButton(out)).toBe(false)
    expect(out.some((b) => b.type === 'context')).toBe(true)
  })
  it('keeps the assign button and reflects status on a status change', () => {
    const out = rebuildTicketBlocks(original, { keepAssign: true, status: 'CODE REVIEW' })
    expect(hasAssignButton(out)).toBe(true)
    const select = (out.find((b) => b.type === 'actions') as unknown as { elements: Array<{ action_id?: string; initial_option?: { value: string } }> })
      .elements.find((e) => e.action_id === STATUS_ACTION_ID)
    expect(select?.initial_option?.value).toBe('CODE REVIEW')
  })
})

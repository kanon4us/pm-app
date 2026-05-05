import { createTicket, updateTicketDescription, appendToParentTicket, notifyUrgencyCollision } from '@/lib/issue-triage/router'
import { EMPTY_TICKET_DATA } from '@/lib/issue-triage/types'
import type { SlackIssue } from '@/lib/issue-triage/types'

process.env.CLICKUP_BOT_TOKEN = 'test-cu-token'
process.env.SLACK_BOT_TOKEN = 'xoxb-test'
process.env.CLICKUP_NEW_TICKETS_LIST_ID = 'list-new'
process.env.SLACK_BOT_IMPROVEMENTS_CHANNEL_ID = 'C_IMPROVEMENTS'
process.env.SLACK_WORKSPACE_URL = 'https://viscapvids.slack.com'

const mockCu = {
  createTask: jest.fn(),
  updateTask: jest.fn(),
  createTaskComment: jest.fn(),
  setTaskPriority: jest.fn(),
}

const mockSlack = {
  postMessage: jest.fn(),
}

jest.mock('@/lib/clickup/client', () => ({
  buildClickUpClient: jest.fn(() => mockCu),
}))

jest.mock('@/lib/slack/client', () => ({
  buildSlackClient: jest.fn(() => mockSlack),
}))

function makeIssue(overrides: Partial<SlackIssue> = {}): SlackIssue {
  return {
    thread_ts: '1234567890.000001',
    channel_id: 'C_ISSUES',
    reporter_id: 'U_REPORTER',
    status: 'gathering',
    ticket_data: { ...EMPTY_TICKET_DATA, issue_summary: 'CMS crash on save' },
    metadata: { logrocket_links: [], file_ids: [], vault_snippets_used: [], triage_reasoning: '' },
    handoff_status: null,
    clickup_task_id: null,
    sop_version: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_msg_ts: null,
    ...overrides,
  }
}

describe('createTicket', () => {
  beforeEach(() => jest.clearAllMocks())

  it('creates a task in the New Tickets list and returns id + url', async () => {
    mockCu.createTask.mockResolvedValue({ id: 'cu-123', url: 'https://app.clickup.com/t/cu-123' })

    const result = await createTicket(makeIssue())

    expect(mockCu.createTask).toHaveBeenCalledWith(
      'list-new',
      expect.objectContaining({ name: 'CMS crash on save', priority: 3 }),
    )
    expect(result).toEqual({ id: 'cu-123', url: 'https://app.clickup.com/t/cu-123' })
  })

  it('includes a visual summary in the description when provided', async () => {
    mockCu.createTask.mockResolvedValue({ id: 'cu-img', url: 'https://app.clickup.com/t/cu-img' })

    await createTicket(makeIssue(), 'User clicking Export — progress bar stuck at 0%')

    expect(mockCu.createTask).toHaveBeenCalledWith(
      'list-new',
      expect.objectContaining({
        description: expect.stringContaining('**Visual summary:** User clicking Export'),
      }),
    )
  })
})

describe('updateTicketDescription', () => {
  beforeEach(() => jest.clearAllMocks())

  it('calls updateTask with the rebuilt description', async () => {
    mockCu.updateTask.mockResolvedValue(undefined)

    await updateTicketDescription('cu-123', makeIssue())

    expect(mockCu.updateTask).toHaveBeenCalledWith(
      'cu-123',
      expect.objectContaining({ description: expect.any(String) }),
    )
  })
})

describe('appendToParentTicket', () => {
  beforeEach(() => jest.clearAllMocks())

  it('creates a comment on the parent task with thread link and reporter', async () => {
    mockCu.createTaskComment.mockResolvedValue(undefined)

    await appendToParentTicket('cu-parent', makeIssue(), 'Additional context here')

    expect(mockCu.createTaskComment).toHaveBeenCalledWith(
      'cu-parent',
      expect.stringContaining('Related report via Slack'),
    )
  })
})

describe('notifyUrgencyCollision', () => {
  beforeEach(() => jest.clearAllMocks())

  it('sets task to Urgent and posts in #bot-improvements', async () => {
    mockCu.setTaskPriority.mockResolvedValue(undefined)
    mockSlack.postMessage.mockResolvedValue('ts')

    await notifyUrgencyCollision('cu-parent', 'https://app.clickup.com/t/cu-parent', 3)

    expect(mockCu.setTaskPriority).toHaveBeenCalledWith('cu-parent', 1)
    expect(mockSlack.postMessage).toHaveBeenCalledWith(
      'C_IMPROVEMENTS',
      expect.stringContaining('3 reports'),
    )
  })
})

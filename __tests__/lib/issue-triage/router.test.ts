import { routeTicket } from '@/lib/issue-triage/router'
import { EMPTY_TICKET_DATA } from '@/lib/issue-triage/types'
import type { SlackIssue, TriageClaudeResponse } from '@/lib/issue-triage/types'

process.env.CLICKUP_BOT_TOKEN = 'test-cu-token'
process.env.SLACK_BOT_TOKEN = 'xoxb-test'
process.env.SLACK_MICHAEL_USER_ID = 'U_MICHAEL'
process.env.CLICKUP_NEW_TICKETS_LIST_ID = 'list-new'
process.env.CLICKUP_KNOWN_ISSUES_LIST_ID = 'list-known'
process.env.CLICKUP_NEEDS_TUTORIAL_LIST_ID = 'list-tutorial'
process.env.CLICKUP_PLANNING_LIST_ID = 'list-planning'

const mockCu = {
  createTask: jest.fn(),
  moveTask: jest.fn(),
  setTaskPriority: jest.fn(),
  getTask: jest.fn(),
  createTaskComment: jest.fn(),
}

const mockSlack = {
  postMessage: jest.fn(),
  openDM: jest.fn(),
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
    status: 'triaging',
    ticket_data: { ...EMPTY_TICKET_DATA, issue_summary: 'CMS crash on save' },
    metadata: { logrocket_links: [], file_ids: [], vault_snippets_used: [], triage_reasoning: '' },
    human_takeover: false,
    clickup_task_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_msg_ts: null,
    ...overrides,
  }
}

function makeTriageResponse(overrides: Partial<TriageClaudeResponse> = {}): TriageClaudeResponse {
  return {
    duplicate_task_id: null,
    duplicate_confidence: 0,
    workaround_found: false,
    workaround_text: null,
    has_user_facing_docs: false,
    documentation_gap: false,
    routing_decision: 'escalate_to_michael',
    routing_reasoning: 'No related issues, no workaround',
    ...overrides,
  }
}

describe('routeTicket', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCu.createTask.mockResolvedValue({ id: 'cu-new', url: 'https://app.clickup.com/t/cu-new' })
    mockCu.moveTask.mockResolvedValue(undefined)
    mockCu.setTaskPriority.mockResolvedValue(undefined)
    mockCu.getTask.mockResolvedValue({
      id: 'cu-old',
      name: 'CMS crash',
      description: null,
      status: { status: 'open' },
      priority: { id: '3', priority: 'normal' },
      url: 'https://app.clickup.com/t/cu-old',
      custom_fields: [],
      list: { id: 'list-new', name: 'New Tickets' },
    })
    mockCu.createTaskComment.mockResolvedValue({ id: 'comment-1' })
    mockSlack.postMessage.mockResolvedValue('1234567890.999')
    mockSlack.openDM.mockResolvedValue('D_MICHAEL')
  })

  it('creates a new ticket in New Tickets and DMs Michael for escalate_to_michael', async () => {
    const issue = makeIssue()
    const triage = makeTriageResponse({ routing_decision: 'escalate_to_michael' })

    await routeTicket(issue, triage)

    expect(mockCu.createTask).toHaveBeenCalledWith('list-new', expect.objectContaining({ priority: 2 }))
    expect(mockSlack.openDM).toHaveBeenCalledWith('U_MICHAEL')
    expect(mockSlack.postMessage).toHaveBeenCalledWith('D_MICHAEL', expect.stringContaining('cu-new'))
  })

  it('creates ticket in Needs Tutorial for needs_tutorial routing', async () => {
    const issue = makeIssue()
    const triage = makeTriageResponse({
      routing_decision: 'needs_tutorial',
      workaround_found: true,
      workaround_text: 'Use Ctrl+S instead',
    })

    await routeTicket(issue, triage)

    expect(mockCu.createTask).toHaveBeenCalledWith('list-tutorial', expect.objectContaining({ name: expect.any(String) }))
    expect(mockSlack.postMessage).toHaveBeenCalledWith(
      'C_ISSUES',
      expect.stringContaining('Ctrl+S'),
      '1234567890.000001'
    )
  })

  it('bumps priority and comments on existing ticket for known_issues routing', async () => {
    const issue = makeIssue()
    const triage = makeTriageResponse({
      routing_decision: 'known_issues',
      duplicate_task_id: 'cu-old',
      duplicate_confidence: 0.95,
    })

    await routeTicket(issue, triage)

    // Priority bumped from normal(3) → high(2)
    expect(mockCu.setTaskPriority).toHaveBeenCalledWith('cu-old', 2)
    // Comment added to old ticket
    expect(mockCu.createTaskComment).toHaveBeenCalledWith('cu-old', expect.any(String))
    // No new ticket created
    expect(mockCu.createTask).not.toHaveBeenCalled()
  })

  it('moves ticket to Planning when priority bump lands on high', async () => {
    // Existing task is at normal(3); bump → high(2) → move to Planning
    const issue = makeIssue()
    const triage = makeTriageResponse({
      routing_decision: 'known_issues',
      duplicate_task_id: 'cu-old',
      duplicate_confidence: 0.9,
    })

    await routeTicket(issue, triage)

    expect(mockCu.setTaskPriority).toHaveBeenCalledWith('cu-old', 2)
    expect(mockCu.moveTask).toHaveBeenCalledWith('cu-old', 'list-planning')
  })
})

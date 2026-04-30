import { detectDuplicate } from '@/lib/issue-triage/duplicate-detection'
import { EMPTY_TICKET_DATA } from '@/lib/issue-triage/types'

process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.CLICKUP_BOT_TOKEN = 'test-cu-token'
process.env.CLICKUP_NEW_TICKETS_LIST_ID = 'list-new'
process.env.CLICKUP_KNOWN_ISSUES_LIST_ID = 'list-known'
process.env.CLICKUP_NEEDS_TUTORIAL_LIST_ID = 'list-tutorial'
process.env.CLICKUP_PLANNING_LIST_ID = 'list-planning'

// Mock ClickUp client to return empty task list by default
jest.mock('@/lib/clickup/client', () => ({
  buildClickUpClient: jest.fn().mockReturnValue({
    getTasks: jest.fn().mockResolvedValue([]),
  }),
}))

// Mock Anthropic SDK
const mockCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}))

describe('detectDuplicate', () => {
  beforeEach(() => {
    mockCreate.mockReset()
    const { buildClickUpClient } = require('@/lib/clickup/client')
    buildClickUpClient().getTasks.mockReset()
    buildClickUpClient().getTasks.mockResolvedValue([])
  })

  it('returns duplicate_task_id when confidence >= 0.85', async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          duplicate_task_id: 'cu-task-999',
          duplicate_confidence: 0.92,
          workaround_found: false,
          workaround_text: null,
          has_user_facing_docs: false,
          documentation_gap: false,
          routing_decision: 'known_issues',
          routing_reasoning: 'Same CMS crash on save reported last week',
        }),
      }],
    })

    const result = await detectDuplicate({ ...EMPTY_TICKET_DATA, issue_summary: 'CMS crash' })
    expect(result.duplicate_task_id).toBe('cu-task-999')
    expect(result.duplicate_confidence).toBe(0.92)
  })

  it('returns null duplicate_task_id when confidence < 0.85', async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          duplicate_task_id: null,
          duplicate_confidence: 0.4,
          workaround_found: false,
          workaround_text: null,
          has_user_facing_docs: false,
          documentation_gap: false,
          routing_decision: 'escalate_to_michael',
          routing_reasoning: 'No similar issues found',
        }),
      }],
    })

    const result = await detectDuplicate({ ...EMPTY_TICKET_DATA, issue_summary: 'New bug' })
    expect(result.duplicate_task_id).toBeNull()
  })

  it('fetches tasks from all four ClickUp lists', async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          duplicate_task_id: null,
          duplicate_confidence: 0,
          workaround_found: false,
          workaround_text: null,
          has_user_facing_docs: false,
          documentation_gap: false,
          routing_decision: 'escalate_to_michael',
          routing_reasoning: 'No match',
        }),
      }],
    })

    const { buildClickUpClient } = require('@/lib/clickup/client')
    const mockGetTasks = buildClickUpClient().getTasks

    await detectDuplicate({ ...EMPTY_TICKET_DATA })
    expect(mockGetTasks).toHaveBeenCalledTimes(4)
  })
})

import { detectDuplicate } from '@/lib/issue-triage/duplicate-detection'
import { EMPTY_TICKET_DATA } from '@/lib/issue-triage/types'

process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.CLICKUP_BOT_TOKEN = 'test-cu-token'
process.env.CLICKUP_NEW_TICKETS_LIST_ID = 'list-new'
process.env.CLICKUP_KNOWN_ISSUES_LIST_ID = 'list-known'
process.env.CLICKUP_NEEDS_TUTORIAL_LIST_ID = 'list-tutorial'
process.env.CLICKUP_PLANNING_LIST_ID = 'list-planning'

// Mock ClickUp client — getTasks is captured at module level for direct reset in beforeEach.
// Uses var so JS hoisting makes it writable before the jest.mock factory executes.
// eslint-disable-next-line no-var
var mockGetTasks: jest.Mock
jest.mock('@/lib/clickup/client', () => {
  const getTasks = jest.fn().mockResolvedValue([])
  mockGetTasks = getTasks
  return {
    buildClickUpClient: jest.fn().mockReturnValue({ getTasks }),
  }
})

// Mock SOP loader — inlined to avoid hoisting issues
jest.mock('@/lib/issue-triage/sop', () => ({
  getActiveSop: jest.fn().mockResolvedValue({
    version: 1,
    duplicate_thresholds: { possible: 0.60, confirmed: 0.85, collisionWindowHours: 24, collisionCount: 3 },
    escalation_rules: { maxTurns: 8, disengagementThreshold: 2, minConfidenceMovementPerTurn: 0.05 },
    intake_prompt: '',
    manual_directives: [],
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
    mockGetTasks.mockReset()
    mockGetTasks.mockResolvedValue([])
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

    await detectDuplicate({ ...EMPTY_TICKET_DATA })
    expect(mockGetTasks).toHaveBeenCalledTimes(4)
  })

  it('handles Claude returning JSON wrapped in markdown fences', async () => {
    const payload = {
      duplicate_task_id: null,
      duplicate_confidence: 0.3,
      workaround_found: false,
      workaround_text: null,
      has_user_facing_docs: false,
      documentation_gap: false,
      routing_decision: 'escalate_to_michael' as const,
      routing_reasoning: 'No similar issues found',
    }
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '```json\n' + JSON.stringify(payload) + '\n```' }],
    })
    const result = await detectDuplicate({ ...EMPTY_TICKET_DATA })
    expect(result.duplicate_task_id).toBeNull()
    expect(result.routing_decision).toBe('escalate_to_michael')
  })

  it('throws when Claude returns non-parseable output', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Sorry, I cannot help with that.' }],
    })
    await expect(detectDuplicate({ ...EMPTY_TICKET_DATA })).rejects.toThrow(
      'Triage Claude returned non-JSON output'
    )
  })
})

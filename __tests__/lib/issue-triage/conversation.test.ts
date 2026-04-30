import { runIntakeTurn } from '@/lib/issue-triage/conversation'
import type { SlackIssue } from '@/lib/issue-triage/types'
import { EMPTY_TICKET_DATA } from '@/lib/issue-triage/types'

const ANTHROPIC_KEY = 'test-key'
process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY

const mockCreate = jest.fn()

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: {
      create: mockCreate,
    },
  })),
}))

function makeIssue(overrides: Partial<SlackIssue> = {}): SlackIssue {
  return {
    thread_ts: '1234567890.000001',
    channel_id: 'C_ISSUES',
    reporter_id: 'U_REPORTER',
    status: 'gathering',
    ticket_data: { ...EMPTY_TICKET_DATA },
    metadata: { logrocket_links: [], file_ids: [], vault_snippets_used: [], triage_reasoning: '' },
    human_takeover: false,
    clickup_task_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_msg_ts: null,
    ...overrides,
  }
}

describe('runIntakeTurn', () => {
  beforeEach(() => {
    mockCreate.mockReset()
  })

  it('returns updated_schema, bot_response, and confidence from Claude', async () => {
    const claudeOutput = {
      updated_schema: { ...EMPTY_TICKET_DATA, issue_summary: 'CMS crash on save' },
      bot_response: 'Got it. Are you completely blocked right now?',
      confidence: 0.2,
    }
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(claudeOutput) }],
    })

    const issue = makeIssue()
    const history = [{ user: 'U_REPORTER', text: 'CMS is crashing', ts: '1234567890.000001' }]
    const result = await runIntakeTurn(issue, 'CMS is crashing', history)

    expect(result.bot_response).toBe('Got it. Are you completely blocked right now?')
    expect(result.confidence).toBe(0.2)
    expect(result.updated_schema.issue_summary).toBe('CMS crash on save')
  })

  it('handles Claude returning JSON wrapped in markdown fences', async () => {
    const claudeOutput = {
      updated_schema: { ...EMPTY_TICKET_DATA },
      bot_response: 'What platform?',
      confidence: 0.1,
    }
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '```json\n' + JSON.stringify(claudeOutput) + '\n```' }],
    })

    const result = await runIntakeTurn(makeIssue(), 'hi', [])
    expect(result.bot_response).toBe('What platform?')
  })

  it('throws when Claude output cannot be parsed', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Sorry I cannot help with that.' }],
    })

    await expect(runIntakeTurn(makeIssue(), 'hi', [])).rejects.toThrow('Intake Claude returned non-JSON')
  })
})

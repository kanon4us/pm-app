import { searchForWorkaround } from '@/lib/issue-triage/workaround-search'
import { EMPTY_TICKET_DATA } from '@/lib/issue-triage/types'

process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.GITHUB_TOKEN = 'test-gh-token'

var mockSearchVault: jest.Mock
jest.mock('@/lib/github/vault', () => {
  mockSearchVault = jest.fn()
  return {
    searchVault: (...args: unknown[]) => mockSearchVault(...args),
  }
})

var mockCreate: jest.Mock
jest.mock('@anthropic-ai/sdk', () => {
  mockCreate = jest.fn()
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: { create: mockCreate },
    })),
  }
})

describe('searchForWorkaround', () => {
  beforeEach(() => {
    mockCreate.mockReset()
    mockSearchVault.mockReset()
  })

  it('returns workaround found when Claude confirms user-facing docs', async () => {
    mockSearchVault.mockResolvedValue([
      { path: 'Guides/cms-save.md', snippet: 'To work around: use Ctrl+S instead of the button', score: 0.9 },
    ])
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          workaround_found: true,
          workaround_text: 'Use Ctrl+S to save instead of the Save button.',
          has_user_facing_docs: true,
          documentation_gap: false,
        }),
      }],
    })

    const result = await searchForWorkaround({
      ...EMPTY_TICKET_DATA,
      issue_summary: 'CMS crash on save',
      environment: { platform: 'Web', brand: 'Acme', storyboard: 'Summer' },
    })

    expect(result.found).toBe(true)
    expect(result.hasUserFacingDocs).toBe(true)
    expect(result.text).toContain('Ctrl+S')
  })

  it('returns not found when vault search returns no results', async () => {
    mockSearchVault.mockResolvedValue([])
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          workaround_found: false,
          workaround_text: null,
          has_user_facing_docs: false,
          documentation_gap: true,
        }),
      }],
    })

    const result = await searchForWorkaround({ ...EMPTY_TICKET_DATA, issue_summary: 'Unknown crash' })
    expect(result.found).toBe(false)
    expect(result.docGap).toBe(true)
  })

  it('handles Claude returning JSON wrapped in markdown fences', async () => {
    mockSearchVault.mockResolvedValue([])
    const payload = { workaround_found: false, workaround_text: null, has_user_facing_docs: false, documentation_gap: false }
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '```json\n' + JSON.stringify(payload) + '\n```' }],
    })
    const result = await searchForWorkaround({ ...EMPTY_TICKET_DATA })
    expect(result.found).toBe(false)
  })

  it('throws when Claude returns non-parseable output', async () => {
    mockSearchVault.mockResolvedValue([])
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'I cannot determine that.' }],
    })
    await expect(searchForWorkaround({ ...EMPTY_TICKET_DATA })).rejects.toThrow(
      'Workaround Claude returned non-JSON'
    )
  })
})

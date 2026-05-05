// __tests__/lib/issue-triage/media.test.ts
const mockCreate = jest.fn()

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}))

global.fetch = jest.fn()

describe('fetchSlackFile', () => {
  it('fetches a file using the bot token as Bearer auth', async () => {
    const fakeBuffer = Buffer.from('fake-image-data')
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      arrayBuffer: jest.fn().mockResolvedValue(fakeBuffer.buffer),
    })

    const { fetchSlackFile } = await import('@/lib/issue-triage/media')
    const result = await fetchSlackFile('https://files.slack.com/abc', 'xoxb-test')

    expect(global.fetch).toHaveBeenCalledWith('https://files.slack.com/abc', {
      headers: { Authorization: 'Bearer xoxb-test' },
    })
    expect(Buffer.isBuffer(result)).toBe(true)
  })

  it('throws when Slack returns a non-ok response', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 403 })
    const { fetchSlackFile } = await import('@/lib/issue-triage/media')
    await expect(fetchSlackFile('https://files.slack.com/abc', 'bad-token')).rejects.toThrow('Failed to fetch Slack file: 403')
  })
})

describe('generateVisualSummary', () => {
  beforeEach(() => mockCreate.mockReset())

  it('returns a one-line summary for image files', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'User clicking Export — progress bar stuck at 0%' }],
    })

    const { generateVisualSummary } = await import('@/lib/issue-triage/media')
    const result = await generateVisualSummary(
      Buffer.from('fake-png'),
      'image/png',
      'test-api-key'
    )

    expect(result).toBe('User clicking Export — progress bar stuck at 0%')
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-4-6' })
    )
  })

  it('returns null for non-image mimetypes', async () => {
    const { generateVisualSummary } = await import('@/lib/issue-triage/media')
    const result = await generateVisualSummary(Buffer.from('video'), 'video/quicktime', 'key')
    expect(result).toBeNull()
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

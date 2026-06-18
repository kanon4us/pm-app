import { buildSlackClient } from '@/lib/slack/client'

const TOKEN = 'xoxb-test-token'

// Minimal KnownBlock for testing
type KnownBlock = Record<string, unknown>

const BLOCKS: KnownBlock[] = [
  { type: 'section', text: { type: 'mrkdwn', text: 'Test block' } },
]

describe('buildSlackClient — vault extensions', () => {
  beforeEach(() => {
    global.fetch = jest.fn()
  })

  describe('dm', () => {
    it('POSTs to chat.postMessage with channel = userId', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          ts: '1234567890.000001',
          channel: 'D_USER1',
        }),
      })

      const client = buildSlackClient(TOKEN)
      const result = await client.dm('U_USER1', BLOCKS, 'Fallback text')

      const [url, opts] = (global.fetch as jest.Mock).mock.calls[0]
      expect(url).toContain('chat.postMessage')

      const body = JSON.parse(opts.body)
      expect(body.channel).toBe('U_USER1')
      expect(body.blocks).toEqual(BLOCKS)
      expect(body.text).toBe('Fallback text')

      expect(result.ok).toBe(true)
      expect(result.ts).toBe('1234567890.000001')
      expect(result.channel).toBe('D_USER1')
    })

    it('includes the Authorization header', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, ts: '111', channel: 'D1' }),
      })

      const client = buildSlackClient(TOKEN)
      await client.dm('U1', BLOCKS, 'hi')

      const [, opts] = (global.fetch as jest.Mock).mock.calls[0]
      expect(opts.headers['Authorization']).toBe(`Bearer ${TOKEN}`)
    })

    it('throws when Slack returns ok: false', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, error: 'not_in_channel' }),
      })

      const client = buildSlackClient(TOKEN)
      await expect(client.dm('U_BAD', BLOCKS, 'hi')).rejects.toThrow('not_in_channel')
    })
  })

  describe('openModal', () => {
    it('POSTs to views.open with trigger_id and view', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      })

      const view = { type: 'modal', title: { type: 'plain_text', text: 'Review' }, blocks: [] }
      const client = buildSlackClient(TOKEN)
      const result = await client.openModal('trigger-abc', view)

      const [url, opts] = (global.fetch as jest.Mock).mock.calls[0]
      expect(url).toContain('views.open')

      const body = JSON.parse(opts.body)
      expect(body.trigger_id).toBe('trigger-abc')
      expect(body.view).toEqual(view)

      expect(result.ok).toBe(true)
    })
  })

  describe('updateViaResponseUrl', () => {
    it('POSTs replace_original:true with blocks and text to the response URL', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({}),
        text: async () => 'ok',
      })

      const responseUrl = 'https://hooks.slack.com/actions/T0001/111/xxxyyyzzz'
      const client = buildSlackClient(TOKEN)
      await client.updateViaResponseUrl(responseUrl, BLOCKS, 'Updated text')

      const [url, opts] = (global.fetch as jest.Mock).mock.calls[0]
      expect(url).toBe(responseUrl)

      const body = JSON.parse(opts.body)
      expect(body.replace_original).toBe(true)
      expect(body.blocks).toEqual(BLOCKS)
      expect(body.text).toBe('Updated text')
    })

    it('does NOT send an Authorization header (response_url is pre-authorized)', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({}),
        text: async () => 'ok',
      })

      const client = buildSlackClient(TOKEN)
      await client.updateViaResponseUrl('https://hooks.slack.com/actions/x', BLOCKS, 'text')

      const [, opts] = (global.fetch as jest.Mock).mock.calls[0]
      expect(opts.headers?.['Authorization']).toBeUndefined()
    })
  })
})

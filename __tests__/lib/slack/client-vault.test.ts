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
    // A user ID is not a valid `channel` for chat.postMessage — Slack answers
    // channel_not_found. dm() must open (or reuse) the IM via conversations.open
    // to get the D-channel ID, then post to that.
    it('opens a DM channel via conversations.open, then posts to the D-channel', async () => {
      ;(global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ok: true, channel: { id: 'D_USER1' } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ok: true, ts: '1234567890.000001', channel: 'D_USER1' }),
        })

      const client = buildSlackClient(TOKEN)
      const result = await client.dm('U_USER1', BLOCKS, 'Fallback text')

      const [openUrl, openOpts] = (global.fetch as jest.Mock).mock.calls[0]
      expect(openUrl).toContain('conversations.open')
      expect(JSON.parse(openOpts.body).users).toBe('U_USER1')

      const [postUrl, postOpts] = (global.fetch as jest.Mock).mock.calls[1]
      expect(postUrl).toContain('chat.postMessage')
      const postBody = JSON.parse(postOpts.body)
      expect(postBody.channel).toBe('D_USER1')
      expect(postBody.blocks).toEqual(BLOCKS)
      expect(postBody.text).toBe('Fallback text')

      expect(result.ok).toBe(true)
      expect(result.ts).toBe('1234567890.000001')
      expect(result.channel).toBe('D_USER1')
    })

    it('includes the Authorization header on both calls', async () => {
      ;(global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, channel: { id: 'D1' } }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, ts: '111', channel: 'D1' }) })

      const client = buildSlackClient(TOKEN)
      await client.dm('U1', BLOCKS, 'hi')

      const [, openOpts] = (global.fetch as jest.Mock).mock.calls[0]
      const [, postOpts] = (global.fetch as jest.Mock).mock.calls[1]
      expect(openOpts.headers['Authorization']).toBe(`Bearer ${TOKEN}`)
      expect(postOpts.headers['Authorization']).toBe(`Bearer ${TOKEN}`)
    })

    it('throws when conversations.open fails (never reaches postMessage)', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, error: 'channel_not_found' }),
      })

      const client = buildSlackClient(TOKEN)
      await expect(client.dm('U_BAD', BLOCKS, 'hi')).rejects.toThrow('channel_not_found')
      expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1)
    })

    it('throws when chat.postMessage returns ok: false', async () => {
      ;(global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, channel: { id: 'D1' } }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: false, error: 'not_in_channel' }) })

      const client = buildSlackClient(TOKEN)
      await expect(client.dm('U1', BLOCKS, 'hi')).rejects.toThrow('not_in_channel')
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

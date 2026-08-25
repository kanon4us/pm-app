import { buildSlackClient, SlackApiError, isTransientSlackError } from '@/lib/slack/client'

const TOKEN = 'xoxb-test-token'

describe('buildSlackClient', () => {
  beforeEach(() => { global.fetch = jest.fn() })

  describe('postMessage', () => {
    it('posts to chat.postMessage and returns message ts', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, ts: '1234567890.000100' }),
      })

      const client = buildSlackClient(TOKEN)
      const ts = await client.postMessage('C123', 'Hello!')

      const [url, opts] = (global.fetch as jest.Mock).mock.calls[0]
      expect(url).toContain('chat.postMessage')
      expect(JSON.parse(opts.body)).toMatchObject({ channel: 'C123', text: 'Hello!' })
      expect(ts).toBe('1234567890.000100')
    })

    it('posts with thread_ts when provided', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, ts: '1234567890.000200' }),
      })

      const client = buildSlackClient(TOKEN)
      await client.postMessage('C123', 'Reply!', '1234567890.000100')

      const [, opts] = (global.fetch as jest.Mock).mock.calls[0]
      expect(JSON.parse(opts.body)).toMatchObject({ thread_ts: '1234567890.000100' })
    })

    it('throws when Slack returns ok: false', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, error: 'channel_not_found' }),
      })

      const client = buildSlackClient(TOKEN)
      await expect(client.postMessage('C_BAD', 'Hi')).rejects.toThrow('channel_not_found')
    })
  })

  describe('openDM', () => {
    it('opens a DM channel and returns the channel id', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, channel: { id: 'D_MICHAEL' } }),
      })

      const client = buildSlackClient(TOKEN)
      const channelId = await client.openDM('U_MICHAEL')

      expect(channelId).toBe('D_MICHAEL')
      const [, opts] = (global.fetch as jest.Mock).mock.calls[0]
      expect(JSON.parse(opts.body)).toMatchObject({ users: 'U_MICHAEL' })
    })
  })

  describe('getThreadReplies', () => {
    it('fetches thread replies and returns messages array', async () => {
      const messages = [
        { user: 'U001', text: 'CMS crashed', ts: '1234567890.000001' },
        { bot_id: 'B001', text: 'Tell me more', ts: '1234567890.000002' },
      ]
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, messages }),
      })

      const client = buildSlackClient(TOKEN)
      const result = await client.getThreadReplies('C123', '1234567890.000001')

      expect(result).toEqual(messages)
      const [url] = (global.fetch as jest.Mock).mock.calls[0]
      expect(url).toContain('conversations.replies')
    })
  })
})

describe('SlackApiError', () => {
  beforeEach(() => { global.fetch = jest.fn() })

  it('carries the Slack error code so callers can classify the failure', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error: 'user_not_found' }),
    })

    const client = buildSlackClient(TOKEN)
    await expect(client.postMessage('C1', 'Hi')).rejects.toThrow(SlackApiError)
    await expect(client.postMessage('C1', 'Hi')).rejects.toMatchObject({
      code: 'user_not_found',
      method: 'chat.postMessage',
    })
  })

  it('stays a plain Error subclass so existing .message handling is unchanged', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error: 'channel_not_found' }),
    })

    const err = await buildSlackClient(TOKEN).postMessage('C1', 'Hi').catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('channel_not_found')
  })
})

describe('isTransientSlackError', () => {
  it.each(['ratelimited', 'internal_error', 'service_unavailable', 'fatal_error'])(
    'treats %s as transient (worth retrying)',
    (code) => {
      expect(isTransientSlackError(new SlackApiError(code, 'chat.postMessage'))).toBe(true)
    }
  )

  it.each(['user_not_found', 'channel_not_found', 'invalid_blocks', 'is_archived', 'cannot_dm_bot'])(
    'treats %s as permanent (retrying cannot help)',
    (code) => {
      expect(isTransientSlackError(new SlackApiError(code, 'chat.postMessage'))).toBe(false)
    }
  )

  it('treats a network-level failure as transient', () => {
    expect(isTransientSlackError(new TypeError('fetch failed'))).toBe(true)
  })

  it('treats an unrecognised Slack code as permanent so a bad message cannot loop forever', () => {
    expect(isTransientSlackError(new SlackApiError('some_new_code', 'chat.postMessage'))).toBe(false)
  })
})

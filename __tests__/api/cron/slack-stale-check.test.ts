import { GET } from '@/app/api/cron/slack-stale-check/route'
import { NextRequest } from 'next/server'

process.env.SLACK_BOT_TOKEN = 'xoxb-test'

const mockPostMessage = jest.fn().mockResolvedValue('ts-nudge')

jest.mock('@/lib/slack/client', () => ({
  buildSlackClient: jest.fn(() => ({ postMessage: mockPostMessage })),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      lt: jest.fn().mockResolvedValue({
        data: [
          { thread_ts: '111.000', channel_id: 'C_ISSUES', status: 'gathering' },
          { thread_ts: '222.000', channel_id: 'C_ISSUES', status: 'confirming' },
        ],
        error: null,
      }),
    }),
  }),
}))

const staleIssues = [
  { thread_ts: '111.000', channel_id: 'C_ISSUES', status: 'gathering' },
  { thread_ts: '222.000', channel_id: 'C_ISSUES', status: 'confirming' },
]

describe('GET /api/cron/slack-stale-check', () => {
  beforeEach(() => {
    mockPostMessage.mockClear()
  })

  it('returns 200 and reports how many threads were nudged', async () => {
    const req = new NextRequest('http://localhost/api/cron/slack-stale-check')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.nudged).toBe(2)
  })

  it('posts a nudge message to each stale thread', async () => {
    const req = new NextRequest('http://localhost/api/cron/slack-stale-check')
    await GET(req)
    expect(mockPostMessage).toHaveBeenCalledTimes(2)
    expect(mockPostMessage).toHaveBeenCalledWith(
      'C_ISSUES',
      expect.stringContaining('Still there'),
      '111.000',
    )
  })
})

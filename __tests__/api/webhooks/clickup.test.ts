import { POST } from '@/app/api/webhooks/clickup/route'
import { NextRequest } from 'next/server'
import crypto from 'crypto'

const SECRET = 'test-webhook-secret'
process.env.CLICKUP_WEBHOOK_SECRET = SECRET
process.env.SLACK_BOT_TOKEN = 'xoxb-test'
process.env.CLICKUP_NEW_TICKETS_LIST_ID = 'list-new'
process.env.CLICKUP_ACTIVE_LIST_ID = 'list-active'

function makeRequest(body: object): NextRequest {
  const raw = JSON.stringify(body)
  const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex')
  return new NextRequest('http://localhost/api/webhooks/clickup', {
    method: 'POST',
    headers: { 'x-signature': sig, 'content-type': 'application/json' },
    body: raw,
  })
}

/** Build a Supabase mock whose per-table .single() resolves can be overridden. */
function makeSupabaseMock(overrides: Record<string, { data: unknown }> = {}) {
  const singleFn = jest.fn().mockImplementation(function (this: { _table: string }) {
    const result = overrides[this._table] ?? { data: null }
    return Promise.resolve(result)
  })

  const chainMock = {
    _table: '',
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    single: singleFn,
    insert: jest.fn().mockResolvedValue({ data: null, error: null }),
    update: jest.fn().mockReturnThis(),
  }

  const fromFn = jest.fn().mockImplementation((table: string) => {
    return { ...chainMock, _table: table, single: () => Promise.resolve(overrides[table] ?? { data: null }) }
  })

  return { from: fromFn }
}

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn(),
}))

jest.mock('@/lib/slack/client', () => ({
  buildSlackClient: jest.fn().mockReturnValue({
    postMessage: jest.fn().mockResolvedValue('ts-bot'),
  }),
}))

// Mock global fetch for the survey Block Kit call
global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }) as jest.Mock

describe('POST /api/webhooks/clickup', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
  })

  it('returns 401 for invalid signature', async () => {
    const req = new NextRequest('http://localhost/api/webhooks/clickup', {
      method: 'POST',
      headers: { 'x-signature': 'bad', 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'taskStatusUpdated' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('returns 200 and acks unsupported events', async () => {
    const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(makeSupabaseMock())
    const req = makeRequest({ event: 'taskCreated', task_id: 'x' })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('returns 200 for valid taskStatusUpdated when task not found', async () => {
    const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')
    // tasks → not found; oauth_tokens → not found; slack_issues → not found
    getSupabaseServiceClient.mockResolvedValue(makeSupabaseMock())
    const req = makeRequest({
      event: 'taskStatusUpdated',
      task_id: 'unknown',
      history_items: [{ after: { status: 'in_progress' } }],
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
  })

  it('sets handoff_status=taken and posts survey when a tracked task status is updated', async () => {
    const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')
    const { buildSlackClient } = jest.requireMock('@/lib/slack/client')
    const slack = buildSlackClient()

    // tasks → found with list_id; slack_issues → found with no handoff
    const supabaseMock = {
      from: jest.fn().mockImplementation((table: string) => {
        const base = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          update: jest.fn().mockReturnThis(),
          insert: jest.fn().mockResolvedValue({ data: null, error: null }),
        }
        if (table === 'tasks') {
          return { ...base, single: jest.fn().mockResolvedValue({ data: { id: 'db-task-1', list_id: 'list-1', status: 'new' } }) }
        }
        if (table === 'trigger_configs') {
          return { ...base, single: jest.fn().mockResolvedValue({ data: null }) }
        }
        if (table === 'slack_issues') {
          return { ...base, single: jest.fn().mockResolvedValue({ data: { clickup_task_id: 'cu-abc', channel_id: 'C_ISSUES', thread_ts: '1.0', handoff_status: null } }) }
        }
        return { ...base, single: jest.fn().mockResolvedValue({ data: null }) }
      }),
    }
    getSupabaseServiceClient.mockResolvedValue(supabaseMock)

    const req = makeRequest({
      event: 'taskStatusUpdated',
      task_id: 'cu-abc',
      history_items: [{ after: { status: 'in_progress' } }],
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(slack.postMessage).toHaveBeenCalledWith('C_ISSUES', expect.stringContaining('claimed'), '1.0')
    // Survey sent via fetch
    expect(global.fetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('posts return message when task is moved back to New Tickets list', async () => {
    const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')
    const { buildSlackClient } = jest.requireMock('@/lib/slack/client')
    const slack = buildSlackClient()

    const supabaseMock = {
      from: jest.fn().mockImplementation((table: string) => {
        const base = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          update: jest.fn().mockReturnThis(),
          insert: jest.fn().mockResolvedValue({ data: null, error: null }),
        }
        if (table === 'tasks') {
          return { ...base, single: jest.fn().mockResolvedValue({ data: { id: 'db-task-1', list_id: 'list-1', status: 'new' } }) }
        }
        if (table === 'slack_issues') {
          return { ...base, single: jest.fn().mockResolvedValue({ data: { clickup_task_id: 'cu-abc', channel_id: 'C_ISSUES', thread_ts: '1.0', handoff_status: 'taken' } }) }
        }
        return { ...base, single: jest.fn().mockResolvedValue({ data: null }) }
      }),
    }
    getSupabaseServiceClient.mockResolvedValue(supabaseMock)

    const req = makeRequest({
      event: 'taskMoved',
      task_id: 'cu-abc',
      history_items: [{ field: 'section_moved', after: { list: { id: 'list-new' } } }],
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(slack.postMessage).toHaveBeenCalledWith('C_ISSUES', expect.stringContaining('more information'), '1.0')
  })

  it('taskMoved: updates task list_id and enqueues trigger when destination list is subscribed', async () => {
    const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')

    const insertTriggerQueue = jest.fn().mockResolvedValue({ data: null, error: null })

    supabaseMock_taskMoved: {
      const chain = (table: string) => {
        const base = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          update: jest.fn().mockReturnThis(),
          not: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({ data: null }),
          insert: jest.fn().mockResolvedValue({ data: null, error: null }),
        }
        if (table === 'lists') return { ...base, single: jest.fn().mockResolvedValue({ data: { id: 'db-list-active' } }) }
        if (table === 'tasks') return { ...base, single: jest.fn().mockResolvedValue({ data: { id: 'db-task-1', list_id: 'db-list-planning', status: 'in_progress' } }) }
        if (table === 'trigger_configs') return { ...base, eq: jest.fn().mockResolvedValue({ data: [{ id: 'cfg-1' }] }) }
        if (table === 'trigger_queue') return { ...base, insert: insertTriggerQueue }
        if (table === 'slack_issues') return { ...base, single: jest.fn().mockResolvedValue({ data: null }) }
        return base
      }
      getSupabaseServiceClient.mockResolvedValue({ from: jest.fn().mockImplementation(chain) })
    }

    const req = makeRequest({
      event: 'taskMoved',
      task_id: 'cu-task-1',
      history_items: [{ field: 'section_moved', after: { list: { id: 'list-active' } } }],
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(insertTriggerQueue).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ task_id: 'db-task-1', config_id: 'cfg-1', status: 'pending' })])
    )
  })

  it('taskMoved: acks silently when destination list is not subscribed', async () => {
    const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')
    const base = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null }),
      insert: jest.fn().mockResolvedValue({ data: null }),
    }
    getSupabaseServiceClient.mockResolvedValue({ from: jest.fn().mockReturnValue(base) })

    const req = makeRequest({
      event: 'taskMoved',
      task_id: 'cu-task-99',
      history_items: [{ field: 'section_moved', after: { list: { id: 'list-unknown' } } }],
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('taskMoved: does not update status field, only list_id', async () => {
    const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')
    const updateFn = jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({ data: null }) })

    const chain = (table: string) => {
      const base = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        update: updateFn,
        not: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: null }),
        insert: jest.fn().mockResolvedValue({ data: null }),
      }
      if (table === 'lists') return { ...base, single: jest.fn().mockResolvedValue({ data: { id: 'db-list-active' } }) }
      if (table === 'tasks') return { ...base, single: jest.fn().mockResolvedValue({ data: { id: 'db-task-1', list_id: 'db-list-planning', status: 'Architecting' } }) }
      if (table === 'trigger_configs') return { ...base, eq: jest.fn().mockResolvedValue({ data: [] }) }
      if (table === 'slack_issues') return { ...base, single: jest.fn().mockResolvedValue({ data: null }) }
      return base
    }
    getSupabaseServiceClient.mockResolvedValue({ from: jest.fn().mockImplementation(chain) })

    const req = makeRequest({
      event: 'taskMoved',
      task_id: 'cu-task-1',
      history_items: [{ field: 'section_moved', after: { list: { id: 'list-active' } } }],
    })
    await POST(req)

    // update should set list_id but NOT status
    expect(updateFn).toHaveBeenCalledWith(
      expect.not.objectContaining({ status: expect.anything() })
    )
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ list_id: 'db-list-active' })
    )
  })
})

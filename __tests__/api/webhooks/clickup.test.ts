import { POST } from '@/app/api/webhooks/clickup/route'
import { NextRequest } from 'next/server'
import crypto from 'crypto'

const SECRET = 'test-webhook-secret'
process.env.CLICKUP_WEBHOOK_SECRET = SECRET

function makeRequest(body: object): NextRequest {
  const raw = JSON.stringify(body)
  const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex')
  return new NextRequest('http://localhost/api/webhooks/clickup', {
    method: 'POST',
    headers: { 'x-signature': sig, 'content-type': 'application/json' },
    body: raw,
  })
}

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null }),
      insert: jest.fn().mockResolvedValue({ error: null }),
      update: jest.fn().mockReturnThis(),
    }),
  }),
}))

describe('POST /api/webhooks/clickup', () => {
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
    const req = makeRequest({ event: 'taskCreated', task_id: 'x' })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('returns 200 for valid taskStatusUpdated when task not found', async () => {
    const req = makeRequest({
      event: 'taskStatusUpdated',
      task_id: 'unknown',
      history_items: [{ after: { status: { status: 'In Progress' } } }],
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
  })
})

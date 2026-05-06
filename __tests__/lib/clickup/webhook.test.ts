import { verifyClickUpSignature, parseWebhookEvent } from '@/lib/clickup/webhook'
import crypto from 'crypto'

const SECRET = 'test-secret'

function sign(body: string): string {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex')
}

describe('verifyClickUpSignature', () => {
  it('returns true for valid signature', () => {
    const body = JSON.stringify({ event: 'taskStatusUpdated' })
    expect(verifyClickUpSignature(body, sign(body), SECRET)).toBe(true)
  })

  it('returns false for tampered body', () => {
    const body = JSON.stringify({ event: 'taskStatusUpdated' })
    expect(verifyClickUpSignature(body + 'x', sign(body), SECRET)).toBe(false)
  })

  it('returns false for wrong secret', () => {
    const body = JSON.stringify({ event: 'taskStatusUpdated' })
    expect(verifyClickUpSignature(body, sign(body), 'wrong-secret')).toBe(false)
  })
})

describe('parseWebhookEvent', () => {
  it('extracts taskId and status from taskStatusUpdated payload', () => {
    const payload = {
      event: 'taskStatusUpdated',
      task_id: 'abc123',
      history_items: [{ after: { status: 'In Progress' } }],
    }
    const event = parseWebhookEvent(payload)
    expect(event).toEqual({ taskId: 'abc123', toStatus: 'In Progress', type: 'taskStatusUpdated' })
  })

  it('returns null for unsupported event type', () => {
    expect(parseWebhookEvent({ event: 'taskCreated', task_id: 'x' })).toBeNull()
  })
})

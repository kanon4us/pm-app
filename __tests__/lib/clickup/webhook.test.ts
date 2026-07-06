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

  it('collects changed custom-field AND top-level field names from taskUpdated', () => {
    const payload = {
      event: 'taskUpdated',
      task_id: 't1',
      history_items: [
        { field: 'custom_field', custom_field: { name: 'Design states' } },
        { field: 'description' },
        { field: 'custom_field', custom_field: { name: 'Figma' } },
      ],
    }
    expect(parseWebhookEvent(payload)).toEqual({
      taskId: 't1',
      type: 'taskUpdated',
      toStatus: '',
      changedFieldNames: ['Design states', 'description', 'Figma'],
    })
  })

  it('taskUpdated with no history_items yields empty changedFieldNames', () => {
    expect(parseWebhookEvent({ event: 'taskUpdated', task_id: 't2' })).toEqual({
      taskId: 't2', type: 'taskUpdated', toStatus: '', changedFieldNames: [],
    })
  })
})

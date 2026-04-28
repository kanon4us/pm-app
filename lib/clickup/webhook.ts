import crypto from 'crypto'

export interface ClickUpWebhookEvent {
  taskId: string
  toStatus: string
  event: string
}

export function verifyClickUpSignature(
  rawBody: string,
  signature: string,
  secret: string
): boolean {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    return false
  }
}

export function parseWebhookEvent(payload: Record<string, unknown>): ClickUpWebhookEvent | null {
  if (payload.event !== 'taskStatusUpdated') return null
  const taskId = payload.task_id as string
  const historyItems = payload.history_items as Array<{ after?: { status?: string } }>
  const toStatus = historyItems?.[0]?.after?.status
  if (!taskId || !toStatus) return null
  return { taskId, toStatus, event: payload.event as string }
}

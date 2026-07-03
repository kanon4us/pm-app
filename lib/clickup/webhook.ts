import crypto from 'crypto'

export interface ClickUpWebhookEvent {
  taskId: string
  type: string
  toStatus: string
  /** Present on taskMoved events: the destination list ID */
  listId?: string
  /** Present on taskTagUpdated events: tag names after the change */
  tags?: string[]
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
  const eventType = payload.event as string
  const taskId = payload.task_id as string
  if (!taskId) return null

  if (eventType === 'taskStatusUpdated') {
    const historyItems = payload.history_items as Array<{ after?: { status?: string } }>
    const toStatus = historyItems?.[0]?.after?.status
    if (!toStatus) return null
    return { taskId, type: eventType, toStatus }
  }

  if (eventType === 'taskTagUpdated') {
    const historyItems = payload.history_items as Array<{ after?: Array<{ name?: string }> | { name?: string } }>
    const after = historyItems?.[0]?.after
    const tags = (Array.isArray(after) ? after : after ? [after] : [])
      .map((t) => t?.name)
      .filter((n): n is string => typeof n === 'string')
    return { taskId, type: eventType, toStatus: '', tags }
  }

  if (eventType === 'taskMoved') {
    const historyItems = payload.history_items as Array<{ after?: { list?: { id?: string } }; field?: string }>
    const listId = historyItems?.find((h) => h.field === 'section_moved')?.after?.list?.id
      ?? historyItems?.[0]?.after?.list?.id
    return { taskId, type: eventType, toStatus: '', listId }
  }

  return null
}

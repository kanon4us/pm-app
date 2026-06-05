import crypto from 'crypto'

export interface FeedbackTokenPayload {
  sprint_id: string
  expires_at: number
}

function secret(): string {
  const s = process.env.FEEDBACK_TOKEN_SECRET
  if (!s) throw new Error('FEEDBACK_TOKEN_SECRET is not set')
  return s
}

export function generateFeedbackToken(sprintId: string): string {
  const payload: FeedbackTokenPayload = {
    sprint_id: sprintId,
    expires_at: Date.now() + 7 * 24 * 60 * 60 * 1000,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', secret()).update(encoded).digest('hex')
  return `${encoded}.${sig}`
}

export function verifyFeedbackToken(token: string): FeedbackTokenPayload {
  const dotIdx = token.lastIndexOf('.')
  if (dotIdx === -1) throw new Error('Invalid token format')

  const encoded = token.slice(0, dotIdx)
  const sig = token.slice(dotIdx + 1)

  const expected = crypto.createHmac('sha256', secret()).update(encoded).digest('hex')
  const sigBuf = Buffer.from(sig, 'hex')
  const expectedBuf = Buffer.from(expected, 'hex')

  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid token signature')
  }

  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as FeedbackTokenPayload
  if (Date.now() > payload.expires_at) throw new Error('Token expired')

  return payload
}

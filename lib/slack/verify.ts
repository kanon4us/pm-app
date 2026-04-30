import crypto from 'crypto'

/**
 * Verify that an incoming Slack webhook request is authentic.
 * Rejects requests with timestamps older than 5 minutes (replay attack prevention).
 */
export function verifySlackSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  signingSecret: string,
): boolean {
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false

  const baseString = `v0:${timestamp}:${rawBody}`
  const expected = 'v0=' + crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex')

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    return false
  }
}

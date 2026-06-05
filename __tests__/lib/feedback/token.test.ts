import { generateFeedbackToken, verifyFeedbackToken } from '@/lib/feedback/token'

const SECRET = 'test-secret-32-chars-minimum-ok!'
beforeEach(() => {
  process.env.FEEDBACK_TOKEN_SECRET = SECRET
})

describe('generateFeedbackToken / verifyFeedbackToken', () => {
  it('round-trips a sprint_id', () => {
    const token = generateFeedbackToken('sprint-abc')
    const payload = verifyFeedbackToken(token)
    expect(payload.sprint_id).toBe('sprint-abc')
  })

  it('includes an expiry ~7 days out', () => {
    const before = Date.now()
    const token = generateFeedbackToken('sprint-abc')
    const payload = verifyFeedbackToken(token)
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    expect(payload.expires_at).toBeGreaterThan(before + sevenDays - 1000)
    expect(payload.expires_at).toBeLessThan(before + sevenDays + 1000)
  })

  it('throws on tampered payload', () => {
    const token = generateFeedbackToken('sprint-abc')
    const dotIdx = token.lastIndexOf('.')
    const sig = token.slice(dotIdx + 1)
    const tampered = Buffer.from(JSON.stringify({ sprint_id: 'evil', expires_at: Date.now() + 999999 })).toString('base64url')
    expect(() => verifyFeedbackToken(`${tampered}.${sig}`)).toThrow('Invalid token signature')
  })

  it('throws on expired token', () => {
    jest.useFakeTimers()
    const token = generateFeedbackToken('sprint-abc')
    jest.advanceTimersByTime(8 * 24 * 60 * 60 * 1000) // 8 days
    expect(() => verifyFeedbackToken(token)).toThrow('Token expired')
    jest.useRealTimers()
  })

  it('throws on malformed token (no dot separator)', () => {
    expect(() => verifyFeedbackToken('notavalidtoken')).toThrow('Invalid token format')
  })
})

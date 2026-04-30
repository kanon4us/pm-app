import crypto from 'crypto'
import { verifySlackSignature } from '@/lib/slack/verify'

const SECRET = 'test-signing-secret'

function makeSignature(timestamp: string, body: string): string {
  const base = `v0:${timestamp}:${body}`
  return 'v0=' + crypto.createHmac('sha256', SECRET).update(base).digest('hex')
}

describe('verifySlackSignature', () => {
  it('returns true for a valid signature with current timestamp', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const body = '{"type":"event_callback"}'
    expect(verifySlackSignature(body, ts, makeSignature(ts, body), SECRET)).toBe(true)
  })

  it('returns false for a tampered body', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const body = '{"type":"event_callback"}'
    const sig = makeSignature(ts, body)
    expect(verifySlackSignature('{"type":"tampered"}', ts, sig, SECRET)).toBe(false)
  })

  it('returns false for a signature older than 5 minutes', () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 400)
    const body = '{"type":"event_callback"}'
    const sig = makeSignature(staleTs, body)
    expect(verifySlackSignature(body, staleTs, sig, SECRET)).toBe(false)
  })

  it('returns false for a wrong secret', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const body = '{"type":"event_callback"}'
    const sig = makeSignature(ts, body)
    expect(verifySlackSignature(body, ts, sig, 'wrong-secret')).toBe(false)
  })

  it('returns false when signature length mismatches', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    expect(verifySlackSignature('body', ts, 'v0=short', SECRET)).toBe(false)
  })
})

// __tests__/lib/bot/auth.test.ts
import { verifyBotJwt, signBotJwt, BotAuthError } from '@/lib/bot/auth'

const SECRET = 'test-secret-for-bot-jwt'

const baseClaims = {
  exp: Math.floor(Date.now() / 1000) + 300,
  userId: 'user-1',
  teamId: 'team-1',
  email: 'user@viscap.ai',
  roles: ['editor'],
  entitlements: ['help-resources-free'],
}

describe('verifyBotJwt', () => {
  beforeEach(() => {
    process.env.BOT_JWT_SECRET = SECRET
  })

  it('accepts a valid token and returns claims', () => {
    const token = signBotJwt(baseClaims, SECRET)
    const claims = verifyBotJwt(`Bearer ${token}`)
    expect(claims.userId).toBe('user-1')
    expect(claims.teamId).toBe('team-1')
    expect(claims.entitlements).toEqual(['help-resources-free'])
  })

  it('rejects a missing header', () => {
    expect(() => verifyBotJwt(null)).toThrow(BotAuthError)
  })

  it('rejects an expired token', () => {
    const token = signBotJwt({ ...baseClaims, exp: Math.floor(Date.now() / 1000) - 10 }, SECRET)
    expect(() => verifyBotJwt(`Bearer ${token}`)).toThrow('Token expired')
  })

  it('rejects a bad signature', () => {
    const token = signBotJwt(baseClaims, 'wrong-secret')
    expect(() => verifyBotJwt(`Bearer ${token}`)).toThrow('Invalid signature')
  })

  it('rejects a tampered payload', () => {
    const token = signBotJwt(baseClaims, SECRET)
    const [h, p, s] = token.split('.')
    const tampered = Buffer.from(
      JSON.stringify({ ...baseClaims, iss: 'viscap-cloud-functions', aud: 'pm-app-bot', entitlements: ['paid-product-x'] })
    ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(() => verifyBotJwt(`Bearer ${h}.${tampered}.${s}`)).toThrow('Invalid signature')
  })

  it('rejects wrong audience', () => {
    // sign with correct secret but mutate aud via direct construction
    const { createHmac } = jest.requireActual('crypto')
    const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
    const payload = b64url(Buffer.from(JSON.stringify({ ...baseClaims, iss: 'viscap-cloud-functions', aud: 'someone-else' })))
    const sig = b64url(createHmac('sha256', SECRET).update(`${header}.${payload}`).digest())
    expect(() => verifyBotJwt(`Bearer ${header}.${payload}.${sig}`)).toThrow('Invalid audience')
  })

  it('rejects missing entitlements claim', () => {
    const { entitlements: _omit, ...rest } = baseClaims
    const token = signBotJwt(rest as never, SECRET)
    expect(() => verifyBotJwt(`Bearer ${token}`)).toThrow('Missing entitlements claim')
  })

  it('throws when BOT_JWT_SECRET is unset', () => {
    delete process.env.BOT_JWT_SECRET
    const token = signBotJwt(baseClaims, SECRET)
    expect(() => verifyBotJwt(`Bearer ${token}`)).toThrow('BOT_JWT_SECRET not configured')
  })
})

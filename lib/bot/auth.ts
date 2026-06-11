// lib/bot/auth.ts
// HS256 JWT trust between viscap-ai-cloud-functions and pm-app.
// The shared secret lives in GCP Secret Manager ('pmapp-bot-jwt-secret')
// and in Vercel env as BOT_JWT_SECRET.
//
// SECURITY: entitlements used for retrieval filtering come ONLY from the
// verified claims returned here — never from request bodies.

import { createHmac, timingSafeEqual } from 'crypto'
import type { BotJwtClaims } from './types'

const EXPECTED_ISS = 'viscap-cloud-functions'
const EXPECTED_AUD = 'pm-app-bot'

function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4))
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

export class BotAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BotAuthError'
  }
}

export function verifyBotJwt(authHeader: string | null): BotJwtClaims {
  const secret = process.env.BOT_JWT_SECRET
  if (!secret) throw new BotAuthError('BOT_JWT_SECRET not configured')

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new BotAuthError('Missing bearer token')
  }
  const token = authHeader.slice('Bearer '.length).trim()
  const parts = token.split('.')
  if (parts.length !== 3) throw new BotAuthError('Malformed token')

  const [headerB64, payloadB64, sigB64] = parts

  let header: { alg?: string; typ?: string }
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString('utf8'))
  } catch {
    throw new BotAuthError('Malformed token header')
  }
  if (header.alg !== 'HS256') throw new BotAuthError('Unsupported algorithm')

  const expected = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest()
  const actual = b64urlDecode(sigB64)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new BotAuthError('Invalid signature')
  }

  let claims: BotJwtClaims
  try {
    claims = JSON.parse(b64urlDecode(payloadB64).toString('utf8'))
  } catch {
    throw new BotAuthError('Malformed token payload')
  }

  if (claims.iss !== EXPECTED_ISS) throw new BotAuthError('Invalid issuer')
  if (claims.aud !== EXPECTED_AUD) throw new BotAuthError('Invalid audience')
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) {
    throw new BotAuthError('Token expired')
  }
  if (!claims.userId || !claims.teamId) throw new BotAuthError('Missing required claims')
  if (!Array.isArray(claims.entitlements)) throw new BotAuthError('Missing entitlements claim')

  return claims
}

/** Test helper / CF reference implementation: sign a claims object. */
export function signBotJwt(claims: Omit<BotJwtClaims, 'iss' | 'aud'>, secret: string): string {
  const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const payload = b64url(Buffer.from(JSON.stringify({ ...claims, iss: EXPECTED_ISS, aud: EXPECTED_AUD })))
  const sig = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest())
  return `${header}.${payload}.${sig}`
}

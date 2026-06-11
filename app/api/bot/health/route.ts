// app/api/bot/health/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { verifyBotJwt, BotAuthError } from '@/lib/bot/auth'
import { getActiveChatPolicy } from '@/lib/bot/policies'

export async function GET(request: NextRequest) {
  try {
    verifyBotJwt(request.headers.get('authorization'))
  } catch (err) {
    if (err instanceof BotAuthError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    throw err
  }

  try {
    const policy = await getActiveChatPolicy()
    return NextResponse.json({ ok: true, policyVersion: policy.version })
  } catch {
    return NextResponse.json({ ok: false, error: 'No active policy' }, { status: 503 })
  }
}

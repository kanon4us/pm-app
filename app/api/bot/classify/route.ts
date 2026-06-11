// app/api/bot/classify/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { verifyBotJwt, BotAuthError } from '@/lib/bot/auth'
import { getActiveChatPolicy } from '@/lib/bot/policies'
import { classifyMessage } from '@/lib/bot/classify'

export async function POST(request: NextRequest) {
  try {
    verifyBotJwt(request.headers.get('authorization'))
  } catch (err) {
    if (err instanceof BotAuthError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    throw err
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body.message !== 'string') {
    return NextResponse.json({ error: 'Expected { message }' }, { status: 400 })
  }

  try {
    const policy = await getActiveChatPolicy()
    const result = await classifyMessage(body.message, policy)
    return NextResponse.json(result)
  } catch (err) {
    console.error('[api/bot/classify] failed:', err)
    return NextResponse.json({ error: 'Classification failed' }, { status: 500 })
  }
}

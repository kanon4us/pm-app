// app/api/bot/chat/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { verifyBotJwt, BotAuthError } from '@/lib/bot/auth'
import { getActiveChatPolicy } from '@/lib/bot/policies'
import { runChatTurn } from '@/lib/bot/chat'

export async function POST(request: NextRequest) {
  let claims
  try {
    claims = verifyBotJwt(request.headers.get('authorization'))
  } catch (err) {
    if (err instanceof BotAuthError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    throw err
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body.message !== 'string' || typeof body.conversationRef !== 'string') {
    return NextResponse.json({ error: 'Expected { conversationRef, turnIndex, message }' }, { status: 400 })
  }
  if (body.message.length > 8000) {
    return NextResponse.json({ error: 'Message too long' }, { status: 400 })
  }

  try {
    const policy = await getActiveChatPolicy()
    const result = await runChatTurn(
      {
        conversationRef: body.conversationRef,
        turnIndex: typeof body.turnIndex === 'number' ? body.turnIndex : 0,
        message: body.message,
        pageSlug: typeof body.pageSlug === 'string' ? body.pageSlug : undefined,
        priorIntent: body.priorIntent,
      },
      claims,
      policy,
    )
    return NextResponse.json(result)
  } catch (err) {
    console.error('[api/bot/chat] turn failed:', err)
    return NextResponse.json({ error: 'Chat turn failed' }, { status: 500 })
  }
}

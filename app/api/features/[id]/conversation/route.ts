import { NextRequest, NextResponse } from 'next/server'
import { getOrCreateConversation, getMessages } from '@/lib/features/conversation'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const conversation = await getOrCreateConversation(id)
  const messages = await getMessages(conversation.id)
  return NextResponse.json({ conversation, messages })
}

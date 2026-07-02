import { NextRequest, NextResponse } from 'next/server'
import { sendFeatureMessage } from '@/lib/features/conversation'
import { getSessionUser } from '@/lib/auth'

// Prototyping turns run an agentic tool loop against the product repo
export const maxDuration = 300

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const { content } = await req.json()
  if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 })
  const result = await sendFeatureMessage(id, content, user.dbId)
  return NextResponse.json(result)
}

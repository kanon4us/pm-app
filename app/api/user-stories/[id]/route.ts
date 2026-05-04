import { NextRequest, NextResponse } from 'next/server'
import { updateUserStory } from '@/lib/user-stories/client'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const story = await updateUserStory(id, body)
  return NextResponse.json(story)
}

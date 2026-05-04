import { NextRequest, NextResponse } from 'next/server'
import { unlinkStory } from '@/lib/user-stories/client'

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; storyId: string }> }) {
  const { id, storyId } = await params
  await unlinkStory(id, storyId)
  return NextResponse.json({ ok: true })
}

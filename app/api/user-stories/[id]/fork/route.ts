import { NextRequest, NextResponse } from 'next/server'
import { forkStory } from '@/lib/user-stories/client'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { target_feature_id } = await req.json()
  if (!target_feature_id) return NextResponse.json({ error: 'target_feature_id required' }, { status: 400 })
  const forked = await forkStory(id, target_feature_id)
  return NextResponse.json(forked, { status: 201 })
}

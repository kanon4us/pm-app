import { NextRequest, NextResponse } from 'next/server'
import { createUserStory, linkStory, getFeatureStories, getStoryFeatureCount } from '@/lib/user-stories/client'
import { getSessionUser } from '@/lib/auth'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const stories = await getFeatureStories(id)
  const storiesWithCount = await Promise.all(stories.map(async (s) => ({
    ...s,
    featureCount: await getStoryFeatureCount(s.id),
  })))
  return NextResponse.json(storiesWithCount)
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  if (body.story_id) {
    await linkStory(id, body.story_id, body.display_order ?? 0)
    return NextResponse.json({ ok: true })
  }
  if (!body.as_a || !body.i_want || !body.so_that) {
    return NextResponse.json({ error: 'as_a, i_want, so_that required' }, { status: 400 })
  }
  const story = await createUserStory({ title: body.title ?? body.as_a, as_a: body.as_a, i_want: body.i_want, so_that: body.so_that })
  await linkStory(id, story.id, body.display_order ?? 0)
  return NextResponse.json(story, { status: 201 })
}

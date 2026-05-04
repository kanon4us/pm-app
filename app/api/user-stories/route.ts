import { NextRequest, NextResponse } from 'next/server'
import { createUserStory } from '@/lib/user-stories/client'

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (!body.as_a || !body.i_want || !body.so_that) {
    return NextResponse.json({ error: 'as_a, i_want, so_that required' }, { status: 400 })
  }
  const story = await createUserStory({ title: body.title ?? body.as_a, as_a: body.as_a, i_want: body.i_want, so_that: body.so_that })
  return NextResponse.json(story, { status: 201 })
}

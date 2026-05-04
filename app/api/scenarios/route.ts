import { NextRequest, NextResponse } from 'next/server'
import { createScenario } from '@/lib/scenarios/client'

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (!body.user_story_id || !body.title) return NextResponse.json({ error: 'user_story_id and title required' }, { status: 400 })
  const scenario = await createScenario(body)
  return NextResponse.json(scenario, { status: 201 })
}

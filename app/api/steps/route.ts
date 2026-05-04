import { NextRequest, NextResponse } from 'next/server'
import { createStep } from '@/lib/scenarios/client'

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (!body.scenario_id || !body.title) return NextResponse.json({ error: 'scenario_id and title required' }, { status: 400 })
  const step = await createStep(body)
  return NextResponse.json(step, { status: 201 })
}

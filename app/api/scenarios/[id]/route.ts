import { NextRequest, NextResponse } from 'next/server'
import { updateScenario } from '@/lib/scenarios/client'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const scenario = await updateScenario(id, body)
  return NextResponse.json(scenario)
}

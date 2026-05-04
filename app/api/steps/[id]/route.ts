import { NextRequest, NextResponse } from 'next/server'
import { updateStep, deleteStep } from '@/lib/scenarios/client'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const step = await updateStep(id, body)
  return NextResponse.json(step)
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await deleteStep(id)
  return NextResponse.json({ ok: true })
}

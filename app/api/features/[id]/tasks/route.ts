import { NextRequest, NextResponse } from 'next/server'
import { linkTask } from '@/lib/features/client'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { task_id } = await req.json()
  if (!task_id) return NextResponse.json({ error: 'task_id required' }, { status: 400 })
  await linkTask(id, task_id)
  return NextResponse.json({ ok: true })
}

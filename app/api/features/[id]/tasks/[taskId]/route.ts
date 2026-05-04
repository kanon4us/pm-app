import { NextRequest, NextResponse } from 'next/server'
import { unlinkTask } from '@/lib/features/client'

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  const { id, taskId } = await params
  await unlinkTask(id, taskId)
  return NextResponse.json({ ok: true })
}

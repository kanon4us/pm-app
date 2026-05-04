import { NextRequest, NextResponse } from 'next/server'
import { getTaskFeatures } from '@/lib/features/client'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const features = await getTaskFeatures(id)
    return NextResponse.json(features)
  } catch (err) {
    return NextResponse.json({ error: 'Failed to fetch features' }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { getTaskFeatures } from '@/lib/features/client'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const features = await getTaskFeatures(id)
  return NextResponse.json(features)
}

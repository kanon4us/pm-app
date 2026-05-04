import { NextRequest, NextResponse } from 'next/server'
import { listFeatures, createFeature } from '@/lib/features/client'
import { getSessionUser } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') ?? undefined
  const features = await listFeatures(q)
  return NextResponse.json(features)
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json()
  if (!body.name) return NextResponse.json({ error: 'name required' }, { status: 400 })
  const feature = await createFeature({ name: body.name, description: body.description ?? null })
  return NextResponse.json(feature, { status: 201 })
}

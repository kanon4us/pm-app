import { NextRequest, NextResponse } from 'next/server'
import { runUxReview } from '@/lib/features/review'
import { getSessionUser } from '@/lib/auth'

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { feature_ids } = await req.json()
  const findings = await runUxReview(feature_ids ?? [])
  return NextResponse.json(findings)
}

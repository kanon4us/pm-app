import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

/** Current feature-level prototype (rendered by Claude via render_prototype).
 *  ?meta=1 returns existence metadata only — html_content can be >1MB. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id: featureId } = await params
  const metaOnly = req.nextUrl.searchParams.get('meta') === '1'
  const db = await getSupabaseServiceClient()
  const { data } = await db
    .from('feature_prototypes')
    .select(metaOnly ? 'id, created_at' : 'id, html_content, created_at')
    .eq('feature_id', featureId)
    .is('scenario_id', null)
    .eq('is_current', true)
    .order('created_at', { ascending: false })
    .limit(1)
  if (!data?.length) return NextResponse.json({ error: 'No prototype yet' }, { status: 404 })
  return NextResponse.json(data[0])
}

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

type RouteContext = { params: Promise<{ email: string }> }

function getAuthKey(request: NextRequest): string | null {
  const auth = request.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return null
  return auth.slice(7)
}

export async function GET(request: NextRequest, context: RouteContext) {
  const apiKey = getAuthKey(request)
  if (!apiKey || apiKey !== process.env.VIDF_HOOK_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { email } = await context.params
  const decodedEmail = decodeURIComponent(email)

  const supabase = await getSupabaseServiceClient()

  const { data: existing, error } = await supabase
    .from('developer_experiments')
    .select('*')
    .eq('github_email', decodedEmail)
    .single()

  let record = existing

  // Non-PGRST116 errors are real database errors — surface them
  if (error && error.code !== 'PGRST116') {
    console.error('[VIDF] developer_experiments lookup error:', error)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }

  // PGRST116 = not found — auto-register with pre-VIDF defaults
  if (!record) {
    const sprint = new Date().toISOString().slice(0, 7)
    const { data: created, error: upsertError } = await supabase
      .from('developer_experiments')
      .upsert({
        github_email: decodedEmail,
        vidf_tag: 'pre',
        bundle_version: 'v0',
        sop_version: 'v0',
        sprint,
      })
      .select()
      .single()

    if (upsertError) {
      console.error('[VIDF] developer_experiments upsert error:', upsertError)
      return NextResponse.json({ error: 'Failed to register developer' }, { status: 500 })
    }

    record = created
  }

  if (!record) {
    return NextResponse.json({ error: 'Failed to retrieve experiment data' }, { status: 500 })
  }

  const commitTag = `[vidf:${record.vidf_tag} | bundle:${record.bundle_version} | sop:${record.sop_version} | sprint:${record.sprint}]`

  return NextResponse.json({
    tag: record.vidf_tag,
    bundle_version: record.bundle_version,
    sop_version: record.sop_version,
    sprint: record.sprint,
    commit_tag: commitTag,
  })
}

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

const EXPERIMENT_VERSION = 'v1'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ email: string }> },
) {
  await params // resolve params — email not used in v1, tag context is global

  const supabase = await getSupabaseServiceClient()

  const [{ data: activeVersion }, { data: openSprint }] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase.from('bundle_prompt_versions') as any)
      .select('version')
      .eq('status', 'active')
      .single(),
    supabase
      .from('sprints')
      .select('clickup_sprint_id, start_date')
      .order('start_date', { ascending: false })
      .limit(1)
      .single(),
  ])

  const sprintLabel = deriveSprintLabel(openSprint?.clickup_sprint_id, openSprint?.start_date)

  // This endpoint is intentionally unauthenticated — called from developer commit-msg hooks.
  // Returns only global experiment metadata (no PII). Cache-Control prevents stale tags.
  return NextResponse.json(
    {
      version: EXPERIMENT_VERSION,
      bundle_version: activeVersion?.version ?? 1,
      sprint: sprintLabel,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

function deriveSprintLabel(sprintId: string | null | undefined, startDate: string | null | undefined): string {
  if (sprintId) {
    const match = sprintId.match(/(\d{4})-(\d{2})/)
    if (match) return `${match[1]}-${match[2]}`
  }
  if (startDate) {
    const d = new Date(startDate)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  }
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

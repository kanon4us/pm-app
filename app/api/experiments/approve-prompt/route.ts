import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export async function POST(_req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: activeVersion } = await (supabase.from('bundle_prompt_versions') as any)
    .select('id, version, proposed_prompt_text')
    .eq('status', 'active')
    .single()

  if (!activeVersion?.proposed_prompt_text) {
    return NextResponse.json({ error: 'No proposed prompt text to approve' }, { status: 400 })
  }

  // Archive the current active version
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: archiveError } = await (supabase.from('bundle_prompt_versions') as any)
    .update({
      status: 'archived',
      proposed_prompt_text: null,
      change_summary: null,
    })
    .eq('id', activeVersion.id)

  if (archiveError) {
    return NextResponse.json({ error: 'Failed to archive current version' }, { status: 500 })
  }

  // Insert new active version
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: insertError } = await (supabase.from('bundle_prompt_versions') as any)
    .insert({
      version: activeVersion.version + 1,
      prompt_text: activeVersion.proposed_prompt_text,
      status: 'active',
      activated_at: new Date().toISOString(),
      approved_by: session.user.email,
    })

  if (insertError) {
    // Compensate: restore the archived version to active so we don't lose the active prompt
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase.from('bundle_prompt_versions') as any)
      .update({ status: 'active' })
      .eq('id', activeVersion.id)
    return NextResponse.json({ error: 'Failed to insert new version — active version restored' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, new_version: activeVersion.version + 1 })
}

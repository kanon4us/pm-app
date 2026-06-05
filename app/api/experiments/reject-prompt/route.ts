import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export async function POST(_req: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.from('bundle_prompt_versions') as any)
    .update({ proposed_prompt_text: null, change_summary: null })
    .eq('status', 'active')

  if (error) {
    return NextResponse.json({ error: 'Failed to clear proposal' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

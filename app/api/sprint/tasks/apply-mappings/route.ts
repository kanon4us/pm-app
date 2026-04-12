import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

// POST /api/sprint/tasks/apply-mappings
// Body: { mappings: Record<fieldName, dbField> }
// Delegates entirely to a Postgres function — one SQL pass across all tasks.
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { mappings }: { mappings: Record<string, string> } = await req.json()
  if (!Object.keys(mappings).length) return NextResponse.json({ updated: 0 })

  const supabase = await getSupabaseServiceClient()
  const { data, error } = await supabase.rpc('apply_field_mappings', { mappings })

  if (error) {
    console.error('[apply-mappings] rpc error:', error)
    return NextResponse.json({ error: error.message, details: error }, { status: 500 })
  }
  return NextResponse.json({ updated: data })
}

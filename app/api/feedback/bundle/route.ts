import { NextRequest, NextResponse } from 'next/server'
import { verifyFeedbackToken } from '@/lib/feedback/token'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

interface FeedbackResponse {
  task_id: string
  sprint_id?: string
  bundle_version: number
  ratings: {
    kickoff_prompt: number
    user_stories: number
    dev_skill: number
  }
  comments?: string
}

interface RequestBody {
  token: string
  email: string
  responses: FeedbackResponse[]
}

export async function POST(req: NextRequest) {
  const body = await req.json() as Partial<RequestBody>

  if (!body.token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 })
  }

  try {
    verifyFeedbackToken(body.token)
  } catch {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  }

  if (!body.email || !body.responses?.length) {
    return NextResponse.json({ ok: true })
  }

  for (const r of body.responses) {
    const { kickoff_prompt, user_stories, dev_skill } = r.ratings ?? {}
    if (
      ![kickoff_prompt, user_stories, dev_skill].every(
        (v) => typeof v === 'number' && v >= 1 && v <= 5,
      )
    ) {
      return NextResponse.json({ error: 'Each rating must be between 1 and 5' }, { status: 400 })
    }
  }

  const supabase = await getSupabaseServiceClient()

  const rows = body.responses.map((r) => ({
    task_id: r.task_id,
    sprint_id: r.sprint_id ?? null,
    bundle_version: r.bundle_version,
    developer_email: body.email!,
    kickoff_prompt_rating: r.ratings.kickoff_prompt,
    user_stories_rating: r.ratings.user_stories,
    dev_skill_rating: r.ratings.dev_skill,
    comments: r.comments ?? null,
  }))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.from('bundle_feedback') as any)
    .upsert(rows, { onConflict: 'task_id,developer_email' })

  if (error) {
    console.error('[feedback/bundle] upsert error:', error.message)
    return NextResponse.json({ error: 'Failed to save feedback' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

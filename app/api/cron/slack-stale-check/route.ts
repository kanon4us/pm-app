import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildSlackClient } from '@/lib/slack/client'

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const supabase = await getSupabaseServiceClient()
  const slackToken = process.env.SLACK_BOT_TOKEN
  if (!slackToken) {
    console.error('[stale-check] SLACK_BOT_TOKEN is not set')
    return NextResponse.json({ nudged: 0 }, { status: 500 })
  }
  const slack = buildSlackClient(slackToken)

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

  const { data: stale, error: queryError } = await supabase
    .from('slack_issues')
    .select('thread_ts, channel_id, status')
    .in('status', ['gathering', 'confirming'])
    .lt('updated_at', oneHourAgo)

  if (queryError) {
    console.error('[stale-check] query failed:', queryError)
    return NextResponse.json({ nudged: 0 }, { status: 500 })
  }

  if (!stale?.length) return NextResponse.json({ nudged: 0 })

  let nudged = 0
  await Promise.all(
    stale.map((issue: { thread_ts: string; channel_id: string; status: string }) =>
      slack
        .postMessage(
          issue.channel_id,
          "Still there? I'm ready to finish documenting this whenever you are. Just reply to this thread and we'll pick up where we left off.",
          issue.thread_ts,
        )
        .then(() => { nudged++ })
        .catch((err: unknown) =>
          console.error('[stale-check] postMessage failed:', issue.thread_ts, err)
        )
    )
  )

  return NextResponse.json({ nudged })
}

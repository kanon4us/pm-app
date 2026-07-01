// app/api/bot/slack/interactions/route.ts
//
// Slack interactions webhook for the Weekly Vault Consolidation feature.
//
// Slack sends interaction payloads as application/x-www-form-urlencoded with a
// single `payload` field containing JSON.
//
// CRITICAL CONTRACT: this handler MUST ack within 3 seconds and MUST NOT call
// any GitHub / git-write function. Heavy work is deferred to the write consumer
// at /api/vault/consolidation/write via QStash.
//
// Signature verification reuses @/lib/slack/verify exactly as the existing
// webhooks/slack route does.

import { NextRequest, NextResponse } from 'next/server'
import { verifySlackSignature } from '@/lib/slack/verify'
import { buildSlackClient } from '@/lib/slack/client'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { enqueueToQueue } from '@/lib/queue/client'

// Action IDs that trigger the "Resolve overlap" modal instead of a write.
const MERGE_DECISION_ACTIONS = new Set(['merge-canonical', 'distinct'])

// The modal shown when an author needs to choose between merge vs. distinct.
const mergeModalView: Record<string, unknown> = {
  type: 'modal',
  callback_id: 'vault_resolve_overlap',
  title: { type: 'plain_text', text: 'Resolve overlap' },
  close: { type: 'plain_text', text: 'Cancel' },
  blocks: [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'How should this overlap be resolved?',
      },
    },
    {
      type: 'actions',
      block_id: 'resolve_choice',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Merge into canonical' },
          action_id: 'resolve_merge',
          style: 'primary',
          value: 'merge',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Keep as distinct' },
          action_id: 'resolve_distinct',
          value: 'distinct',
        },
      ],
    },
  ],
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Read raw body (required for HMAC verification)
  const rawBody = await req.text()
  const timestamp = req.headers.get('x-slack-request-timestamp') ?? ''
  const signature = req.headers.get('x-slack-signature') ?? ''

  if (
    !verifySlackSignature(
      rawBody,
      timestamp,
      signature,
      process.env.SLACK_SIGNING_SECRET ?? '',
    )
  ) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // 2. Decode form body and parse the `payload` JSON field
  const params = new URLSearchParams(rawBody)
  const payloadStr = params.get('payload')
  if (!payloadStr) {
    return NextResponse.json({ ok: true })
  }

  let payload: {
    type: string
    trigger_id: string
    user: { id: string }
    actions: Array<{ action_id: string; block_id: string; value?: string }>
    response_url: string
  }
  try {
    payload = JSON.parse(payloadStr)
  } catch {
    return NextResponse.json({ error: 'Invalid payload JSON' }, { status: 400 })
  }

  // Only handle block_actions
  if (payload.type !== 'block_actions') {
    return NextResponse.json({ ok: true })
  }

  const action = payload.actions[0]
  if (!action) {
    return NextResponse.json({ ok: true })
  }

  const { action_id: actionId, block_id: blockId } = action
  const triggerId = payload.trigger_id
  const responseUrl = payload.response_url

  // 3a. Merge/distinct decision: open the "Resolve overlap" modal and return.
  //     NO GitHub writes happen here — the modal itself will produce a follow-up
  //     interaction that goes through the write consumer.
  if (MERGE_DECISION_ACTIONS.has(actionId)) {
    const slack = buildSlackClient(process.env.SLACK_BOT_TOKEN ?? '')
    await slack.openModal(triggerId, mergeModalView)
    return NextResponse.json({ ok: true })
  }

  // 3b. All other actions: look up the session by block_id and enqueue the write.
  //     block_id encodes: runId|docPath|questionId
  const parts = blockId.split('|')
  const runId = parts[0] ?? ''
  const docPath = parts.slice(1, -1).join('|') // handles paths that might contain '|' (unlikely, but safe)

  // In practice, block_id is always `runId|docPath|questionId` with exactly 3 pipe-delimited segments.
  // Use runId + docPath to locate the session row.
  const supabase = await getSupabaseServiceClient()
  const { data: session } = await supabase
    .from('vault_review_sessions')
    .select('id')
    .eq('run_id', runId)
    .eq('doc_path', docPath)
    .single()

  if (!session) {
    // Log and ack — we must return 200 quickly regardless.
    console.warn('[vault-interactions] session not found for block_id:', blockId)
    return NextResponse.json({ ok: true })
  }

  const writesUrl =
    (process.env.VAULT_APP_BASE_URL ?? '') + '/api/vault/consolidation/write'

  // Route through the serialized `vault-writes` queue (parallelism=1) so
  // concurrent answers commit to the shared weekly branch one-at-a-time and
  // can't collide on a non-fast-forward 422.
  await enqueueToQueue('vault-writes', writesUrl, {
    sessionId: (session as { id: string }).id,
    actionId,
    responseUrl,
  })

  return NextResponse.json({ ok: true })
}

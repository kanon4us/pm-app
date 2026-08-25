// app/api/vault/consolidation/write/route.ts
// QStash-triggered serialized git-write consumer.
//
// Receives a single { sessionId, actionId, responseUrl? } message from the
// vault-writes queue (parallelism=1, configured in Upstash console), applies
// the reviewed action to the vault file via an optimistic-locked frontmatter
// patch, then updates the session status and optionally refreshes the Slack card.

import { NextRequest, NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/queue/client'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { readVaultFile, writeVaultFile, getBranchSha, createBranch } from '@/lib/github/vault'
import { buildSlackClient } from '@/lib/slack/client'
import { applyAction, GitWriteDeps } from '@/lib/vault/git-writes'

export const maxDuration = 60

// ── Slack card refresh ────────────────────────────────────────────────────────

/**
 * Update the Block Kit card in place via Slack's response_url.
 *
 * Deliberately swallows every failure. By the time this runs the commit has
 * landed and the session status is written, but QStash redelivers on any
 * non-2xx — so letting a Slack error escape would replay a write that already
 * succeeded. A stale card is much cheaper than that.
 */
async function refreshSlackCard(
  responseUrl: string,
  docPath: string,
  actionId: string,
  aborted: boolean,
  sessionId: string,
): Promise<void> {
  const text = aborted
    ? `⚠️ *${docPath}*\nThis file was changed after this card was generated. Your action was not applied — please re-check the document.`
    : `✓ *${docPath}*\nAction \`${actionId}\` recorded. The vault PR will include this change.`
  const fallback = aborted
    ? 'Action not applied — document changed since review card was generated.'
    : `✓ Action recorded: ${actionId}`

  try {
    const slack = buildSlackClient(process.env.SLACK_BOT_TOKEN ?? '')
    await slack.updateViaResponseUrl(
      responseUrl,
      [{ type: 'section', text: { type: 'mrkdwn', text } }],
      fallback,
    )
  } catch (err) {
    console.error(`[vault/write] Slack card refresh failed for session ${sessionId}:`, err)
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Verify QStash signature
  const signature = req.headers.get('upstash-signature') ?? ''
  const rawBody = await req.text()
  const url = req.url

  const valid = await verifyQstashSignature(signature, rawBody, url)
  if (!valid) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // 2. Parse body
  let sessionId: string
  let actionId: string
  let responseUrl: string | undefined
  try {
    const parsed = JSON.parse(rawBody) as {
      sessionId: string
      actionId: string
      responseUrl?: string
    }
    sessionId = parsed.sessionId
    actionId = parsed.actionId
    responseUrl = parsed.responseUrl
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  if (!sessionId || !actionId) {
    return NextResponse.json({ error: 'sessionId and actionId required' }, { status: 400 })
  }

  // 3. Load the vault_review_sessions row
  const supabase = await getSupabaseServiceClient()
  const { data: session, error: sessionError } = await supabase
    .from('vault_review_sessions')
    .select('*')
    .eq('id', sessionId)
    .single()

  if (sessionError || !session) {
    console.error('[vault/write] session not found', sessionId, sessionError)
    return NextResponse.json({ error: 'Session not found' }, { status: 200 }) // 200 to ack to QStash
  }

  // Replay guard. QStash redelivers on any non-2xx — including a response we
  // failed to return *after* the commit landed — so this handler can run twice
  // for one button click. Re-applying would compare baseBlobSha against the SHA
  // this run itself produced, abort as 'stale', and downgrade a completed
  // review to 'aborted' while warning the author their own edit was rejected.
  // A session that already reached a terminal state is done; just ack.
  if (session.status === 'answered' || session.status === 'aborted') {
    return NextResponse.json({ result: 'already-processed', status: session.status }, { status: 200 })
  }

  // Retrieve the GitHub token from env (service-level token for consolidation writes)
  const ghToken = process.env.GITHUB_TOKEN ?? ''
  if (!ghToken) {
    console.error('[vault/write] GITHUB_TOKEN not set')
    return NextResponse.json({ error: 'GitHub token not configured' }, { status: 200 })
  }

  // 4. Build GitWriteDeps wired to lib/github/vault.ts
  const deps: GitWriteDeps = {
    async ensureBranch(branch: string): Promise<void> {
      // createBranch is idempotent — returns true if branch exists (422) or was created
      await createBranch(ghToken, branch)
    },

    async currentBlobSha(branch: string, path: string): Promise<string> {
      const file = await readVaultFile(ghToken, path, branch)
      // If the file doesn't exist on the branch yet, return empty string so
      // the optimistic-lock check can still run (baseBlobSha would also need to be '').
      return file?.sha ?? ''
    },

    async readFile(branch: string, path: string): Promise<string> {
      const file = await readVaultFile(ghToken, path, branch)
      return file?.content ?? ''
    },

    async writeFile(args: {
      branch: string
      path: string
      content: string
      message: string
    }): Promise<void> {
      const result = await writeVaultFile(
        ghToken,
        args.path,
        args.content,
        args.message,
        args.branch,
      )
      if (result === null) {
        // writeVaultFile logs the status; surface the status code if available
        // so applyAction's 422-detection logic can catch it when needed.
        // The actual GitHub status is logged inside writeVaultFile, but we
        // need to propagate a recognisable error for the retry path.
        // In production, writeVaultFile returns null on any non-ok status —
        // including 422.  Throw an error containing '422' so applyAction retries.
        throw new Error('writeVaultFile returned null — possible 422 non-fast-forward or auth error')
      }
    },
  }

  // 5. Apply the action
  const result = await applyAction(
    {
      branch: session.branch,
      path: session.doc_path,
      baseBlobSha: session.base_blob_sha,
      actionId,
    },
    deps,
  )

  // 6. Update session status
  const newStatus = result.aborted ? 'aborted' : 'answered'
  await supabase
    .from('vault_review_sessions')
    .update({ status: newStatus })
    .eq('id', sessionId)

  // 7. Optionally refresh the Slack card. Best-effort — see refreshSlackCard.
  if (responseUrl) {
    await refreshSlackCard(responseUrl, session.doc_path, actionId, result.aborted, sessionId)
  }

  return NextResponse.json({ result: result.aborted ? 'aborted' : 'ok' }, { status: 200 })
}

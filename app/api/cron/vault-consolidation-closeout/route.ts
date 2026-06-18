// app/api/cron/vault-consolidation-closeout/route.ts
// Weekly close-out cron: opens ONE consolidated PR for the current ISO week.
// Idempotent: if pr_url is already set on the run row, returns immediately.
import { NextRequest, NextResponse } from 'next/server'
import { isoWeek } from '@/app/api/cron/vault-consolidation/route'
import { buildPrBody, staleSupportItems } from '@/lib/vault/closeout-body'
import type { CloseoutItem } from '@/lib/vault/closeout-body'
import { buildSlackClient } from '@/lib/slack/client'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export const maxDuration = 60

// ---------------------------------------------------------------------------
// GitHub constants (mirrors vault-consolidation/route.ts)
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com'
const VAULT_REPO = process.env.GITHUB_VAULT_REPO ?? 'ViscapMedia/documentation'

function githubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  // ── auth guard (same pattern as vault-consolidation cron) ─────────────────
  const auth = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  const vidfKey = process.env.VIDF_HOOK_API_KEY?.trim()
  const isAuthorized =
    (cronSecret && auth === `Bearer ${cronSecret}`) ||
    (vidfKey && auth === `Bearer ${vidfKey}`)
  if (!isAuthorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const runId = isoWeek(new Date())
  const token = process.env.GITHUB_VAULT_TOKEN ?? ''
  const supabase = await getSupabaseServiceClient()

  // ── 1. Load vault_review_runs row ─────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: runRow, error: runError } = await (supabase.from('vault_review_runs') as any)
    .select('run_id, pr_url')
    .eq('run_id', runId)
    .maybeSingle()

  if (runError) {
    console.error('[vault-closeout] failed to load run row:', runError)
  }

  // ── 2. Idempotency: if PR already open, bail out ──────────────────────────
  if (runRow?.pr_url) {
    return NextResponse.json({ alreadyOpen: true })
  }

  // ── 3. Load all sessions for this run ─────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: sessions, error: sessionsError } = await (supabase.from('vault_review_sessions') as any)
    .select('doc_path, author_email, status')
    .eq('run_id', runId)

  if (sessionsError) {
    console.error('[vault-closeout] failed to load sessions:', sessionsError)
  }

  const rawSessions: Array<{
    doc_path: string
    author_email: string
    status: string
    audience?: string
  }> = sessions ?? []

  // ── 4. Map sessions → CloseoutItems ───────────────────────────────────────
  // v1 simplification: the vault_review_sessions schema does not include
  // 'action' or 'audience' columns. 'action' defaults to 'updated' for all
  // answered rows. 'audience' is read from the row if the property is present
  // (forward-compatible with a future schema addition); otherwise undefined.
  const items: CloseoutItem[] = rawSessions.map((row) => ({
    authorKey: row.author_email,
    docPath: row.doc_path,
    action: 'updated',
    answered: row.status === 'answered',
    audience: row.audience,
  }))

  // ── 5. Build PR body ──────────────────────────────────────────────────────
  const body = buildPrBody(items)

  // ── 6. Open the consolidated PR ──────────────────────────────────────────
  const prRes = await fetch(`${GITHUB_API}/repos/${VAULT_REPO}/pulls`, {
    method: 'POST',
    headers: githubHeaders(token),
    body: JSON.stringify({
      title: `Weekly vault consolidation ${runId}`,
      head: `vault-consolidation/${runId}`,
      base: 'main',
      body,
    }),
  })

  if (!prRes.ok) {
    const errText = await prRes.text().catch(() => '')
    console.error(`[vault-closeout] GitHub PR creation failed: ${prRes.status} ${errText.slice(0, 300)}`)
    return NextResponse.json(
      { error: 'Failed to create PR', status: prRes.status },
      { status: 502 }
    )
  }

  const prData = await prRes.json()
  const prUrl: string = prData.html_url

  // ── 7. Save pr_url to the run row ────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updateError } = await (supabase.from('vault_review_runs') as any)
    .update({ pr_url: prUrl })
    .eq('run_id', runId)

  if (updateError) {
    console.error('[vault-closeout] failed to save pr_url:', updateError)
  }

  // ── 8. Ping PM if there are stale support items ───────────────────────────
  const stale = staleSupportItems(items)
  if (stale.length > 0) {
    const slackToken = process.env.SLACK_BOT_TOKEN
    const pmSlackId = process.env.PM_SLACK_ID
    if (slackToken && pmSlackId) {
      const slack = buildSlackClient(slackToken)
      const staleLines = stale
        .map((item) => `• \`${item.docPath}\` (owner: ${item.authorKey})`)
        .join('\n')
      const text = `*Vault Consolidation ${runId} — Stale Support Docs*\n\nThese support docs went unanswered this cycle:\n${staleLines}\n\nPR: ${prUrl}`
      await slack.dm(
        pmSlackId,
        [
          {
            type: 'section',
            text: { type: 'mrkdwn', text },
          },
        ],
        text,
      )
    }
  }

  return NextResponse.json({ prUrl })
}

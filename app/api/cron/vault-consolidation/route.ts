// app/api/cron/vault-consolidation/route.ts
// Weekly trigger cron: snapshot the vault, report changes, fan-out stable docs to /process.
import { NextRequest, NextResponse } from 'next/server'
import { buildSnapshot, storeSnapshot } from '@/lib/vault/snapshot'
import type { SnapshotDeps } from '@/lib/vault/snapshot'
import { isStable, changeReport } from '@/lib/vault/changes'
import type { VaultCommit } from '@/lib/vault/changes'
import { enqueue } from '@/lib/queue/client'
import { buildSlackClient } from '@/lib/slack/client'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { auditDoc, SUPPORT_CRITICAL_PATHS_DEFAULT } from '@/lib/vault/audit'
import { buildQuestions } from '@/lib/vault/questions'
import { resolveAuthor } from '@/lib/vault/author-routing'
import { buildManifest, serializeManifest, manifestContentEquals, manifestLooksDegraded, MANIFEST_PATH } from '@/lib/vault/manifest'
import type { VaultManifest } from '@/lib/vault/manifest'
import { readVaultFile, writeVaultFile } from '@/lib/github/vault'
import { mapWithConcurrency } from '@/lib/vault/concurrency'

export const maxDuration = 300

// ---------------------------------------------------------------------------
// Helper: ISO week string, e.g. "2026-W25"
// Uses ISO 8601 week-numbering (Monday = first day of week).
// ---------------------------------------------------------------------------

export function isoWeek(date: Date): string {
  // Work on a UTC copy to avoid timezone edge-cases in the algorithm.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  // ISO week: Thursday of the week determines the year.
  // Set to nearest Thursday (day 4); Monday = 1, Sunday = 7.
  const dayNum = d.getUTCDay() || 7          // 0 (Sun) → 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)  // shift to Thursday of this week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7
  )
  const year = d.getUTCFullYear()
  return `${year}-W${String(weekNo).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// GitHub deps builder (isolated so tests can mock snapshot/enqueue without
// needing real GitHub connectivity).
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com'
const VAULT_REPO = process.env.GITHUB_VAULT_REPO ?? 'ViscapMedia/documentation'
const VAULT_BRANCH = 'main'

function githubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

// ---------------------------------------------------------------------------
// Rate-limit-aware GitHub fetch
//
// The snapshot costs ~2 requests per vault doc (one content read, one
// last-commit lookup). At that volume GitHub's *secondary* rate limit — the
// burst/concurrency one, separate from the 5,000/hr primary quota — is the
// binding constraint. It answers 429, or 403 with `retry-after`, and a caller
// that neither backs off nor bounds concurrency simply converts the whole run
// into failed requests.
// ---------------------------------------------------------------------------

/** Max concurrent GitHub calls per phase. Deliberately well under the ~100 GitHub tolerates. */
const GITHUB_CONCURRENCY = 8
/** Retries per request when GitHub asks us to slow down. */
const GITHUB_MAX_RETRIES = 4
/** Ceiling on a single backoff sleep — the cron's own budget is maxDuration (300s). */
const GITHUB_MAX_BACKOFF_MS = 15_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * True when GitHub is throttling us rather than reporting a real error.
 * Covers 429 and the 403-with-retry-after / 403-with-zero-remaining variants
 * the secondary limit uses.
 */
function isThrottled(res: Response): boolean {
  if (res.status === 429) return true
  if (res.status !== 403) return false
  return (
    res.headers.get('retry-after') !== null ||
    res.headers.get('x-ratelimit-remaining') === '0'
  )
}

/** How long to wait before retrying, honouring GitHub's own hint when it gives one. */
function backoffMs(res: Response, attempt: number): number {
  const retryAfter = Number(res.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, GITHUB_MAX_BACKOFF_MS)
  }
  const reset = Number(res.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0) {
    const waitMs = reset * 1000 - Date.now()
    if (waitMs > 0) return Math.min(waitMs, GITHUB_MAX_BACKOFF_MS)
  }
  // Exponential backoff with jitter so the pool's workers don't resynchronise.
  const base = Math.min(500 * 2 ** attempt, GITHUB_MAX_BACKOFF_MS)
  return base / 2 + Math.random() * (base / 2)
}

/** GET a GitHub API URL, retrying with backoff while GitHub is throttling us. */
async function githubFetch(url: string, token: string): Promise<Response> {
  let res = await fetch(url, { headers: githubHeaders(token) })
  for (let attempt = 0; isThrottled(res) && attempt < GITHUB_MAX_RETRIES; attempt++) {
    await sleep(backoffMs(res, attempt))
    res = await fetch(url, { headers: githubHeaders(token) })
  }
  return res
}

// ---------------------------------------------------------------------------
// GitHub deps builder (isolated so tests can mock snapshot/enqueue without
// needing real GitHub connectivity).
// ---------------------------------------------------------------------------

/** Per-run counters, so a partially-degraded snapshot is visible instead of silent. */
export interface GithubDepsStats {
  /** Docs whose content read failed — they are missing from the snapshot entirely. */
  contentFailures: number
  /** Docs whose last-commit lookup failed — treated as recently-touched, so skipped this run. */
  commitFailures: number
}

export interface GithubDeps extends SnapshotDeps {
  stats: GithubDepsStats
}

/**
 * Build a SnapshotDeps implementation backed by real GitHub REST calls.
 * Exported so integration / smoke tests can call it directly.
 */
export function buildGithubDeps(token: string): GithubDeps {
  const stats: GithubDepsStats = { contentFailures: 0, commitFailures: 0 }

  return {
    stats,

    /**
     * List all .md blob paths via the git trees API (single call, recursive),
     * then fetch each file's content with bounded concurrency.
     */
    async listDocs() {
      // GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1
      const treeRes = await githubFetch(
        `${GITHUB_API}/repos/${VAULT_REPO}/git/trees/${VAULT_BRANCH}?recursive=1`,
        token
      )
      if (!treeRes.ok) {
        throw new Error(
          `[vault-cron] git trees fetch failed: ${treeRes.status} ${await treeRes.text().catch(() => '')}`
        )
      }
      const treeData: { tree: Array<{ path: string; type: string; sha: string }> } =
        await treeRes.json()

      const blobs = treeData.tree.filter(
        (item) => item.type === 'blob' && item.path.endsWith('.md')
      )

      type DocContent = { path: string; content: string; blobSha: string }

      const fetched = await mapWithConcurrency<
        { path: string; type: string; sha: string },
        DocContent | null
      >(blobs, GITHUB_CONCURRENCY, async ({ path, sha }) => {
        const contentRes = await githubFetch(
          `${GITHUB_API}/repos/${VAULT_REPO}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${VAULT_BRANCH}`,
          token
        )
        if (!contentRes.ok) {
          stats.contentFailures++
          return null
        }
        const data: { content?: string; type?: string } = await contentRes.json()
        if (data.type !== 'file' || !data.content) {
          stats.contentFailures++
          return null
        }
        const content = Buffer.from(data.content, 'base64').toString('utf-8')
        return { path, content, blobSha: sha }
      })

      return fetched.filter((r): r is DocContent => r !== null)
    },

    /**
     * Fetch the most recent commit for a path.
     * GET /repos/{owner}/{repo}/commits?path=<path>&per_page=1
     *
     * On failure we report the doc as committed *now*. That is the fail-safe
     * direction: `isStable` then reads it as freshly-touched and skips it this
     * run, to be picked up next week. The previous epoch fallback did the
     * opposite of what its comment claimed — epoch is maximally old, so every
     * throttled doc was marked stable AND lost its committer email, routing a
     * DM about it to the PM fallback.
     */
    async lastCommit(path: string) {
      const unknown = () => {
        stats.commitFailures++
        return { iso: new Date().toISOString(), email: 'unknown' }
      }

      const res = await githubFetch(
        `${GITHUB_API}/repos/${VAULT_REPO}/commits?path=${encodeURIComponent(path)}&per_page=1`,
        token
      )
      if (!res.ok) return unknown()

      const data: Array<{
        commit: { committer: { date: string }; author: { email: string } }
      }> = await res.json()
      const first = data[0]
      if (!first) return unknown()
      return {
        iso: first.commit.committer.date,
        email: first.commit.author.email,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  // ── auth guard (same pattern as sop-analysis) ─────────────────────────────
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
  const token = process.env.GITHUB_TOKEN ?? ''

  // Validation controls (query params):
  //   ?dryRun=1  → read-only: build the report (snapshot + audit + questions +
  //                routing) and RETURN it. No snapshot store, no Slack, no
  //                enqueue, no DB writes. Needs only GITHUB_TOKEN.
  //   ?limit=N   → cap how many stable docs are processed/enqueued (scopes the
  //                first live run so it can't fan out to the whole team).
  const { searchParams } = new URL(req.url)
  const dryRun = searchParams.get('dryRun') === '1' || searchParams.get('dryRun') === 'true'
  const limitParam = Number(searchParams.get('limit'))
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : Infinity

  const now = new Date()

  // 1. Build snapshot via injected (real) GitHub deps
  const deps = buildGithubDeps(token)
  const snap = await buildSnapshot(runId, deps)

  // Surface partial GitHub failures. Both counters degrade the run silently
  // otherwise: a content failure drops the doc from the snapshot, a commit
  // failure makes the doc look freshly-touched so it is skipped this week.
  const { contentFailures, commitFailures } = deps.stats
  if (contentFailures > 0 || commitFailures > 0) {
    console.error(
      `[vault-cron] degraded snapshot for ${runId}: ${contentFailures} content read(s) and ` +
        `${commitFailures} commit lookup(s) failed after retries (${snap.docs.length} docs in snapshot)`
    )
  }
  const githubFailures =
    contentFailures > 0 || commitFailures > 0
      ? { githubFailures: { contentFailures, commitFailures } }
      : {}

  // Stable docs (the consolidation candidates), capped by `limit`.
  const stableDocs = snap.docs.filter((d) => isStable(d.lastCommitISO, now)).slice(0, limit)

  // ── DRY RUN: report what WOULD happen, with zero side effects ──────────────
  if (dryRun) {
    const backlinks = new Map(snap.backlinks.map(([k, v]) => [k, new Set(v)]))
    const slackMap: Record<string, string> = JSON.parse(process.env.VAULT_AUTHOR_SLACK_MAP ?? '{}')
    const pmFallback = process.env.PM_SLACK_ID ?? ''

    const docs = stableDocs.map((doc) => {
      const audit = auditDoc(doc, backlinks, SUPPORT_CRITICAL_PATHS_DEFAULT)
      const questions = buildQuestions(audit)
      const route = resolveAuthor(doc, slackMap, pmFallback)
      return {
        path: doc.path,
        lastCommitISO: doc.lastCommitISO,
        supportCritical: audit.supportCritical,
        signals: audit.signals,
        questions: questions.map((q) => ({ id: q.id, text: q.text })),
        author: { key: route.key, slackId: route.slackId || '(unmapped → PM fallback)' },
      }
    })

    return NextResponse.json({
      dryRun: true,
      runId,
      ...githubFailures,
      totalDocs: snap.docs.length,
      stableDocs: stableDocs.length,
      withQuestions: docs.filter((d) => d.questions.length > 0).length,
      docs,
    })
  }

  // 2. Persist snapshot
  const supabase = await getSupabaseServiceClient()
  await storeSnapshot(supabase, snap)

  // 2b. Refresh MANIFEST.json (Tier-1 vault index) — derived from the same
  // snapshot, committed straight to main, never fatal to the run.
  // Spec: docs/superpowers/specs/2026-07-03-vault-manifest-design.md
  try {
    const manifest = buildManifest(snap)
    const existing = await readVaultFile(token, MANIFEST_PATH)
    let unchanged = false
    let parsedExisting: VaultManifest | null = null
    if (existing) {
      try {
        parsedExisting = JSON.parse(existing.content)
        unchanged = manifestContentEquals(manifest, parsedExisting)
      } catch {
        // existing manifest unparseable → overwrite it
        parsedExisting = null
      }
    }
    if (manifestLooksDegraded(manifest, parsedExisting)) {
      console.error(`[vault-cron] manifest looks degraded (docs=${snap.docs.length}) — skipping write`)
    } else if (!unchanged) {
      const written = await writeVaultFile(token, MANIFEST_PATH, serializeManifest(manifest), 'chore: refresh vault manifest', VAULT_BRANCH)
      if (!written) console.error('[vault-cron] manifest write failed (writeVaultFile returned null)')
    }
  } catch (err) {
    console.error('[vault-cron] manifest step failed:', err)
  }

  // 3. Insert vault_review_runs row
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: runInsertError } = await (supabase.from('vault_review_runs') as any).insert({
    run_id: runId,
    snapshot_ref: runId,
  })
  if (runInsertError) {
    console.error('[vault-cron] vault_review_runs insert failed:', runInsertError)
  }

  // 4. Build a change report from all docs treated as commits (simple digest)
  //    Real "since last run" diffing would require the previous snapshot; for
  //    now we report every doc as a VaultCommit so the Slack digest always
  //    has the full doc list, matching the spec's intent of a "digest".
  const allCommits: VaultCommit[] = snap.docs.map((d) => ({
    path: d.path,
    changeType: 'modified',
  }))
  const report = changeReport(allCommits)

  // 5. Post Slack change-report digest
  const slackToken = process.env.SLACK_BOT_TOKEN
  const channel = process.env.VAULT_CONSOLIDATION_SLACK_CHANNEL
  if (slackToken && channel) {
    try {
      const slack = buildSlackClient(slackToken)
      const lines = [
        `*Vault Weekly Consolidation — ${runId}*`,
        `Snapshot: ${snap.docs.length} docs scanned`,
        `Added: ${report.added.length} · Modified: ${report.modified.length} · Deleted: ${report.deleted.length}`,
      ]
      await slack.postMessage(channel, lines.join('\n'))
    } catch (err) {
      console.error('[vault-cron] slack digest failed:', err)
    }
  }

  // 6. Fan-out stable docs (already filtered + capped by `limit`) to /process.
  // Never fatal: the snapshot + manifest are already committed, so a broken
  // QStash config (e.g. missing QSTASH_TOKEN) must not 500 the whole cron.
  const baseUrl = process.env.VAULT_APP_BASE_URL ?? ''
  const processUrl = `${baseUrl}/api/vault/consolidation/process`

  let enqueued = 0
  let enqueueFailed = 0
  for (const doc of stableDocs) {
    try {
      await enqueue(processUrl, { runId, docPath: doc.path })
      enqueued++
    } catch (err) {
      enqueueFailed++
      if (enqueueFailed === 1) {
        console.error(`[vault-cron] enqueue failed for ${doc.path}:`, err)
      }
    }
  }
  if (enqueueFailed > 0) {
    console.error(`[vault-cron] fan-out: ${enqueueFailed}/${stableDocs.length} enqueues failed`)
  }

  return NextResponse.json({
    result: 'ok',
    runId,
    ...githubFailures,
    enqueued,
    ...(enqueueFailed > 0 ? { enqueueFailed } : {}),
  })
}

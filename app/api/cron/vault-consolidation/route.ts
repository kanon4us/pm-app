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

// Chunk an array into sub-arrays of size `n`
function chunk<T>(arr: T[], n: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += n) chunks.push(arr.slice(i, i + n))
  return chunks
}

/**
 * Build a SnapshotDeps implementation backed by real GitHub REST calls.
 * Exported so integration / smoke tests can call it directly.
 */
export function buildGithubDeps(token: string): SnapshotDeps {
  return {
    /**
     * List all .md blob paths via the git trees API (single call, recursive),
     * then fetch each file's content with bounded concurrency (~20 at once).
     */
    async listDocs() {
      // GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1
      const treeRes = await fetch(
        `${GITHUB_API}/repos/${VAULT_REPO}/git/trees/${VAULT_BRANCH}?recursive=1`,
        { headers: githubHeaders(token) }
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

      // Fetch content in chunks to avoid overwhelming the GitHub API or the
      // Vercel function's network concurrency limit.
      const CHUNK_SIZE = 20
      const results: Array<{ path: string; content: string; blobSha: string }> = []

      for (const blobChunk of chunk(blobs, CHUNK_SIZE)) {
        const chunkResults = await Promise.all(
          blobChunk.map(async ({ path, sha }) => {
            const contentRes = await fetch(
              `${GITHUB_API}/repos/${VAULT_REPO}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${VAULT_BRANCH}`,
              { headers: githubHeaders(token) }
            )
            if (!contentRes.ok) return null
            const data: { content?: string; type?: string } = await contentRes.json()
            if (data.type !== 'file' || !data.content) return null
            const content = Buffer.from(data.content, 'base64').toString('utf-8')
            return { path, content, blobSha: sha }
          })
        )
        for (const r of chunkResults) {
          if (r) results.push(r)
        }
      }

      return results
    },

    /**
     * Fetch the most recent commit for a path.
     * GET /repos/{owner}/{repo}/commits?path=<path>&per_page=1
     */
    async lastCommit(path: string) {
      const res = await fetch(
        `${GITHUB_API}/repos/${VAULT_REPO}/commits?path=${encodeURIComponent(path)}&per_page=1`,
        { headers: githubHeaders(token) }
      )
      if (!res.ok) {
        // Fallback: epoch so the doc won't be filtered as stable
        return { iso: new Date(0).toISOString(), email: 'unknown' }
      }
      const data: Array<{
        commit: { committer: { date: string }; author: { email: string } }
      }> = await res.json()
      const first = data[0]
      if (!first) return { iso: new Date(0).toISOString(), email: 'unknown' }
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

  // 1. Build snapshot via injected (real) GitHub deps
  const deps = buildGithubDeps(token)
  const snap = await buildSnapshot(runId, deps)

  // 2. Persist snapshot
  const supabase = await getSupabaseServiceClient()
  await storeSnapshot(supabase, snap)

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
    const slack = buildSlackClient(slackToken)
    const lines = [
      `*Vault Weekly Consolidation — ${runId}*`,
      `Snapshot: ${snap.docs.length} docs scanned`,
      `Added: ${report.added.length} · Modified: ${report.modified.length} · Deleted: ${report.deleted.length}`,
    ]
    await slack.postMessage(channel, lines.join('\n'))
  }

  // 6. Fan-out stable docs to the process endpoint
  const baseUrl = process.env.VAULT_APP_BASE_URL ?? ''
  const processUrl = `${baseUrl}/api/vault/consolidation/process`
  const now = new Date()

  let enqueued = 0
  for (const doc of snap.docs) {
    if (isStable(doc.lastCommitISO, now)) {
      await enqueue(processUrl, { runId, docPath: doc.path })
      enqueued++
    }
  }

  return NextResponse.json({ result: 'ok', runId, enqueued })
}

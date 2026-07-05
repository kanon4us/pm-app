// app/api/cron/design-index-sync/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { applyInboxToIndex, type InboxRow, type PendingFile } from '@/lib/design-index/inbox'
import { readRepoFile, forceUpdateBranch, ensurePrWithAutoMerge } from '@/lib/github/design-index-pr'
import { pathExists as ghPathExists } from '@/lib/github/repos'
import type { DesignIndex } from '@/lib/design-index/types'

export const maxDuration = 60
const REPO = process.env.GITHUB_REPO ?? 'kanon4us/pm-app'
const BRANCH = 'design-index-sync'

function staticPrefix(glob: string): string {
  const i = glob.indexOf('*')
  return (i === -1 ? glob : glob.slice(0, i)).replace(/\/+$/, '')
}
export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest) {
  // Vercel's scheduler marks cron invocations with an `x-vercel-cron` header,
  // which Vercel strips from any external request — so it's a trustworthy signal.
  // Accept those; otherwise require the Bearer secret (for manual triggers).
  const isVercelCron = req.headers.get('x-vercel-cron') != null
  const auth = req.headers.get('authorization')
  if (!isVercelCron && process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const token = process.env.GITHUB_TOKEN
  if (!token) return NextResponse.json({ error: 'No GITHUB_TOKEN' }, { status: 500 })

  const supabase = await getSupabaseServiceClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rowsRaw } = await (supabase.from('design_index_inbox') as any)
    .select('*').is('processed_at', null)
  const dbRows = (rowsRaw ?? []) as { id: string; clickup_task_id: string; title: string; figma_url: string | null }[]
  if (dbRows.length === 0) return NextResponse.json({ ok: true, processed: 0 })

  try {
    const indexText = await readRepoFile(token, REPO, 'design/figma-index.json')
    const pendingText = await readRepoFile(token, REPO, 'design/figma-index.pending.json')
    const index = JSON.parse(indexText ?? '{"version":1,"apps":{},"features":[]}') as DesignIndex
    const pending = JSON.parse(pendingText ?? '{"version":1,"entries":[]}') as PendingFile

    // Resolve all codePaths existence against GitHub up-front (sync predicate for the pure core).
    const globs = new Set<string>()
    for (const e of pending.entries) for (const g of e.partial.codePaths ?? []) globs.add(g)
    const existing = new Map<string, boolean>()
    for (const g of globs) existing.set(g, await ghPathExists(token, REPO, staticPrefix(g)))
    const pathExists = (g: string) => existing.get(g) ?? false

    const rows: InboxRow[] = dbRows.map((r) => ({ clickupTaskId: r.clickup_task_id, title: r.title, figmaUrl: r.figma_url }))
    const out = applyInboxToIndex(index, pending, rows, { pathExists })

    await forceUpdateBranch(token, REPO, BRANCH, [
      { path: 'design/figma-index.json', content: JSON.stringify(out.index, null, 2) + '\n' },
      { path: 'design/figma-index.pending.json', content: JSON.stringify(out.pending, null, 2) + '\n' },
    ], `chore(design-index): scaffold ${rows.length} ticket(s)`)
    const pr = await ensurePrWithAutoMerge(token, REPO, BRANCH, 'Design-index: scaffold from ClickUp')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase.from('design_index_inbox') as any)
      .update({ processed_at: new Date().toISOString() })
      .in('id', dbRows.map((r) => r.id))

    return NextResponse.json({ ok: true, processed: rows.length, pr })
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase.from('design_index_inbox') as any)
      .update({ last_error: (err as Error).message })
      .in('id', dbRows.map((r) => r.id))
    console.error('[design-index-sync] failed:', err)
    return NextResponse.json({ error: 'sync failed' }, { status: 500 })
  }
}

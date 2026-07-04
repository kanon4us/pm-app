// lib/vault/snapshot.ts
// Snapshot builder for the weekly vault consolidation run.
// All I/O is injected via SnapshotDeps so this module is fully unit-testable.

import { buildBacklinkMap, BacklinkMap } from '@/lib/vault/backlinks'
import { readFrontmatter } from '@/lib/vault/frontmatter'
import type { VaultDoc, RunSnapshot } from '@/lib/vault/types'
import type { Json } from '@/lib/supabase/types'
import type { getSupabaseServiceClient } from '@/lib/supabase/server'

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

export interface SnapshotDeps {
  listDocs(): Promise<Array<{ path: string; content: string; blobSha: string }>>
  lastCommit(path: string): Promise<{ iso: string; email: string }>
}

// ---------------------------------------------------------------------------
// Core builder (fully testable — no GitHub / Supabase coupling)
// ---------------------------------------------------------------------------

export async function buildSnapshot(runId: string, deps: SnapshotDeps): Promise<RunSnapshot> {
  // Strip NUL characters at ingestion: Postgres jsonb rejects \u0000 (22P05),
  // so a single corrupt byte in one doc would otherwise fail the whole
  // snapshot upsert (seen live 2026-07-04 with a pasted control char).
  const rawDocs = (await deps.listDocs()).map((d) =>
    d.content.includes('\u0000') ? { ...d, content: d.content.replaceAll('\u0000', '') } : d
  )

  const commits = await Promise.all(rawDocs.map((d) => deps.lastCommit(d.path)))

  const docs: VaultDoc[] = rawDocs.map((raw, i) => ({
    path: raw.path,
    content: raw.content,
    blobSha: raw.blobSha,
    lastCommitISO: commits[i].iso,
    lastCommitterEmail: commits[i].email,
    frontmatter: readFrontmatter(raw.content),
  }))

  const contentMap: Record<string, string> = {}
  for (const d of rawDocs) contentMap[d.path] = d.content

  const backlinkMap = buildBacklinkMap(contentMap)
  const backlinks = serializeBacklinks(backlinkMap)

  return {
    runId,
    generatedAt: new Date().toISOString(),
    docs,
    backlinks,
  }
}

// ---------------------------------------------------------------------------
// Serialization helper
// ---------------------------------------------------------------------------

export function serializeBacklinks(m: BacklinkMap): Array<[string, string[]]> {
  return [...m.entries()].map(([k, v]) => [k, [...v]])
}

// ---------------------------------------------------------------------------
// Supabase persistence helpers (used by the cron — not unit-tested here)
// ---------------------------------------------------------------------------

type SupabaseServiceClient = Awaited<ReturnType<typeof getSupabaseServiceClient>>

export async function storeSnapshot(
  supabase: SupabaseServiceClient,
  snap: RunSnapshot
): Promise<void> {
  const { error } = await supabase
    .from('vault_run_snapshots')
    .upsert({ run_id: snap.runId, payload: snap as unknown as Json })
  if (error) throw error
}

export async function loadSnapshot(
  supabase: SupabaseServiceClient,
  runId: string
): Promise<RunSnapshot | null> {
  const { data, error } = await supabase
    .from('vault_run_snapshots')
    .select('payload')
    .eq('run_id', runId)
    .single()
  if (error) {
    if (error.code === 'PGRST116') return null // no rows
    throw error
  }
  return (data?.payload as unknown as RunSnapshot) ?? null
}

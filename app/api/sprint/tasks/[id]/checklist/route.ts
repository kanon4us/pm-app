import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { getBranchSha, readVaultFile } from '@/lib/github/vault'
import { findTestIndicator } from '@/lib/github/repos'
import type { Json } from '@/lib/supabase/types'

type Params = { params: Promise<{ id: string }> }

type GateStatus = 'green' | 'yellow' | 'red'

interface GateResult {
  status: GateStatus
  label: string
  detail: string | null
  hint: string | null
  override: { acknowledgedAt: string; reason: string } | null
}

export interface ChecklistResponse {
  gates: {
    gate1: GateResult
    gate2: GateResult
    gate3: GateResult
    gate4: GateResult
  }
  /** True when gates 1-3 are green AND gate 4 is green or yellow (acknowledged). */
  canProceedToArchitecting: boolean
}

const FIGMA_RE = /figma\.com\/(file|design)\//i

// GET /api/sprint/tasks/[id]/checklist
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()

  const { data: user } = await supabase
    .from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // Fetch task, joining through list → repo_registry in one query
  const { data: task } = await supabase
    .from('tasks')
    .select('id, name, clickup_task_id, git_branch, kickoff_gate_overrides, lists!inner(repo_registry_id, repo_registry(github_repo_full_name))')
    .eq('id', id)
    .single()

  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const { data: ghToken } = await supabase
    .from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'github').single()

  const token = ghToken?.access_token ?? null

  // Derived values
  const branch = task.git_branch
  const slug = task.name.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-').slice(0, 40)
  const dir = branch ? `FeaturePlanning/_Active/${task.clickup_task_id}-${slug}` : null

  type ListRow = { repo_registry_id: string | null; repo_registry: { github_repo_full_name: string | null } | null }
  const list = (task as unknown as { lists: ListRow }).lists
  const codeRepo = list?.repo_registry?.github_repo_full_name ?? null

  const overrides = (task.kickoff_gate_overrides as Record<string, { acknowledgedAt: string; reason: string }> | null) ?? {}

  // All GitHub checks run concurrently — each resolves to null on API miss or failure
  const [branchSha, claudeMd, specMd, testIndicator] = await Promise.all([
    branch && token ? getBranchSha(token, branch).catch((e) => { console.error(`[checklist task=${id}] getBranchSha failed:`, e); return null }) : Promise.resolve(null),
    dir && branch && token ? readVaultFile(token, `${dir}/CLAUDE.md`, branch).catch((e) => { console.error(`[checklist task=${id}] CLAUDE.md read failed:`, e); return null }) : Promise.resolve(null),
    dir && branch && token ? readVaultFile(token, `${dir}/spec.md`, branch).catch((e) => { console.error(`[checklist task=${id}] spec.md read failed:`, e); return null }) : Promise.resolve(null),
    codeRepo && token ? findTestIndicator(token, codeRepo).catch((e) => { console.error(`[checklist task=${id}] findTestIndicator failed (${codeRepo}):`, e); return null }) : Promise.resolve(null),
  ])

  // Gate 1 — Vault branch
  const gate1: GateResult = branchSha
    ? { status: 'green', label: 'Vault branch exists', detail: branch, hint: null, override: null }
    : !token
      ? { status: 'red', label: 'Vault branch exists', detail: 'GitHub not connected', hint: 'Connect GitHub in Setup', override: null }
      : branch
        ? { status: 'red', label: 'Vault branch exists', detail: `Branch "${branch}" not found in vault`, hint: null, override: null }
        : { status: 'red', label: 'Vault branch exists', detail: 'No vault branch on this task', hint: 'Complete FVI Assessment to create the branch', override: null }

  // Gate 2 — CLAUDE.md on vault branch
  const gate2: GateResult = claudeMd
    ? { status: 'green', label: 'User-Perspective SKILLs loaded', detail: 'CLAUDE.md present on vault branch', hint: null, override: null }
    : branchSha
      ? { status: 'red', label: 'User-Perspective SKILLs loaded', detail: 'CLAUDE.md not found on vault branch', hint: 'Approve the → In Progress trigger to generate it', override: null }
      : { status: 'red', label: 'User-Perspective SKILLs loaded', detail: 'Requires vault branch (Gate #1)', hint: null, override: null }

  // Gate 3 — Figma link in spec.md
  const hasFigma = specMd ? FIGMA_RE.test(specMd.content) : false
  const gate3: GateResult = hasFigma
    ? { status: 'green', label: 'Figma Selection Link in spec', detail: 'figma.com link found in spec.md', hint: null, override: null }
    : specMd
      ? { status: 'red', label: 'Figma Selection Link in spec', detail: 'spec.md exists but contains no Figma link', hint: 'Designer must share a Figma component link; PM Agent embeds it on → Architecting', override: null }
      : branchSha
        ? { status: 'red', label: 'Figma Selection Link in spec', detail: 'spec.md not found on vault branch', hint: null, override: null }
        : { status: 'red', label: 'Figma Selection Link in spec', detail: 'Requires vault branch (Gate #1)', hint: null, override: null }

  // Gate 4 — Baseline tests in code repo
  const gate4Override = overrides['gate_4'] ?? null
  let gate4: GateResult

  if (testIndicator) {
    gate4 = { status: 'green', label: 'Baseline tests defined', detail: `${testIndicator}${codeRepo ? ` in ${codeRepo}` : ''}`, hint: null, override: null }
  } else if (!codeRepo) {
    gate4 = { status: 'red', label: 'Baseline tests defined', detail: 'No code repository mapped to this list', hint: 'Map a repository in Setup → Lists', override: null }
  } else if (!token) {
    gate4 = { status: 'red', label: 'Baseline tests defined', detail: 'GitHub not connected', hint: 'Connect GitHub in Setup', override: null }
  } else if (gate4Override) {
    gate4 = { status: 'yellow', label: 'Baseline tests defined', detail: `No tests found in ${codeRepo} — legacy zone acknowledged`, hint: null, override: gate4Override }
  } else {
    gate4 = { status: 'red', label: 'Baseline tests defined', detail: `No tests found in ${codeRepo}`, hint: 'Add baseline tests, or acknowledge this as a legacy zone with a reason', override: null }
  }

  const canProceedToArchitecting =
    gate1.status === 'green' &&
    gate2.status === 'green' &&
    gate3.status === 'green' &&
    (gate4.status === 'green' || gate4.status === 'yellow')

  return NextResponse.json(
    { gates: { gate1, gate2, gate3, gate4 }, canProceedToArchitecting } satisfies ChecklistResponse,
    { headers: { 'Cache-Control': 'max-age=300, stale-while-revalidate=60' } }
  )
}

// PUT /api/sprint/tasks/[id]/checklist/override — save a Gate #4 legacy-zone acknowledgment
export async function PUT(req: NextRequest, { params }: Params) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { reason }: { reason: string } = await req.json()
  if (!reason?.trim()) return NextResponse.json({ error: 'reason required' }, { status: 400 })

  const supabase = await getSupabaseServiceClient()

  // Fetch existing overrides to merge
  const { data: task } = await supabase
    .from('tasks').select('kickoff_gate_overrides').eq('id', id).single()
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const existing = (task.kickoff_gate_overrides as Record<string, unknown> | null) ?? {}
  const updated = {
    ...existing,
    gate_4: { acknowledgedAt: new Date().toISOString(), reason: reason.trim() },
  }

  const { error } = await supabase
    .from('tasks').update({ kickoff_gate_overrides: updated as unknown as Json }).eq('id', id)

  if (error) {
    console.error(`[checklist:override task=${id}] Supabase update failed:`, error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

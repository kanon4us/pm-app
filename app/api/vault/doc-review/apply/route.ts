import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { writeVaultFile } from '@/lib/github/vault'

export const maxDuration = 120

interface DocProposal {
  id: string
  type: string
  targetPath: string
  action: 'create' | 'update'
  title: string
  rationale: string
  proposedContent: string
  editedContent?: string
  approved: boolean
}

// POST /api/vault/doc-review/apply
// Commits all approved proposals to the main branch of the vault.
// Body: { taskId: string, proposals: DocProposal[] }
// Returns: { applied: string[], errors: string[] }
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { taskId, proposals } = await req.json()
  if (!taskId) return NextResponse.json({ error: 'taskId required' }, { status: 400 })
  if (!Array.isArray(proposals) || proposals.length === 0)
    return NextResponse.json({ error: 'proposals array required' }, { status: 400 })

  const supabase = await getSupabaseServiceClient()

  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { data: task } = await supabase
    .from('tasks')
    .select('id, name, clickup_task_id')
    .eq('id', taskId)
    .single()
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const { data: ghToken } = await supabase
    .from('oauth_tokens')
    .select('access_token')
    .eq('user_id', user.id)
    .eq('provider', 'github')
    .single()
  if (!ghToken?.access_token) return NextResponse.json({ error: 'GitHub not connected' }, { status: 400 })

  const approved = (proposals as DocProposal[]).filter((p) => p.approved)
  if (approved.length === 0) return NextResponse.json({ applied: [], errors: [] })

  const today = new Date().toISOString().slice(0, 10)
  const applied: string[] = []
  const errors: string[] = []

  // Sequential writes — GitHub's Contents API creates one commit per file.
  // Parallel writes to the same branch fail because each commit updates the branch
  // HEAD, invalidating concurrent requests that read the old HEAD SHA.
  for (const proposal of approved) {
    const content = proposal.editedContent ?? proposal.proposedContent
    const commitMessage = `docs: ${proposal.action === 'create' ? 'add' : 'update'} ${proposal.title} (via PM Agent, task ${task.clickup_task_id}, ${today})`
    try {
      const result = await writeVaultFile(
        ghToken.access_token,
        proposal.targetPath,
        content,
        commitMessage,
        'main' // always main branch for doc updates
      )
      if (result) {
        applied.push(proposal.targetPath)
      } else {
        errors.push(`${proposal.targetPath}: write returned null`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[doc-review:apply] Failed to write ${proposal.targetPath}:`, err)
      errors.push(`${proposal.targetPath}: ${msg}`)
    }
  }

  return NextResponse.json({ applied, errors })
}

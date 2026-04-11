import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildAgentContext } from '@/lib/pm-agent/context'
import { runKickoffAgent } from '@/lib/pm-agent/kickoff'
import { buildClickUpClient } from '@/lib/clickup/client'
import { writeVaultFile } from '@/lib/github/vault'
import { buildWebflowClient } from '@/lib/webflow/client'
import { readVaultFile } from '@/lib/github/vault'
import type { Json } from '@/lib/supabase/types'

const SUPPORTED_ACTIONS = ['Start feature kickoff'] as const

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { triggerId }: { triggerId: string } = await req.json()
  if (!triggerId) return NextResponse.json({ error: 'triggerId required' }, { status: 400 })

  const supabase = await getSupabaseServiceClient()

  // ── Validate and lock the trigger ────────────────────────────────────────────
  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { data: trigger } = await supabase
    .from('trigger_queue')
    .select('id, task_id, config_id, status')
    .eq('id', triggerId)
    .eq('status', 'pending')
    .single()

  if (!trigger) return NextResponse.json({ error: 'Trigger not found or not pending' }, { status: 404 })

  // Mark approved + running before the Claude call so Realtime shows progress in dashboard
  await supabase
    .from('trigger_queue')
    .update({ status: 'running', approved_by: user.id, updated_at: new Date().toISOString() })
    .eq('id', triggerId)

  // ── Build context ─────────────────────────────────────────────────────────────
  const ctx = await buildAgentContext(supabase, trigger.task_id, trigger.config_id)
  if (!ctx) {
    console.error(`[trigger:${triggerId}] context build failed — task_id=${trigger.task_id} config_id=${trigger.config_id}`)
    await failTrigger(supabase, triggerId, 'Could not build agent context — task or config missing')
    return NextResponse.json({ error: 'Context build failed' }, { status: 500 })
  }

  if (!SUPPORTED_ACTIONS.includes(ctx.config.pmAgentAction as typeof SUPPORTED_ACTIONS[number])) {
    console.error(`[trigger:${triggerId}] unsupported action: "${ctx.config.pmAgentAction}"`)
    await failTrigger(supabase, triggerId, `PM Agent action "${ctx.config.pmAgentAction}" is not yet implemented`)
    return NextResponse.json({ error: 'Unsupported PM Agent action' }, { status: 422 })
  }

  // ── Fetch external tokens in parallel ────────────────────────────────────────
  const [{ data: cuToken }, { data: ghToken }, { data: wfToken }] = await Promise.all([
    supabase.from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'clickup').single(),
    supabase.from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'github').single(),
    supabase.from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'webflow').single(),
  ])

  // ── Read existing vault spec (provides Claude with prior assessment content) ──
  let vaultSpec: string | null = null
  if (ctx.task.gitBranch && ghToken?.access_token) {
    const slug = ctx.task.name.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-').slice(0, 40)
    const specPath = `FeaturePlanning/_Active/${ctx.task.clickupTaskId}-${slug}/spec.md`
    const specFile = await readVaultFile(ghToken.access_token, specPath, ctx.task.gitBranch).catch(() => null)
    vaultSpec = specFile?.content ?? null
  }

  // ── Run PM Agent ──────────────────────────────────────────────────────────────
  let agentOutput: Awaited<ReturnType<typeof runKickoffAgent>>
  try {
    agentOutput = await runKickoffAgent(ctx, vaultSpec)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[trigger:${triggerId}] PM Agent (${ctx.config.pmAgentAction}) failed:`, msg)
    await failTrigger(supabase, triggerId, `PM Agent failed: ${msg}`)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  // ── Execute write-backs in write_back_order ───────────────────────────────────
  const errorDetails: Record<string, string> = {}

  for (const target of ctx.config.writeBackOrder) {
    try {
      switch (target) {
        case 'clickup':
          await writeBackClickUp(ctx.task.clickupTaskId, agentOutput.clickupComment, cuToken?.access_token ?? null)
          break

        case 'docs':
          await writeBackDocs(ctx, agentOutput, ghToken?.access_token ?? null)
          break

        case 'webflow':
          await writeBackWebflow(ctx, agentOutput, wfToken?.access_token ?? null)
          break

        case 'figma':
          // Phase 2 — Figma MCP (Code → Canvas) is local-only and not yet wired
          errorDetails.figma = 'Figma write-back not yet implemented (Phase 2)'
          break

        default:
          errorDetails[target] = `Unknown write-back target: ${target}`
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errorDetails[target] = msg
      if (ctx.config.onFailure === 'stop') {
        await failTrigger(supabase, triggerId, `Write-back "${target}" failed (on_failure=stop): ${msg}`, agentOutput as unknown as Json, errorDetails as unknown as Json)
        return NextResponse.json({ error: msg, target }, { status: 500 })
      }
      // on_failure=continue — log to Vercel function logs and proceed
      console.error(`[trigger:${triggerId}] write-back "${target}" failed (continuing):`, msg)
    }
  }

  // ── Mark done ─────────────────────────────────────────────────────────────────
  await supabase.from('trigger_queue').update({
    status: 'done',
    agent_output: agentOutput as unknown as Json,
    error_details: Object.keys(errorDetails).length ? errorDetails as unknown as Json : null,
    updated_at: new Date().toISOString(),
  }).eq('id', triggerId)

  return NextResponse.json({
    ok: true,
    action: ctx.config.pmAgentAction,
    writeBackErrors: Object.keys(errorDetails).length ? errorDetails : null,
  })
}

// ── Write-back helpers ────────────────────────────────────────────────────────

async function writeBackClickUp(
  clickupTaskId: string,
  comment: string,
  token: string | null
) {
  if (!token) throw new Error('ClickUp token not connected')
  const cu = buildClickUpClient(token)
  await cu.createTaskComment(clickupTaskId, comment)
}

async function writeBackDocs(
  ctx: Awaited<ReturnType<typeof buildAgentContext>>,
  output: Awaited<ReturnType<typeof runKickoffAgent>>,
  token: string | null
) {
  if (!ctx || !token) throw new Error('GitHub token not connected')
  if (!ctx.task.gitBranch) throw new Error('No vault branch — run FVI assessment before approving kickoff trigger')

  const slug = ctx.task.name.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-').slice(0, 40)
  const dir = `FeaturePlanning/_Active/${ctx.task.clickupTaskId}-${slug}`
  const today = new Date().toISOString().slice(0, 10)
  const branch = ctx.task.gitBranch

  await Promise.all([
    writeVaultFile(token, `${dir}/user-stories.md`, output.userStoriesMd, `PM Agent: user stories for ${ctx.task.name} (${today})`, branch),
    writeVaultFile(token, `${dir}/CLAUDE.md`, output.claudeMd, `PM Agent: CLAUDE.md injection for ${ctx.task.name} (${today})`, branch),
  ])
}

async function writeBackWebflow(
  ctx: Awaited<ReturnType<typeof buildAgentContext>>,
  output: Awaited<ReturnType<typeof runKickoffAgent>>,
  token: string | null
) {
  if (!output.webflowStub) return // PM Agent determined this isn't a user-facing feature
  if (!token) throw new Error('Webflow token not connected')

  const collectionId = (ctx?.config.writeBackConfig?.webflow_collection_id as string | undefined)
  if (!collectionId) throw new Error('webflow_collection_id not set in trigger_configs.write_back_config')

  const wf = buildWebflowClient(token)
  await wf.createDraftItem(collectionId, {
    name: output.webflowStub.name,
    slug: output.webflowStub.slug,
    summary: output.webflowStub.summary,
    excerpt: output.webflowStub.excerpt,
    'coming-soon': true,
    'feature-status': 'In Progress',
  })
}

// ── Utility ───────────────────────────────────────────────────────────────────

async function failTrigger(
  supabase: Awaited<ReturnType<typeof getSupabaseServiceClient>>,
  triggerId: string,
  reason: string,
  agentOutput: Json = null,
  errorDetails: Json = null
) {
  console.error(`[trigger:${triggerId}] FAILED:`, reason)
  await supabase.from('trigger_queue').update({
    status: 'failed',
    agent_output: agentOutput,
    error_details: errorDetails ?? ({ reason } as unknown as Json),
    updated_at: new Date().toISOString(),
  }).eq('id', triggerId)
}

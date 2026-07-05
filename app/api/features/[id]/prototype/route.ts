import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getFeature } from '@/lib/features/client'

/** Current feature-level prototype (rendered by Claude via render_prototype).
 *  ?meta=1 returns existence metadata only — html_content can be >1MB. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id: featureId } = await params
  const metaOnly = req.nextUrl.searchParams.get('meta') === '1'
  const db = await getSupabaseServiceClient()
  const { data } = await db
    .from('feature_prototypes')
    .select(metaOnly ? 'id, created_at' : 'id, html_content, created_at')
    .eq('feature_id', featureId)
    .is('scenario_id', null)
    .eq('is_current', true)
    .order('created_at', { ascending: false })
    .limit(1)
  if (!data?.length) return NextResponse.json({ error: 'No prototype yet' }, { status: 404 })
  return NextResponse.json(data[0])
}
import { buildFeatureContext } from '@/lib/features/context'
import { ensureStepImages } from '@/lib/prototypes/storage'
import { generatePrototypeHtml } from '@/lib/prototypes/generator'
import { pushPrototypeToVault } from '@/lib/prototypes/vault'
import { getScenarioSteps } from '@/lib/scenarios/client'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id: featureId } = await params
  const { scenario_id, scenario_title } = await req.json()

  const feature = await getFeature(featureId)
  if (!feature) return NextResponse.json({ error: 'Feature not found' }, { status: 404 })

  if (scenario_id) {
    const steps = await getScenarioSteps(scenario_id)
    await ensureStepImages(steps)
  }

  const featureContext = await buildFeatureContext(featureId)
  const html = await generatePrototypeHtml(featureContext, scenario_title ?? 'All Scenarios')

  const db = await getSupabaseServiceClient()
  const flipQ = db.from('feature_prototypes').update({ is_current: false }).eq('feature_id', featureId)
  scenario_id ? await flipQ.eq('scenario_id', scenario_id) : await flipQ.is('scenario_id', null)

  const githubToken = process.env.GITHUB_TOKEN
  if (!githubToken) return NextResponse.json({ error: 'GITHUB_TOKEN not configured' }, { status: 500 })
  const vaultResult = await pushPrototypeToVault(githubToken, featureId, feature.name, scenario_title ?? null, html)

  const { data: proto, error } = await db.from('feature_prototypes').insert({
    feature_id: featureId,
    scenario_id: scenario_id ?? null,
    is_current: true,
    html_content: html,
    vault_path: vaultResult?.vaultPath ?? null,
    vault_url: vaultResult?.vaultUrl ?? null,
    generated_by: user.email ?? '',
  }).select().single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(proto, { status: 201 })
}

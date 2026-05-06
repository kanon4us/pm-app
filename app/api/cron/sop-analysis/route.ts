// app/api/cron/sop-analysis/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { getActiveSop } from '@/lib/issue-triage/sop'
import { buildSlackClient } from '@/lib/slack/client'

const ANALYSIS_WINDOW_DAYS = 7
const MIN_OBSERVATIONS = 10
const SIGNIFICANCE_THRESHOLD = 0.30 // 30% anomaly rate

const ANALYSIS_PROMPT = `You are an SOP improvement analyst for a Slack support bot at Viscap Media.

Given a week of structured observations and the last 5 rejected proposals (so you don't repeat them), identify whether there is a significant pattern that warrants an SOP change.

A pattern is significant if it meets ALL of:
1. At least ${MIN_OBSERVATIONS} relevant observations
2. An anomaly rate > ${SIGNIFICANCE_THRESHOLD * 100}% (e.g., override_rate, disengagement_rate, misidentification_rate)
3. Not already proposed and rejected within the last 5 proposals without significantly more data

If significant: propose a specific, testable change to ONE section of the SOP (intake_prompt, escalation_rules, or duplicate_thresholds).
If not significant: respond with has_significant_pattern: false.

Respond with valid JSON only:
{
  "has_significant_pattern": true | false,
  "pattern_summary": "one sentence",
  "proposed_changes": { "sop_field": { "old": ..., "new": ... } },
  "expected_outcome": "one sentence",
  "confidence": 0.0
}`

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.VIDF_HOOK_API_KEY}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = await getSupabaseServiceClient()
  const sop = await getActiveSop()
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 })

  const windowStart = new Date(Date.now() - ANALYSIS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Fetch recent observations
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: observations } = await (supabase.from('bot_observations') as any)
    .select('id, event_type, payload, sop_version, created_at')
    .gte('created_at', windowStart)
    .limit(500)

  if (!observations || observations.length < MIN_OBSERVATIONS) {
    return NextResponse.json({ result: 'no_patterns', reason: 'insufficient_data', count: observations?.length ?? 0 })
  }

  // Check for existing pending proposal (only one at a time)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: pending } = await (supabase.from('sop_proposals') as any)
    .select('id')
    .eq('status', 'pending_review')
    .limit(1)

  if (pending?.length) {
    return NextResponse.json({ result: 'skipped', reason: 'proposal_already_pending' })
  }

  // Fetch last 5 rejected proposals for rejection memory
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rejectedProposals } = await (supabase.from('sop_proposals') as any)
    .select('pattern_summary, pm_response, created_at')
    .eq('status', 'rejected')
    .order('created_at', { ascending: false })
    .limit(5)

  // Summarise observations for Claude
  const eventCounts: Record<string, number> = {}
  for (const obs of observations) {
    eventCounts[obs.event_type] = (eventCounts[obs.event_type] ?? 0) + 1
  }

  const anthropic = new Anthropic({ apiKey })
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: ANALYSIS_PROMPT,
    messages: [{
      role: 'user',
      content: JSON.stringify({
        current_sop_version: sop.version,
        observation_window_days: ANALYSIS_WINDOW_DAYS,
        event_counts: eventCounts,
        total_observations: observations.length,
        last_5_rejections: rejectedProposals ?? [],
        current_escalation_rules: sop.escalation_rules,
        current_duplicate_thresholds: sop.duplicate_thresholds,
      }),
    }],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  let analysis: {
    has_significant_pattern: boolean
    pattern_summary?: string
    proposed_changes?: Record<string, unknown>
    expected_outcome?: string
    confidence?: number
  }

  try {
    analysis = JSON.parse(text)
  } catch {
    console.error('[sop-analysis] Claude returned non-JSON:', text.slice(0, 300))
    return NextResponse.json({ result: 'error', reason: 'claude_parse_failure' })
  }

  if (!analysis.has_significant_pattern) {
    return NextResponse.json({ result: 'no_patterns' })
  }

  // Create proposal
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: proposal, error: insertError } = await (supabase.from('sop_proposals') as any)
    .insert({
      sop_version: sop.version,
      proposed_changes: analysis.proposed_changes ?? {},
      pattern_summary: analysis.pattern_summary ?? '',
      supporting_data: { event_counts: eventCounts, total: observations.length },
      rejection_history: rejectedProposals ?? [],
      claude_confidence: analysis.confidence ?? 0,
      status: 'pending_review',
    })
    .select('id')
    .single()

  if (insertError || !proposal) {
    console.error('[sop-analysis] proposal insert failed:', insertError)
    return NextResponse.json({ result: 'error', reason: 'insert_failed' })
  }

  // Check if proposed changes conflict with PM-owned manual_directives
  const conflictWarnings: string[] = []
  if (analysis.proposed_changes && sop.manual_directives.length > 0) {
    const changedFields = Object.keys(analysis.proposed_changes)
    for (const directive of sop.manual_directives) {
      if (changedFields.includes('intake_prompt')) {
        conflictWarnings.push(`⚠️ Conflicts with PM directive: "${directive.action}" (added by <@${directive.added_by}>)`)
      }
    }
  }

  // Notify PM channel
  const slackToken = process.env.SLACK_BOT_TOKEN
  const channel = process.env.SLACK_BOT_IMPROVEMENTS_CHANNEL_ID
  if (slackToken && channel) {
    const slack = buildSlackClient(slackToken)
    const priorRejectionsNote = rejectedProposals?.length
      ? `\nRejection history: ${rejectedProposals.length} prior rejection(s) consulted.`
      : '\nRejection history: No prior rejections on this pattern.'

    const conflictBlock = conflictWarnings.length
      ? `\n\n${conflictWarnings.join('\n')}\n_Review these directives before approving — the analysis layer cannot modify manual_directives._`
      : ''

    await slack.postMessage(
      channel,
      [
        `🤖 *SOP Improvement Proposal — v${sop.version} → v${sop.version + 1}*`,
        '',
        `*Pattern:* ${analysis.pattern_summary}${priorRejectionsNote}`,
        '',
        `*Proposed changes:* ${JSON.stringify(analysis.proposed_changes, null, 2)}`,
        '',
        `*Expected outcome:* ${analysis.expected_outcome}`,
        `*Confidence:* ${((analysis.confidence ?? 0) * 100).toFixed(0)}%`,
        conflictBlock,
        '',
        `_(Reply with Approve or Reject — interactive buttons coming in Phase C UI)_`,
        `Proposal ID: \`${(proposal as { id: string }).id}\``,
      ].join('\n'),
    )
  }

  return NextResponse.json({ result: 'proposal_created', proposalId: (proposal as { id: string }).id })
}

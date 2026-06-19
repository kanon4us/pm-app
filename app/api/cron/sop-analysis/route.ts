// app/api/cron/sop-analysis/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { deflateSync } from 'node:zlib'
import Anthropic from '@anthropic-ai/sdk'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { getActiveSop } from '@/lib/issue-triage/sop'
import { buildSlackClient } from '@/lib/slack/client'
import { validateIntakePromptChange } from '@/lib/issue-triage/sop-proposal-guard'

const ANALYSIS_WINDOW_DAYS = 7
const MIN_OBSERVATIONS = 10
const SIGNIFICANCE_THRESHOLD = 0.30 // 30% anomaly rate

// Render raw Mermaid source to a public PNG URL via mermaid.ink (pako format,
// same encoding mermaid.live uses). Slack can't render Mermaid itself, so we post
// the rendered image. Returns null if the source is empty.
export function mermaidInkUrl(code?: string): string | null {
  const src = (code ?? '').trim().replace(/^```(?:mermaid)?\s*|\s*```$/g, '').trim()
  if (!src) return null
  const payload = JSON.stringify({ code: src, mermaid: { theme: 'neutral' } })
  const data = deflateSync(Buffer.from(payload, 'utf8'), { level: 9 }).toString('base64url')
  return `https://mermaid.ink/img/pako:${data}`
}

const ANALYSIS_PROMPT = `You are an SOP improvement analyst for a Slack support bot at Viscap Media.

You are given a window of structured observations, the verbatim human feedback collected during that window (reporter and dev-team survey responses, and dev-team reaction signals), and the last 5 rejected proposals (so you don't repeat them). Decide whether there is a pattern worth an SOP change.

A pattern is significant if EITHER:
1. A recurring theme appears across the human feedback — multiple responses raising the same complaint, request, or praise about how the bot behaves; OR
2. A behavioral anomaly rate exceeds ${SIGNIFICANCE_THRESHOLD * 100}% (e.g., override_rate, disengagement_rate, misidentification_rate, escalation_rate) across at least ${MIN_OBSERVATIONS} relevant observations.

Ignore patterns already proposed and rejected within the last 5 proposals unless there is materially more supporting data now.

The human feedback is the primary signal — read it closely. Even a single, specific, actionable piece of feedback that clearly maps to one SOP section can warrant a proposal; recurring themes are stronger.

If not significant: respond with has_significant_pattern: false.

If significant, classify what the fix requires:
- The bot only reads three config sections (intake_prompt, escalation_rules, duplicate_thresholds), and only as data — it cannot gain genuinely new behavior (time-based nudging, new event handling, new integrations, new Slack actions) just by changing those values.
- If the improvement can be achieved purely by editing one of those three sections that existing code already consumes, set "requires_code": false and fill "proposed_changes" with a specific, testable edit to ONE section.
- If it needs NEW bot behavior or code, set "requires_code": true, leave "proposed_changes" as {}, and describe what to build in "feature_summary" (treat this as an engineering ticket, not a config tweak).

Either way, ground it in the feedback — quote or paraphrase the responses that motivated it in pattern_summary.

Also produce two Mermaid flowcharts of the bot's intake → triage → escalation flow:
- current_sop_diagram: how the bot behaves under the CURRENT SOP (use the real values from current_escalation_rules / current_duplicate_thresholds).
- proposed_sop_diagram: the same flow with your change applied (for a requires_code item, show the proposed new behavior/branch).
Rules for both: valid \`flowchart TD\` syntax, raw Mermaid source ONLY (no markdown code fences, no commentary), at most ~15 nodes, short node labels. In proposed_sop_diagram, make the changed nodes/edges obvious (e.g. a "NEW:"/"CHANGED:" label prefix).

Respond with valid JSON only:
{
  "has_significant_pattern": true | false,
  "requires_code": true | false,
  "pattern_summary": "one or two sentences, citing the feedback that drove this",
  "proposed_changes": { "sop_field": { "old": ..., "new": ... } },
  "feature_summary": "if requires_code: what to build, as an eng ticket (else empty string)",
  "current_sop_diagram": "mermaid flowchart TD source for the current SOP",
  "proposed_sop_diagram": "mermaid flowchart TD source for the proposed SOP",
  "expected_outcome": "one sentence",
  "confidence": 0.0
}`

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  const vidfKey = process.env.VIDF_HOOK_API_KEY?.trim()
  const isAuthorized =
    (cronSecret && auth === `Bearer ${cronSecret}`) ||
    (vidfKey && auth === `Bearer ${vidfKey}`)
  if (!isAuthorized) {
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

  // The verbatim human feedback is the primary signal — pass it through, not just counts.
  const humanFeedback = (observations as Array<{ event_type: string; created_at: string; payload: unknown }>)
    .filter((obs) => obs.event_type === 'human_feedback')
    .map((obs) => ({ at: obs.created_at, ...(obs.payload as Record<string, unknown>) }))

  const anthropic = new Anthropic({ apiKey })
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 6000,
    thinking: { type: 'adaptive' },
    system: ANALYSIS_PROMPT,
    messages: [{
      role: 'user',
      content: JSON.stringify({
        current_sop_version: sop.version,
        observation_window_days: ANALYSIS_WINDOW_DAYS,
        event_counts: eventCounts,
        total_observations: observations.length,
        human_feedback: humanFeedback,
        last_5_rejections: rejectedProposals ?? [],
        current_intake_prompt: sop.intake_prompt,
        current_escalation_rules: sop.escalation_rules,
        current_duplicate_thresholds: sop.duplicate_thresholds,
      }),
    }],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  let analysis: {
    has_significant_pattern: boolean
    requires_code?: boolean
    pattern_summary?: string
    proposed_changes?: Record<string, unknown>
    feature_summary?: string
    current_sop_diagram?: string
    proposed_sop_diagram?: string
    expected_outcome?: string
    confidence?: number
  }

  let parsedText = text.trim()
  const fenceMatch = parsedText.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) parsedText = fenceMatch[1].trim()

  try {
    analysis = JSON.parse(parsedText)
  } catch {
    console.error('[sop-analysis] Claude returned non-JSON:', text.slice(0, 300))
    return NextResponse.json({ result: 'error', reason: 'claude_parse_failure' })
  }

  if (!analysis.has_significant_pattern) {
    return NextResponse.json({ result: 'no_patterns' })
  }

  const requiresCode = analysis.requires_code === true

  // Create proposal. For feature requests (requires_code) there is no config edit
  // to apply on approval — the flag + feature_summary ride in supporting_data so
  // the approve handler routes it to engineering instead of mutating the SOP.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: proposal, error: insertError } = await (supabase.from('sop_proposals') as any)
    .insert({
      sop_version: sop.version,
      proposed_changes: requiresCode ? {} : (analysis.proposed_changes ?? {}),
      pattern_summary: analysis.pattern_summary ?? '',
      supporting_data: {
        event_counts: eventCounts,
        total: observations.length,
        requires_code: requiresCode,
        feature_summary: analysis.feature_summary ?? '',
      },
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

    // Surface a lossy intake_prompt rewrite so it's caught before approval.
    let promptWarning = ''
    const ipChange = (analysis.proposed_changes as Record<string, { new?: unknown }> | undefined)?.intake_prompt
    if (!requiresCode && ipChange && typeof ipChange.new === 'string') {
      const check = validateIntakePromptChange(sop.intake_prompt, ipChange.new)
      if (!check.ok) {
        promptWarning = `\n\n⚠️ *This intake_prompt change looks lossy:* ${check.issues.join('; ')}. Review the full new prompt before approving — approval is blocked if it drops the JSON contract.`
      }
    }

    const bodyLines = requiresCode
      ? [
          `🛠️ *Feature Request — needs engineering (not a config change)*`,
          '',
          `*Pattern:* ${analysis.pattern_summary}${priorRejectionsNote}`,
          '',
          `*What to build:* ${analysis.feature_summary}`,
          '',
          `*Expected outcome:* ${analysis.expected_outcome}`,
          `*Confidence:* ${((analysis.confidence ?? 0) * 100).toFixed(0)}%`,
          '',
          `_The bot can't do this by editing config — approving logs an engineering task; it won't change bot behavior on its own._`,
        ]
      : [
          `🤖 *SOP Improvement Proposal — v${sop.version} → v${sop.version + 1}*`,
          '',
          `*Pattern:* ${analysis.pattern_summary}${priorRejectionsNote}`,
          '',
          `*Proposed changes:* ${JSON.stringify(analysis.proposed_changes, null, 2)}`,
          '',
          `*Expected outcome:* ${analysis.expected_outcome}`,
          `*Confidence:* ${((analysis.confidence ?? 0) * 100).toFixed(0)}%`,
          conflictBlock,
          promptWarning,
        ]

    const proposalId = (proposal as { id: string }).id
    let body = bodyLines.join('\n')
    if (body.length > 2900) body = body.slice(0, 2900) + '\n…(truncated)'

    // Old vs proposed SOP flow, rendered from the analyst's Mermaid via mermaid.ink.
    const currentUrl = mermaidInkUrl(analysis.current_sop_diagram)
    const proposedUrl = mermaidInkUrl(analysis.proposed_sop_diagram)
    const diagramBlocks: Record<string, unknown>[] = []
    if (currentUrl) diagramBlocks.push({ type: 'image', image_url: currentUrl, alt_text: 'Current SOP flow', title: { type: 'plain_text', text: 'Current SOP' } })
    if (proposedUrl) diagramBlocks.push({ type: 'image', image_url: proposedUrl, alt_text: 'Proposed SOP flow', title: { type: 'plain_text', text: 'Proposed SOP' } })

    await slack.postBlocks(channel, `SOP proposal ${proposalId}`, [
      { type: 'section', text: { type: 'mrkdwn', text: body } },
      ...diagramBlocks,
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', action_id: 'sop_approve', value: proposalId },
          { type: 'button', text: { type: 'plain_text', text: 'Reject' }, style: 'danger', action_id: 'sop_reject', value: proposalId },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Proposal ID: \`${proposalId}\`` }] },
    ])
  }

  return NextResponse.json({ result: 'proposal_created', proposalId: (proposal as { id: string }).id })
}

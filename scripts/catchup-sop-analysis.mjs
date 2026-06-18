// One-off catch-up for the SOP-analysis pipeline.
//
// The weekly cron (app/api/cron/sop-analysis/route.ts) only looks at a 7-day
// window and — until the fix in this branch — never passed the human-feedback
// content to Claude, so a month of survey responses produced zero proposals and
// the improvements channel never received a message.
//
// This script runs the SAME (fixed) analysis over the full backlog so the
// accumulated feedback is processed once, posting the resulting proposal to the
// improvements channel. It reads creds from .env.local and talks to the prod
// Supabase + Slack directly, so it does not depend on the deploy or CRON_SECRET.
//
//   node scripts/catchup-sop-analysis.mjs            # dry run: print, no writes
//   node scripts/catchup-sop-analysis.mjs --commit   # insert proposal + post to Slack

import { readFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'

const COMMIT = process.argv.includes('--commit')
const WINDOW_DAYS = 60 // covers the full ~1-month backlog with margin
const SIGNIFICANCE_THRESHOLD = 0.3

// --- load .env.local -------------------------------------------------------
const env = {}
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
const SLACK_TOKEN = env.SLACK_BOT_TOKEN
const CHANNEL = env.SLACK_BOT_IMPROVEMENTS_CHANNEL_ID
const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY
for (const [k, v] of Object.entries({ SUPABASE_URL, SERVICE_KEY, SLACK_TOKEN, CHANNEL, ANTHROPIC_API_KEY })) {
  if (!v) throw new Error(`Missing ${k} in .env.local`)
}

const sb = (path, init = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })

// Mirror of the cron's ANALYSIS_PROMPT (app/api/cron/sop-analysis/route.ts).
const ANALYSIS_PROMPT = `You are an SOP improvement analyst for a Slack support bot at Viscap Media.

You are given a window of structured observations, the verbatim human feedback collected during that window (reporter and dev-team survey responses, and dev-team reaction signals), and the last 5 rejected proposals (so you don't repeat them). Decide whether there is a pattern worth an SOP change.

A pattern is significant if EITHER:
1. A recurring theme appears across the human feedback — multiple responses raising the same complaint, request, or praise about how the bot behaves; OR
2. A behavioral anomaly rate exceeds ${SIGNIFICANCE_THRESHOLD * 100}% (e.g., override_rate, disengagement_rate, misidentification_rate, escalation_rate) across at least 10 relevant observations.

Ignore patterns already proposed and rejected within the last 5 proposals unless there is materially more supporting data now.

The human feedback is the primary signal — read it closely. Even a single, specific, actionable piece of feedback that clearly maps to one SOP section can warrant a proposal; recurring themes are stronger.

If not significant: respond with has_significant_pattern: false.

If significant, classify what the fix requires. The bot only reads three config sections (intake_prompt, escalation_rules, duplicate_thresholds), and only as data — it cannot gain genuinely new behavior (time-based nudging, new event handling, new integrations) just by changing those values. If the improvement can be achieved purely by editing one of those three sections, set "requires_code": false and fill "proposed_changes". If it needs NEW bot behavior/code, set "requires_code": true, leave "proposed_changes" as {}, and describe what to build in "feature_summary". Ground it in the feedback in pattern_summary.

Respond with valid JSON only:
{
  "has_significant_pattern": true | false,
  "requires_code": true | false,
  "pattern_summary": "one or two sentences, citing the feedback that drove this",
  "proposed_changes": { "sop_field": { "old": ..., "new": ... } },
  "feature_summary": "if requires_code: what to build (else empty string)",
  "expected_outcome": "one sentence",
  "confidence": 0.0
}`

async function main() {
  // 1. Active SOP
  const sopRes = await sb('bot_sops?status=eq.active&select=version,intake_prompt,escalation_rules,duplicate_thresholds,manual_directives&limit=1')
  const sop = (await sopRes.json())[0]
  if (!sop) throw new Error('No active SOP found')

  // 2. Don't stack proposals — respect the cron's one-at-a-time guard
  const pending = await (await sb('sop_proposals?status=eq.pending_review&select=id&limit=1')).json()
  if (pending.length) {
    console.log(`A proposal is already pending review (${pending[0].id}). Resolve it before catching up.`)
    return
  }

  // 3. Observations in the backlog window
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString()
  const observations = await (await sb(
    `bot_observations?select=id,event_type,payload,created_at&created_at=gte.${windowStart}&order=created_at.asc&limit=1000`,
  )).json()

  const eventCounts = {}
  for (const o of observations) eventCounts[o.event_type] = (eventCounts[o.event_type] ?? 0) + 1
  const humanFeedback = observations
    .filter((o) => o.event_type === 'human_feedback')
    .map((o) => ({ at: o.created_at, ...(o.payload ?? {}) }))

  console.log(`Window: last ${WINDOW_DAYS}d  |  observations: ${observations.length}  |  human_feedback: ${humanFeedback.length}`)
  console.log('event_counts:', eventCounts)

  if (!humanFeedback.length) {
    console.log('No human feedback in window — nothing to catch up on.')
    return
  }

  const rejected = await (await sb('sop_proposals?status=eq.rejected&select=pattern_summary,pm_response,created_at&order=created_at.desc&limit=5')).json()

  // 4. Analyse
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  const resp = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    system: ANALYSIS_PROMPT,
    messages: [{
      role: 'user',
      content: JSON.stringify({
        current_sop_version: sop.version,
        observation_window_days: WINDOW_DAYS,
        event_counts: eventCounts,
        total_observations: observations.length,
        human_feedback: humanFeedback,
        last_5_rejections: rejected ?? [],
        current_intake_prompt: sop.intake_prompt,
        current_escalation_rules: sop.escalation_rules,
        current_duplicate_thresholds: sop.duplicate_thresholds,
      }),
    }],
  })

  let text = (resp.content.find((b) => b.type === 'text')?.text ?? '').trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  const analysis = JSON.parse(text)

  console.log('\n--- Claude analysis ---')
  console.log(JSON.stringify(analysis, null, 2))

  if (!analysis.has_significant_pattern) {
    console.log('\nNo significant pattern. Nothing to post.')
    return
  }

  if (!COMMIT) {
    console.log('\n[dry run] Re-run with --commit to insert the proposal and post to Slack.')
    return
  }

  // 5. Insert proposal
  const requiresCode = analysis.requires_code === true
  const insertRes = await sb('sop_proposals', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      sop_version: sop.version,
      proposed_changes: requiresCode ? {} : (analysis.proposed_changes ?? {}),
      pattern_summary: analysis.pattern_summary ?? '',
      supporting_data: {
        event_counts: eventCounts,
        total: observations.length,
        catchup_window_days: WINDOW_DAYS,
        requires_code: requiresCode,
        feature_summary: analysis.feature_summary ?? '',
      },
      rejection_history: rejected ?? [],
      claude_confidence: analysis.confidence ?? 0,
      status: 'pending_review',
    }),
  })
  if (!insertRes.ok) throw new Error(`proposal insert failed: ${insertRes.status} ${await insertRes.text()}`)
  const proposal = (await insertRes.json())[0]

  // 6. Conflict check against PM-owned manual directives
  const directives = sop.manual_directives ?? []
  const conflicts = []
  if (analysis.proposed_changes && directives.length && Object.keys(analysis.proposed_changes).includes('intake_prompt')) {
    for (const d of directives) conflicts.push(`⚠️ Conflicts with PM directive: "${d.action}" (added by <@${d.added_by}>)`)
  }
  const conflictBlock = conflicts.length
    ? `\n\n${conflicts.join('\n')}\n_Review these directives before approving — the analysis layer cannot modify manual_directives._`
    : ''

  // 7. Post to the improvements channel
  let body = (requiresCode
    ? [
        `🛠️ *Feature Request — needs engineering (not a config change)*  _(catch-up over last ${WINDOW_DAYS} days)_`,
        '',
        `*Pattern:* ${analysis.pattern_summary}`,
        '',
        `*What to build:* ${analysis.feature_summary}`,
        '',
        `*Expected outcome:* ${analysis.expected_outcome}`,
        `*Confidence:* ${((analysis.confidence ?? 0) * 100).toFixed(0)}%`,
        '',
        `_The bot can't do this by editing config — approving logs an engineering task._`,
      ]
    : [
        `🤖 *SOP Improvement Proposal — v${sop.version} → v${sop.version + 1}*  _(catch-up over last ${WINDOW_DAYS} days)_`,
        '',
        `*Pattern:* ${analysis.pattern_summary}`,
        '',
        `*Proposed changes:* ${JSON.stringify(analysis.proposed_changes, null, 2)}`,
        '',
        `*Expected outcome:* ${analysis.expected_outcome}`,
        `*Confidence:* ${((analysis.confidence ?? 0) * 100).toFixed(0)}%`,
        conflictBlock,
      ]
  ).join('\n')
  if (body.length > 2900) body = body.slice(0, 2900) + '\n…(truncated)'

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: body } },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', action_id: 'sop_approve', value: proposal.id },
        { type: 'button', text: { type: 'plain_text', text: 'Reject' }, style: 'danger', action_id: 'sop_reject', value: proposal.id },
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Proposal ID: \`${proposal.id}\`` }] },
  ]

  const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: CHANNEL, text: `SOP proposal ${proposal.id}`, blocks }),
  })
  const slackJson = await slackRes.json()
  if (!slackJson.ok) throw new Error(`Slack post failed: ${slackJson.error}`)

  console.log(`\n✅ Proposal ${proposal.id} created and posted to ${CHANNEL} (ts ${slackJson.ts}).`)
}

main().catch((e) => { console.error(e); process.exit(1) })

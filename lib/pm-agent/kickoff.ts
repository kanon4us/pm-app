/**
 * PM Agent — "Start feature kickoff" action.
 * Runs when a task transitions → In Progress.
 *
 * Calls Claude API (claude-opus-4-6) with full task context and returns
 * structured artifacts for all four write-back targets.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { AgentContext } from './context'

export interface KickoffOutput {
  /** Markdown posted as a ClickUp comment — feature summary + first-step checklist */
  clickupComment: string
  /** Full content for user-stories.md in the vault branch */
  userStoriesMd: string
  /** Full CLAUDE.md content — injected into developer's session, stripped at Deployed */
  claudeMd: string
  /** Webflow Coming Soon stub metadata. null if this is not a user-facing feature. */
  webflowStub: {
    name: string
    slug: string
    summary: string
    excerpt: string
  } | null
}

const SYSTEM_PROMPT = `You are the Viscap PM Agent — a co-pilot for the Viscap product team's feature development workflow. You generate structured documentation and handoff artifacts when a feature moves from Planning into active development.

Your outputs are reviewed by the developer before anything is published or committed. You draft content; humans confirm it.

## Output Format

Respond with a single JSON object. No markdown fences. No preamble. No explanation. Just the JSON.

{
  "clickupComment": "<markdown string>",
  "userStoriesMd": "<full markdown file content>",
  "claudeMd": "<full CLAUDE.md file content>",
  "webflowStub": { "name": "<string>", "slug": "<url-safe string>", "summary": "<1-2 sentences>", "excerpt": "<max 120 chars>" } | null
}

## Content standards

clickupComment:
- Lead with FVI score and decision
- List effort, risk, and sprint (if any)
- Include a numbered "Your first 5 actions" checklist that references the vault files
- Mention the Kickoff Checklist gates (vault branch, SKILLs loaded, Figma link, baseline tests)
- Max 400 words

userStoriesMd:
- Title: "# User Stories — [feature name]"
- Write 3-6 Given/When/Then stories covering the primary user journeys
- Ground stories in the role context provided (use the SKILL content to identify what each role actually needs)
- End with "## Acceptance Criteria" checklist (5-8 items, all testable)
- Include "## Out of Scope" section listing what this feature explicitly does NOT cover

claudeMd:
- Start with: "<!-- CLAUDE.md — [feature name] | Remove when task reaches Deployed -->"
- "## Active Feature" section: task name, ClickUp ID, vault branch, FVI, sprint
- "## Focus Constraints": scope limits, what not to touch, Iron Law reminder (tests before QA)
- "## User Perspective" section: distill the 2-3 most critical constraints from each SKILL snapshot provided. Do not copy-paste the full SKILL — extract the decision-maker's actual requirements
- "## Figma": note that the Figma Selection Link will be embedded in spec.md during Architecting; do not proceed to Architecting without it
- "## Vault Files": list all bundle files with their purpose

webflowStub:
- null if the feature is internal-only, a backend change, or an infrastructure task
- slug must be lowercase, hyphens only, no special chars`

function formatContext(ctx: AgentContext, vaultSpec: string | null): string {
  const fvi = ctx.task.fviScore != null ? ctx.task.fviScore.toFixed(2) : 'Not yet assessed'
  const effort = ctx.task.costEffort != null ? `${ctx.task.costEffort} dev-day${ctx.task.costEffort !== 1 ? 's' : ''}` : 'Unknown'
  const risk = ctx.task.costRisk != null ? `${ctx.task.costRisk}x multiplier` : 'Unknown'

  const sprintLine = ctx.sprint
    ? `Sprint: ${ctx.sprint.name} | Budget: ${ctx.sprint.costBudget} FVI units | Ends: ${ctx.sprint.endDate ?? 'TBD'}`
    : 'Not assigned to a sprint'

  const objLines = ctx.objectives.length
    ? ctx.objectives
        .map((o) => `  Objective ${o.objectiveId}: ${o.score > 0 ? '+' : ''}${o.score}${o.reasoning ? ` — ${o.reasoning}` : ''}`)
        .join('\n')
    : '  No objective assessments recorded'

  const skillSection = ctx.skillSnapshots.length
    ? ctx.skillSnapshots
        .map((s) => `### SKILL: ${s.roleSlug}\n\n${s.content}`)
        .join('\n\n---\n\n')
    : 'No SKILL snapshots available — use general product principles for user stories'

  const specSection = vaultSpec
    ? `## Existing Vault Spec\n\n${vaultSpec}`
    : '## Vault Spec\n\n_Not yet written. Infer from task name, FVI objective scores, and SKILL context._'

  return `## Feature Details

Task name: ${ctx.task.name}
ClickUp ID: ${ctx.task.clickupTaskId}
Vault branch: ${ctx.task.gitBranch ?? 'Not yet created'}
${sprintLine}

## FVI Assessment

FVI score: ${fvi}
Effort: ${effort} | Risk: ${risk}

Objective scores (scale -5 to +5):
${objLines}

${specSection}

## User-Perspective SKILLs (top DM roles by influence score)

${skillSection}

---

Generate the kickoff artifacts for "${ctx.task.name}" now.`
}

export async function runKickoffAgent(
  ctx: AgentContext,
  vaultSpec: string | null
): Promise<KickoffOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const client = new Anthropic({ apiKey })

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: formatContext(ctx, vaultSpec) }],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''

  // Attempt direct parse, then strip markdown fences as fallback
  try {
    return JSON.parse(text) as KickoffOutput
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) return JSON.parse(match[1].trim()) as KickoffOutput
    throw new Error(`PM Agent returned non-JSON output. First 300 chars: ${text.slice(0, 300)}`)
  }
}

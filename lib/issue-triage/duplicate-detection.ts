import Anthropic from '@anthropic-ai/sdk'
import { buildClickUpClient } from '@/lib/clickup/client'
import type { TicketData, TriageClaudeResponse } from './types'

const TRIAGE_SYSTEM_PROMPT = `You are a triage engine. Given a completed bug report and a list of active ClickUp tasks, determine if the bug has already been reported.

Duplicate rules:
- confidence >= 0.85: this IS a duplicate — set duplicate_task_id to the matching task's ClickUp ID
- 0.60–0.84: related but distinct — set duplicate_task_id to null, note the related task in routing_reasoning
- < 0.60: unrelated — set duplicate_task_id to null

Respond with valid JSON only — no markdown, no explanation:
{
  "duplicate_task_id": "string | null",
  "duplicate_confidence": 0.0,
  "workaround_found": false,
  "workaround_text": null,
  "has_user_facing_docs": false,
  "documentation_gap": false,
  "routing_decision": "known_issues | needs_tutorial | new_tickets_with_workaround | escalate_to_michael",
  "routing_reasoning": "One sentence"
}`

function formatTaskList(tasks: Array<{ id: string; name: string; description: string | null }>): string {
  if (tasks.length === 0) return 'No active tasks found.'
  return tasks.map((t) => `[${t.id}] ${t.name}\n${t.description ?? '(no description)'}`).join('\n\n---\n\n')
}

function parseTriageJson(text: string): TriageClaudeResponse {
  try {
    return JSON.parse(text) as TriageClaudeResponse
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) return JSON.parse(match[1].trim()) as TriageClaudeResponse
    throw new Error(`Triage Claude returned non-JSON output. First 300 chars: ${text.slice(0, 300)}`)
  }
}

export async function detectDuplicate(ticketData: TicketData): Promise<TriageClaudeResponse> {
  const token = process.env.CLICKUP_BOT_TOKEN
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!token) throw new Error('CLICKUP_BOT_TOKEN is not set')
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const listIds = [
    process.env.CLICKUP_NEW_TICKETS_LIST_ID,
    process.env.CLICKUP_KNOWN_ISSUES_LIST_ID,
    process.env.CLICKUP_NEEDS_TUTORIAL_LIST_ID,
    process.env.CLICKUP_PLANNING_LIST_ID,
  ].filter(Boolean) as string[]

  if (listIds.length < 4) {
    console.warn(`detectDuplicate: only ${listIds.length}/4 ClickUp list IDs are configured — duplicate search may be incomplete`)
  }

  const client = buildClickUpClient(token)

  // NOTE: ClickUp API returns max 100 tasks per list (first page only)
  const taskArrays = await Promise.all(
    listIds.map((listId) =>
      client.getTasks(listId).catch(() => [])
    )
  )
  const allTasks = taskArrays.flat().map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
  }))

  const anthropic = new Anthropic({ apiKey })
  const userTurn = [
    `Completed ticket:\n${JSON.stringify(ticketData)}`,
    `Active ClickUp tasks (all lists):\n${formatTaskList(allTasks)}`,
  ].join('\n\n')

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: TRIAGE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userTurn }],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  return parseTriageJson(text)
}

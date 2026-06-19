// lib/issue-triage/duplicate-detection.ts
import Anthropic from '@anthropic-ai/sdk'
import { buildClickUpClient } from '@/lib/clickup/client'
import { getActiveSop } from './sop'
import type { TicketData, TriageClaudeResponse } from './types'

const TRIAGE_SYSTEM_PROMPT = `You are a triage engine. Given a completed bug report and a list of active ClickUp tasks, determine if the bug has already been reported.

Duplicate rules:
- confidence >= confirmed_threshold: this IS a duplicate — set duplicate_task_id to the matching task's ClickUp ID
- possible_threshold–confirmed_threshold: related but distinct — set duplicate_task_id to null, note in routing_reasoning
- < possible_threshold: unrelated — set duplicate_task_id to null

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

export async function detectDuplicate(
  ticketData: TicketData,
  excludeTaskId?: string,
  reporterClosedHistory?: string,
): Promise<TriageClaudeResponse> {
  const token = process.env.CLICKUP_BOT_TOKEN
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!token) throw new Error('CLICKUP_BOT_TOKEN is not set')
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const sop = await getActiveSop()
  const { possible, confirmed } = sop.duplicate_thresholds

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
  const taskArrays = await Promise.all(
    listIds.map((listId) => client.getTasks(listId).catch(() => []))
  )
  const allTasks = taskArrays.flat()
    .filter((t) => t.id !== excludeTaskId)
    .map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
    }))

  const anthropic = new Anthropic({ apiKey })
  const userTurn = [
    `Possible threshold: ${possible}, Confirmed threshold: ${confirmed}`,
    `Completed ticket:\n${JSON.stringify(ticketData)}`,
    `Active ClickUp tasks (all lists):\n${formatTaskList(allTasks)}`,
    reporterClosedHistory ? reporterClosedHistory : '',
  ].filter(Boolean).join('\n\n')

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: TRIAGE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userTurn }],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  return parseTriageJson(text)
}

/**
 * Returns true if a parent task has had N+ reporters confirm it as duplicate
 * within the SOP's collision window — triggers urgency escalation.
 */
export async function checkUrgencyCollision(
  parentTaskId: string,
  supabase: Awaited<ReturnType<typeof import('@/lib/supabase/server').getSupabaseServiceClient>>,
): Promise<boolean> {
  const sop = await getActiveSop()
  const { collisionWindowHours, collisionCount } = sop.duplicate_thresholds
  const windowStart = new Date(Date.now() - collisionWindowHours * 60 * 60 * 1000).toISOString()

  const { data } = await supabase
    .from('bot_observations')
    .select('id')
    .eq('event_type', 'duplicate_confirmed')
    .gte('created_at', windowStart)
    .filter('payload->>parentTaskId', 'eq', parentTaskId)

  // -1 because the current reporter's observation hasn't been recorded yet
  return (data?.length ?? 0) >= collisionCount - 1
}

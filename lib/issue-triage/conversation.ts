// lib/issue-triage/conversation.ts
import Anthropic from '@anthropic-ai/sdk'
import { getActiveSop } from './sop'
import type { SlackIssue, IntakeClaudeResponse, TicketData, BotSop } from './types'
import type { SlackMessage } from '@/lib/slack/client'

const TICKET_SCHEMA: TicketData = {
  issue_summary: '',
  reporter_email: '',
  affected_user_email: '',
  is_blocked: null,
  environment: { platform: '', brand: '', storyboard: '' },
  urls: [],
  reproduction_steps: [],
  expected_result: '',
  actual_result: '',
  last_occurred_at: '',
  is_repeat_issue: null,
  workaround_provided: null,
  documentation_gap: false,
}

function buildSystemPrompt(sop: BotSop): string {
  const directives = sop.manual_directives
    .map((d) => {
      if (d.trigger === 'always') return `ALWAYS: ${d.action}`
      if (d.trigger === 'contains_word') return `IF message contains "${d.value}": ${d.action}`
      return d.action
    })
    .join('\n')

  const directivesBlock = directives
    ? `\n\nMANDATORY RULES (cannot be overridden):\n${directives}`
    : ''

  return sop.intake_prompt + directivesBlock
}

function formatHistory(messages: SlackMessage[]): string {
  return messages
    .map((m) => `${m.bot_id ? '[BOT]' : '[USER]'}: ${m.text}`)
    .join('\n')
}

function parseClaudeJson(text: string): IntakeClaudeResponse {
  try {
    return JSON.parse(text) as IntakeClaudeResponse
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) {
      try { return JSON.parse(match[1].trim()) as IntakeClaudeResponse } catch { /* fall through */ }
    }
    throw new Error(`Intake Claude returned non-JSON output. First 300 chars: ${text.slice(0, 300)}`)
  }
}

export async function runIntakeTurn(
  issue: SlackIssue,
  userMessage: string,
  history: SlackMessage[],
): Promise<IntakeClaudeResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const sop = await getActiveSop()
  const client = new Anthropic({ apiKey })

  const userTurn = [
    `Ticket schema: ${JSON.stringify(TICKET_SCHEMA)}`,
    `Current ticket data: ${JSON.stringify(issue.ticket_data)}`,
    `Conversation history:\n${formatHistory(history)}`,
    `Latest message: ${userMessage}`,
  ].join('\n\n')

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: buildSystemPrompt(sop),
    messages: [{ role: 'user', content: userTurn }],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  return parseClaudeJson(text)
}

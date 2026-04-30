import Anthropic from '@anthropic-ai/sdk'
import type { SlackIssue, IntakeClaudeResponse, TicketData } from './types'
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

const INTAKE_SYSTEM_PROMPT = `You are a technical support intake specialist for Viscap Media. Your job is to gather a complete bug report through friendly, natural conversation — one question at a time.

Rules:
1. Never ask more than one question per reply.
2. Early in the conversation, ask for the reporter's email address and whether the affected user is themselves or someone else. If someone else, ask for that person's email.
3. If the user appears blocked, search for a workaround before asking more questions.
4. Do not accept vague answers. Probe "I don't know" answers gently before moving on.
5. Once all fields are filled with substantive answers, summarize and ask: "I have everything I need — does this look right? Ready to submit?"

Only set confidence >= 0.8 when every field has a specific, actionable answer, including both email addresses.

Respond with valid JSON only — no markdown, no explanation:
{
  "updated_schema": { ...complete ticket object matching the schema... },
  "bot_response": "The message to post in Slack",
  "confidence": 0.0
}`

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

/**
 * Call Claude with the current issue state and latest user message.
 * Returns the parsed intake response (updated schema + bot reply + confidence).
 */
export async function runIntakeTurn(
  issue: SlackIssue,
  userMessage: string,
  history: SlackMessage[],
): Promise<IntakeClaudeResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

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
    system: INTAKE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userTurn }],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  return parseClaudeJson(text)
}

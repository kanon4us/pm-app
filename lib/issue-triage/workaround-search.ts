import Anthropic from '@anthropic-ai/sdk'
import { searchVault } from '@/lib/github/vault'
import type { TicketData } from './types'

export interface WorkaroundResult {
  found: boolean
  text: string | null
  hasUserFacingDocs: boolean
  docGap: boolean
}

const WORKAROUND_SYSTEM_PROMPT = `You are a technical support triage assistant. Given a bug report and documentation search results, determine:

1. Whether there is a workaround a non-technical team member can follow TODAY to unblock themselves.
2. Whether that workaround is documented in user-facing guides (not just internal/technical docs).
3. Whether there is a documentation gap (technical content exists but no user guide).

Respond with valid JSON only — no markdown, no explanation:
{
  "workaround_found": true | false,
  "workaround_text": "Step-by-step summary for the user, or null",
  "has_user_facing_docs": true | false,
  "documentation_gap": true | false
}`

function parseWorkaroundJson(text: string): { workaround_found: boolean; workaround_text: string | null; has_user_facing_docs: boolean; documentation_gap: boolean } {
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) return JSON.parse(match[1].trim())
    throw new Error(`Workaround Claude returned non-JSON. First 300 chars: ${text.slice(0, 300)}`)
  }
}

export async function searchForWorkaround(ticketData: TicketData): Promise<WorkaroundResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  const githubToken = process.env.GITHUB_TOKEN
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
  if (!githubToken) throw new Error('GITHUB_TOKEN is not set')

  const query = [ticketData.issue_summary, ticketData.environment.platform].filter(Boolean).join(' ')
  const vaultResults = await searchVault(githubToken, query, 5).catch(() => [])

  const vaultSummary =
    vaultResults.length > 0
      ? vaultResults.map((r) => `[${r.path}]\n${r.snippet}`).join('\n\n---\n\n')
      : 'No documentation found.'

  const anthropic = new Anthropic({ apiKey })
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 512,
    system: WORKAROUND_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Bug report:\n${JSON.stringify(ticketData)}\n\nVault search results:\n${vaultSummary}`,
      },
    ],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  const parsed = parseWorkaroundJson(text)

  return {
    found: parsed.workaround_found,
    text: parsed.workaround_text,
    hasUserFacingDocs: parsed.has_user_facing_docs,
    docGap: parsed.documentation_gap,
  }
}

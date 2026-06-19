// Guards against an SOP proposal silently breaking the live intake prompt.
//
// The intake pipeline (lib/issue-triage/conversation.ts) uses bot_sops.intake_prompt
// verbatim as the system prompt and REQUIRES the model to return JSON
// ({ updated_schema, bot_response, confidence }). A proposal that rewrites
// intake_prompt and drops that contract breaks the bot — which is exactly what
// SOP v2 did. Validate any intake_prompt change before applying it.

const REQUIRED_INTAKE_TOKENS = ['updated_schema', 'bot_response', 'Respond with valid JSON']

export function validateIntakePromptChange(
  current: string,
  proposed: string,
): { ok: boolean; issues: string[] } {
  const issues: string[] = []
  const missing = REQUIRED_INTAKE_TOKENS.filter((t) => !proposed.includes(t))
  if (missing.length) {
    issues.push(`drops required intake contract token(s): ${missing.join(', ')}`)
  }
  if (current.length > 0 && proposed.length < current.length * 0.5) {
    issues.push(
      `new prompt is under half the length of the current one (${proposed.length} vs ${current.length} chars) — likely truncated`,
    )
  }
  return { ok: issues.length === 0, issues }
}

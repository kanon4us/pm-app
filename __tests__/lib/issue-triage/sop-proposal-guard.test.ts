import { validateIntakePromptChange } from '../../../lib/issue-triage/sop-proposal-guard'

const FULL = `You are a technical support intake specialist for Viscap Media.

Rules:
1. Never ask more than one question per reply.
2. Ask for the email.

Only set confidence >= 0.8 when every field has a specific answer.

Respond with valid JSON only:
{ "updated_schema": {}, "bot_response": "", "confidence": 0.0 }`

describe('validateIntakePromptChange', () => {
  it('accepts a prompt that keeps the JSON contract', () => {
    const res = validateIntakePromptChange(FULL, FULL + '\n3. Always tag the person.')
    expect(res.ok).toBe(true)
    expect(res.issues).toEqual([])
  })

  it('rejects a prompt that drops the JSON output contract (the v2 bug)', () => {
    const onlyRules = `Rules:\n1. Never ask more than one question per reply.\n2. Always tag the person.`
    const res = validateIntakePromptChange(FULL, onlyRules)
    expect(res.ok).toBe(false)
    expect(res.issues.join(' ')).toMatch(/updated_schema|bot_response|Respond with valid JSON/)
  })

  it('flags a drastically shorter prompt as likely truncated', () => {
    const short = 'Respond with valid JSON only: { "updated_schema": {}, "bot_response": "" }'
    const res = validateIntakePromptChange(FULL, short)
    expect(res.ok).toBe(false)
    expect(res.issues.join(' ')).toMatch(/half the length|truncated/)
  })
})

// __tests__/lib/bot/observations.test.ts
import { stripForbiddenKeys } from '@/lib/bot/observations'

describe('stripForbiddenKeys (privacy boundary D6)', () => {
  it('passes through clean derived-signal observations', () => {
    const obs = {
      conversation_ref: 'fs-doc-1',
      turn_index: 0,
      policy_version: 1,
      classification: 'question',
      cited_lesson_ids: ['lesson-1'],
      page_slug: '/admin/shotlists',
      workspace_id: 'team-1',
      answered: true,
      confidence: 0.9,
      event_type: 'turn',
    }
    expect(stripForbiddenKeys(obs)).toEqual(obs)
  })

  it.each(['message', 'message_text', 'messageText', 'text', 'reply', 'transcript', 'body', 'content'])(
    'strips forbidden key "%s"',
    (key) => {
      const obs = {
        conversation_ref: 'fs-doc-1',
        turn_index: 0,
        policy_version: 1,
        event_type: 'turn',
        [key]: 'the user said something private',
      }
      const clean = stripForbiddenKeys(obs)
      expect(clean).not.toHaveProperty(key)
      expect(clean.conversation_ref).toBe('fs-doc-1')
    }
  )
})

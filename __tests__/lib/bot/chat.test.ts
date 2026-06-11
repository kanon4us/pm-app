// __tests__/lib/bot/chat.test.ts
import { parseAnswer, sanitizeCitations, runChatTurn } from '@/lib/bot/chat'
import type { BotChatPolicy, BotJwtClaims } from '@/lib/bot/types'
import type { RetrievedLesson } from '@/lib/bot/retrieval'

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({
    from: () => ({ insert: jest.fn().mockResolvedValue({ error: null }) }),
  }),
}))

jest.mock('@/lib/bot/retrieval', () => ({
  ...jest.requireActual('@/lib/bot/retrieval'),
  searchLessons: jest.fn(),
}))

import { searchLessons } from '@/lib/bot/retrieval'

const policy: BotChatPolicy = {
  id: 'p1',
  version: 1,
  status: 'active',
  classification_prompt: 'classify',
  answer_prompt: 'answer',
  escalation_rules: { max_turns: 6, min_confidence: 0.5, must_escalate_phrases: ['speak to a human'] },
  citation_rules: { require_citation: true, max_citations: 3 },
  manual_directives: [],
  created_at: '2026-06-09',
  approved_by: null,
}

const claims: BotJwtClaims = {
  iss: 'viscap-cloud-functions',
  aud: 'pm-app-bot',
  exp: Math.floor(Date.now() / 1000) + 300,
  userId: 'u1',
  teamId: 'team-1',
  email: 'u@viscap.ai',
  roles: ['editor'],
  entitlements: ['help-resources-free'],
}

const lesson: RetrievedLesson = {
  id: 'lesson-1',
  title: 'Making a Shotlist',
  type: 'workflow',
  body: 'Steps to make a shotlist...',
  product_id: 'help-resources-free',
  surface_slugs: ['/admin/shotlists'],
  owned: true,
}

function mockAnthropic(jsonReply: unknown) {
  return {
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(jsonReply) }],
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('parseAnswer', () => {
  it('parses a valid answer JSON', () => {
    const out = parseAnswer('{"reply":"Here","citations":["a"],"answered":true,"confidence":0.9,"proposed_action":null}')
    expect(out).toEqual({ reply: 'Here', citations: ['a'], answered: true, confidence: 0.9, proposed_action: null })
  })

  it('strips markdown fences', () => {
    const out = parseAnswer('```json\n{"reply":"x","citations":[],"answered":false,"confidence":0.2,"proposed_action":null}\n```')
    expect(out?.reply).toBe('x')
  })

  it('returns null on garbage', () => {
    expect(parseAnswer('not json at all')).toBeNull()
  })

  it('clamps confidence into [0,1]', () => {
    const out = parseAnswer('{"reply":"x","citations":[],"answered":true,"confidence":7,"proposed_action":null}')
    expect(out?.confidence).toBe(1)
  })
})

describe('sanitizeCitations', () => {
  it('drops citations not in the retrieval set (anti-fabrication)', () => {
    expect(sanitizeCitations(['lesson-1', 'made-up-id'], [lesson], 3)).toEqual(['lesson-1'])
  })

  it('caps at max', () => {
    const lessons = [1, 2, 3, 4].map((n) => ({ ...lesson, id: `l${n}` }))
    expect(sanitizeCitations(['l1', 'l2', 'l3', 'l4'], lessons, 2)).toEqual(['l1', 'l2'])
  })
})

describe('runChatTurn', () => {
  beforeEach(() => jest.clearAllMocks())

  const baseReq = { conversationRef: 'conv-1', turnIndex: 0, message: 'How do I make a shotlist?', pageSlug: '/admin/shotlists' }

  it('answers with sanitized citations on a normal question', async () => {
    ;(searchLessons as jest.Mock).mockResolvedValue([lesson])
    const anthropic = mockAnthropic({
      intent: 'question', confidence: 0.95, reasoning: 'asks how',
      reply: 'Go to Shotlists and click New.', citations: ['lesson-1', 'fabricated'], answered: true, proposed_action: null,
    })
    const out = await runChatTurn(baseReq, claims, policy, anthropic)
    expect(out.citations).toEqual(['lesson-1'])
    expect(out.answered).toBe(true)
    expect(out.policyVersion).toBe(1)
  })

  it('escalates when the user asks for a human', async () => {
    const anthropic = mockAnthropic({})
    const out = await runChatTurn({ ...baseReq, message: 'I want to speak to a human' }, claims, policy, anthropic)
    expect(out.intent).toBe('escalation')
    expect(out.proposedAction?.type).toBe('create_support_ticket')
    expect(anthropic.messages.create).not.toHaveBeenCalled()
  })

  it('escalates when max_turns exceeded', async () => {
    const anthropic = mockAnthropic({})
    const out = await runChatTurn({ ...baseReq, turnIndex: 6 }, claims, policy, anthropic)
    expect(out.proposedAction?.type).toBe('create_support_ticket')
  })

  it('escalates on empty retrieval for a question (content gap / ripcord)', async () => {
    ;(searchLessons as jest.Mock).mockResolvedValue([])
    const anthropic = mockAnthropic({ intent: 'question', confidence: 0.9, reasoning: 'r' })
    const out = await runChatTurn({ ...baseReq, priorIntent: 'question' }, claims, policy, anthropic)
    expect(out.answered).toBe(false)
    expect(out.proposedAction?.type).toBe('create_support_ticket')
  })

  it('escalates when retrieval throws (pm-app stays calm, user gets handoff)', async () => {
    ;(searchLessons as jest.Mock).mockRejectedValue(new Error('typesense down'))
    const anthropic = mockAnthropic({})
    const out = await runChatTurn({ ...baseReq, priorIntent: 'question' }, claims, policy, anthropic)
    expect(out.proposedAction?.type).toBe('create_support_ticket')
  })

  it('proceeds to interview for bug intent even with empty retrieval', async () => {
    ;(searchLessons as jest.Mock).mockResolvedValue([])
    const anthropic = mockAnthropic({
      reply: 'What were you doing when the error appeared?', citations: [], answered: false, confidence: 0.8, proposed_action: null,
    })
    const out = await runChatTurn({ ...baseReq, priorIntent: 'bug', message: 'export crashes' }, claims, policy, anthropic)
    expect(out.reply).toContain('What were you doing')
    expect(anthropic.messages.create).toHaveBeenCalled()
  })

  it('escalates on unparseable model output', async () => {
    ;(searchLessons as jest.Mock).mockResolvedValue([lesson])
    const anthropic = {
      messages: { create: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'NOT JSON' }] }) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const out = await runChatTurn({ ...baseReq, priorIntent: 'question' }, claims, policy, anthropic)
    expect(out.proposedAction?.type).toBe('create_support_ticket')
  })
})

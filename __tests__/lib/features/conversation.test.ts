// __tests__/lib/features/conversation.test.ts
const ANTHROPIC_KEY = 'test-key'
process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY

const mockFrom = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({ from: mockFrom }),
}))

jest.mock('@/lib/features/context', () => ({
  buildFeatureContext: jest.fn().mockResolvedValue('Feature: Login\nStatus: draft'),
}))

const mockCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })),
}))

import { getOrCreateConversation, addMessage, sendFeatureMessage } from '@/lib/features/conversation'

function chain(ret: unknown) {
  return {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue(ret),
    order: jest.fn().mockResolvedValue(ret),
  }
}

describe('getOrCreateConversation', () => {
  it('returns existing conversation if found', async () => {
    const conv = { id: 'c-1', feature_id: 'f-1', status: 'in_progress' as const, created_at: '', updated_at: '' }
    mockFrom.mockReturnValue(chain({ data: conv, error: null }))
    const result = await getOrCreateConversation('f-1')
    expect(result.id).toBe('c-1')
  })

  it('creates a new conversation when none exists', async () => {
    const conv = { id: 'c-new', feature_id: 'f-1', status: 'in_progress' as const, created_at: '', updated_at: '' }
    mockFrom
      .mockReturnValueOnce(chain({ data: null, error: { message: 'not found' } }))
      .mockReturnValueOnce(chain({ data: conv, error: null }))
    const result = await getOrCreateConversation('f-1')
    expect(result.id).toBe('c-new')
  })
})

describe('sendFeatureMessage', () => {
  it('returns assistant content and saves both messages', async () => {
    const conv = { id: 'c-1', feature_id: 'f-1', status: 'in_progress' as const, created_at: '', updated_at: '' }
    const msg = { id: 'm-1', conversation_id: 'c-1', role: 'user' as const, content: 'test', created_at: '' }
    mockFrom
      .mockReturnValueOnce(chain({ data: conv, error: null })) // getOrCreate
      .mockReturnValueOnce(chain({ data: [], error: null })) // getMessages history
      .mockReturnValueOnce(chain({ data: msg, error: null })) // insert user message
      .mockReturnValueOnce(chain({ data: msg, error: null })) // insert assistant message
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Great flow!' }] })
    const { content } = await sendFeatureMessage('f-1', 'What do you think?')
    expect(content).toBe('Great flow!')
  })
})

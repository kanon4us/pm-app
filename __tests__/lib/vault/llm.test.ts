// __tests__/lib/vault/llm.test.ts
import { phraseQuestionText } from '@/lib/vault/llm'
import type { Question } from '@/lib/vault/types'

// ---------------------------------------------------------------------------
// Mock @anthropic-ai/sdk
// ---------------------------------------------------------------------------
const mockCreate = jest.fn()

jest.mock('@anthropic-ai/sdk', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: { create: mockCreate },
    })),
  }
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const question: Question = {
  id: 'orphan',
  text: 'Nothing links here. Still needed? If so, what should point to it?',
  actions: [
    { id: 'keep', label: 'Keep' },
    { id: 'archive', label: 'Archive' },
  ],
}

const doc = { path: 'docs/support/faq.md', supportCritical: false }
const supportDoc = { path: 'docs/support/critical.md', supportCritical: true }

function makeSuccessResponse(rephrasedText: string) {
  return {
    content: [
      {
        type: 'tool_use',
        name: 'rephrase',
        input: { rephrased_text: rephrasedText },
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('phraseQuestionText', () => {
  beforeEach(() => {
    mockCreate.mockReset()
  })

  it('returns the rephrased text from the tool_use block on success', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse('Polished question?'))

    const result = await phraseQuestionText(question, doc)

    expect(result).toBe('Polished question?')
  })

  it('returns question.text as fallback when messages.create rejects', async () => {
    mockCreate.mockRejectedValueOnce(new Error('network error'))

    const result = await phraseQuestionText(question, doc)

    expect(result).toBe(question.text)
  })

  it('returns question.text as fallback when there is no tool_use block', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'some prose response' }],
    })

    const result = await phraseQuestionText(question, doc)

    expect(result).toBe(question.text)
  })

  it('returns question.text as fallback when rephrased_text is empty string', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse(''))

    const result = await phraseQuestionText(question, doc)

    expect(result).toBe(question.text)
  })

  it('calls messages.create with a tool named "rephrase" and tool_choice forcing it', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse('Polished question?'))

    await phraseQuestionText(question, doc)

    expect(mockCreate).toHaveBeenCalledTimes(1)
    const callArg = mockCreate.mock.calls[0][0]

    // Must include a tools array with a tool named "rephrase"
    expect(callArg.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'rephrase' }),
      ])
    )

    // Must force that specific tool via tool_choice
    expect(callArg.tool_choice).toEqual({ type: 'tool', name: 'rephrase' })
  })

  it('includes the support-critical framing nudge in the prompt for support docs', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse('Rephrased for support?'))

    await phraseQuestionText(question, supportDoc)

    const callArg = mockCreate.mock.calls[0][0]
    const userContent = JSON.stringify(callArg.messages)
    expect(userContent).toMatch(/support/i)
  })
})

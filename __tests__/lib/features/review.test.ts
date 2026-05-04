// __tests__/lib/features/review.test.ts
jest.mock('@/lib/features/context', () => ({
  buildAllFeaturesContext: jest.fn().mockResolvedValue('Feature: A\n---\nFeature: B'),
}))

const mockCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }))
})

import { runUxReview } from '@/lib/features/review'

describe('runUxReview', () => {
  it('returns structured findings from Claude', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify([{ type: 'overlap', title: 'Duplicate login flows', description: 'Feature A and B both describe login', featureIds: ['f-1', 'f-2'] }]) }],
    })
    const findings = await runUxReview([])
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe('overlap')
  })

  it('returns empty array if Claude response is not valid JSON', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'No issues found.' }] })
    const findings = await runUxReview([])
    expect(findings).toEqual([])
  })
})

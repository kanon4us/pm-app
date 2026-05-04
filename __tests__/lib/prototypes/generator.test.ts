// __tests__/lib/prototypes/generator.test.ts
const ANTHROPIC_KEY = 'test-key'
process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY

const mockCreate = jest.fn()

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}))

import { generatePrototypeHtml } from '@/lib/prototypes/generator'

describe('generatePrototypeHtml', () => {
  const featureContext = `Feature: Login\nStatus: draft\nUser Story: As a PM...\n  Scenario: Happy Path\n    Step 1: Landing — User arrives [image: https://proj.supabase.co/img.png] [figma: https://figma.com/design/abc]`

  it('returns HTML string from Claude response', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '<html><body>prototype</body></html>' }],
    })
    const html = await generatePrototypeHtml(featureContext, 'Happy Path')
    expect(html).toContain('<html>')
    expect(html).toContain('prototype')
  })

  it('throws if Claude returns empty', async () => {
    mockCreate.mockResolvedValue({ content: [] })
    await expect(generatePrototypeHtml(featureContext, 'Happy Path')).rejects.toThrow()
  })
})

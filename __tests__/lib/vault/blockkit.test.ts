import { buildQuestionCard } from '@/lib/vault/blockkit'
import type { CardAction } from '@/lib/vault/blockkit'

describe('buildQuestionCard', () => {
  const baseArgs = {
    docPath: 'vault/Projects/example.md',
    bodyText: 'Is this document still relevant?',
    actions: [
      { id: 'keep', label: 'Keep it' },
      { id: 'archive', label: 'Archive it' },
    ] as CardAction[],
    blockId: 'block-abc-123',
  }

  it('returns an array of two blocks: section then actions', () => {
    const blocks = buildQuestionCard(baseArgs)
    expect(blocks).toHaveLength(2)
    expect((blocks[0] as Record<string, unknown>).type).toBe('section')
    expect((blocks[1] as Record<string, unknown>).type).toBe('actions')
  })

  it('includes the doc path in the section text', () => {
    const blocks = buildQuestionCard(baseArgs)
    const section = blocks[0] as Record<string, unknown>
    const text = (section.text as Record<string, unknown>).text as string
    expect(text).toContain('vault/Projects/example.md')
  })

  it('truncates body text exceeding 3000 chars to ≤3000 chars ending with …', () => {
    const longBody = 'x'.repeat(3100)
    const blocks = buildQuestionCard({ ...baseArgs, bodyText: longBody })
    const section = blocks[0] as Record<string, unknown>
    const text = (section.text as Record<string, unknown>).text as string
    expect(text.length).toBeLessThanOrEqual(3000)
    expect(text.endsWith('…')).toBe(true)
  })

  it('does not truncate body text that is exactly 3000 chars or fewer', () => {
    const exactBody = 'y'.repeat(2900)
    const blocks = buildQuestionCard({ ...baseArgs, bodyText: exactBody })
    const section = blocks[0] as Record<string, unknown>
    const text = (section.text as Record<string, unknown>).text as string
    expect(text).toContain(exactBody)
    expect(text.endsWith('…')).toBe(false)
  })

  it('sets the actions block_id to the passed blockId', () => {
    const blocks = buildQuestionCard(baseArgs)
    const actionsBlock = blocks[1] as Record<string, unknown>
    expect(actionsBlock.block_id).toBe('block-abc-123')
  })

  it('creates one button per action with matching action_id and value', () => {
    const blocks = buildQuestionCard(baseArgs)
    const actionsBlock = blocks[1] as Record<string, unknown>
    const elements = actionsBlock.elements as Record<string, unknown>[]
    expect(elements).toHaveLength(2)

    const keepBtn = elements.find((e) => e.action_id === 'keep')!
    expect(keepBtn).toBeDefined()
    expect(keepBtn.value).toBe('keep')
    expect(keepBtn.type).toBe('button')

    const archiveBtn = elements.find((e) => e.action_id === 'archive')!
    expect(archiveBtn).toBeDefined()
    expect(archiveBtn.value).toBe('archive')
  })

  it('truncates button label >75 chars to ≤75 chars ending with …', () => {
    const longLabel = 'A'.repeat(100)
    const blocks = buildQuestionCard({
      ...baseArgs,
      actions: [{ id: 'long', label: longLabel }],
    })
    const actionsBlock = blocks[1] as Record<string, unknown>
    const elements = actionsBlock.elements as Record<string, unknown>[]
    const btn = elements[0] as Record<string, unknown>
    const btnText = (btn.text as Record<string, unknown>).text as string
    expect(btnText.length).toBeLessThanOrEqual(75)
    expect(btnText.endsWith('…')).toBe(true)
  })

  it('does not truncate button label of exactly 75 chars or fewer', () => {
    const shortLabel = 'B'.repeat(75)
    const blocks = buildQuestionCard({
      ...baseArgs,
      actions: [{ id: 'exact', label: shortLabel }],
    })
    const actionsBlock = blocks[1] as Record<string, unknown>
    const elements = actionsBlock.elements as Record<string, unknown>[]
    const btn = elements[0] as Record<string, unknown>
    const btnText = (btn.text as Record<string, unknown>).text as string
    expect(btnText).toBe(shortLabel)
    expect(btnText.endsWith('…')).toBe(false)
  })
})

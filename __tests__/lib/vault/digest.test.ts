import { buildDigestCard } from '@/lib/vault/digest'

describe('buildDigestCard', () => {
  const makeDocs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      path: `vault/Projects/doc-${i + 1}.md`,
      blockId: `block-${i + 1}`,
    }))

  it('returns a header section plus one section per doc', () => {
    const docs = makeDocs(3)
    const blocks = buildDigestCard(docs)
    // header + 3 doc sections
    expect(blocks).toHaveLength(4)
    expect((blocks[0] as Record<string, unknown>).type).toBe('section')
    expect((blocks[1] as Record<string, unknown>).type).toBe('section')
    expect((blocks[2] as Record<string, unknown>).type).toBe('section')
    expect((blocks[3] as Record<string, unknown>).type).toBe('section')
  })

  it('header text reports the correct doc count', () => {
    const docs = makeDocs(5)
    const blocks = buildDigestCard(docs)
    const header = blocks[0] as Record<string, unknown>
    const text = (header.text as Record<string, unknown>).text as string
    expect(text).toContain('5')
  })

  it('each doc section has a button accessory with action_id vault_review_open', () => {
    const docs = makeDocs(2)
    const blocks = buildDigestCard(docs)
    // blocks[1] and blocks[2] are doc sections
    for (let i = 1; i <= 2; i++) {
      const section = blocks[i] as Record<string, unknown>
      const accessory = section.accessory as Record<string, unknown>
      expect(accessory).toBeDefined()
      expect(accessory.type).toBe('button')
      expect(accessory.action_id).toBe('vault_review_open')
    }
  })

  it("each doc section button's value is the doc's blockId", () => {
    const docs = makeDocs(3)
    const blocks = buildDigestCard(docs)
    docs.forEach((doc, idx) => {
      const section = blocks[idx + 1] as Record<string, unknown>
      const accessory = section.accessory as Record<string, unknown>
      expect(accessory.value).toBe(doc.blockId)
    })
  })

  it('each doc section text includes the doc path', () => {
    const docs = makeDocs(2)
    const blocks = buildDigestCard(docs)
    docs.forEach((doc, idx) => {
      const section = blocks[idx + 1] as Record<string, unknown>
      const text = (section.text as Record<string, unknown>).text as string
      expect(text).toContain(doc.path)
    })
  })

  it('caps rendered list at 25 docs and adds an overflow note for more', () => {
    const docs = makeDocs(30)
    const blocks = buildDigestCard(docs)
    // header + 25 doc sections + 1 overflow note section = 27
    expect(blocks).toHaveLength(27)

    // Last block should be the overflow note
    const overflowBlock = blocks[blocks.length - 1] as Record<string, unknown>
    const text = (overflowBlock.text as Record<string, unknown>).text as string
    expect(text).toContain('5') // 30 - 25 = 5 more
  })

  it('does not add an overflow note when docs <= 25', () => {
    const docs = makeDocs(25)
    const blocks = buildDigestCard(docs)
    expect(blocks).toHaveLength(26) // header + 25 docs, no overflow note
  })

  it('handles an empty docs array gracefully', () => {
    const blocks = buildDigestCard([])
    expect(blocks).toHaveLength(1) // just the header
    const header = blocks[0] as Record<string, unknown>
    const text = (header.text as Record<string, unknown>).text as string
    expect(text).toContain('0')
  })
})

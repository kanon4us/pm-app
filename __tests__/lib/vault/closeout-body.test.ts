import { buildPrBody, staleSupportItems, CloseoutItem } from '@/lib/vault/closeout-body'

describe('staleSupportItems', () => {
  it('returns unanswered items with audience support', () => {
    const items: CloseoutItem[] = [
      { authorKey: 'alice', docPath: 'vault/support/a.md', action: 'update', answered: false, audience: 'support' },
      { authorKey: 'bob', docPath: 'vault/support/b.md', action: 'update', answered: true, audience: 'support' },
      { authorKey: 'alice', docPath: 'vault/eng/c.md', action: 'archive', answered: false, audience: 'engineering' },
      { authorKey: 'carol', docPath: 'vault/support/d.md', action: 'review', answered: false, audience: 'support' },
    ]
    const result = staleSupportItems(items)
    expect(result).toHaveLength(2)
    expect(result.map(i => i.docPath)).toEqual([
      'vault/support/a.md',
      'vault/support/d.md',
    ])
  })

  it('returns empty array when no unanswered support items exist', () => {
    const items: CloseoutItem[] = [
      { authorKey: 'alice', docPath: 'vault/support/a.md', action: 'update', answered: true, audience: 'support' },
      { authorKey: 'bob', docPath: 'vault/eng/b.md', action: 'archive', answered: false, audience: 'engineering' },
    ]
    expect(staleSupportItems(items)).toEqual([])
  })
})

describe('buildPrBody', () => {
  it('starts with Stale Support Risks block when unanswered support items exist', () => {
    const items: CloseoutItem[] = [
      { authorKey: 'alice', docPath: 'vault/support/faq.md', action: 'update', answered: false, audience: 'support' },
      { authorKey: 'alice', docPath: 'vault/guide.md', action: 'review', answered: true },
    ]
    const body = buildPrBody(items)
    expect(body.startsWith('## ⚠ Stale Support Risks')).toBe(true)
  })

  it('stale support block precedes any ### author section', () => {
    const items: CloseoutItem[] = [
      { authorKey: 'alice', docPath: 'vault/support/faq.md', action: 'update', answered: false, audience: 'support' },
      { authorKey: 'alice', docPath: 'vault/guide.md', action: 'review', answered: true },
    ]
    const body = buildPrBody(items)
    const stalePos = body.indexOf('## ⚠ Stale Support Risks')
    const authorPos = body.indexOf('### alice')
    expect(stalePos).toBeLessThan(authorPos)
  })

  it('stale block lists each unanswered support doc with its owner', () => {
    const items: CloseoutItem[] = [
      { authorKey: 'bob', docPath: 'vault/support/onboarding.md', action: 'update', answered: false, audience: 'support' },
      { authorKey: 'carol', docPath: 'vault/support/billing.md', action: 'archive', answered: false, audience: 'support' },
    ]
    const body = buildPrBody(items)
    expect(body).toContain('`vault/support/onboarding.md` (owner: bob)')
    expect(body).toContain('`vault/support/billing.md` (owner: carol)')
  })

  it('groups answered items under ### authorKey headings', () => {
    const items: CloseoutItem[] = [
      { authorKey: 'alice', docPath: 'vault/a.md', action: 'reviewed', answered: true },
      { authorKey: 'alice', docPath: 'vault/b.md', action: 'archived', answered: true },
      { authorKey: 'bob', docPath: 'vault/c.md', action: 'updated', answered: true },
    ]
    const body = buildPrBody(items)
    expect(body).toContain('### alice')
    expect(body).toContain('### bob')
    expect(body).toContain('`vault/a.md` — reviewed')
    expect(body).toContain('`vault/b.md` — archived')
    expect(body).toContain('`vault/c.md` — updated')
  })

  it('sorts authors alphabetically', () => {
    const items: CloseoutItem[] = [
      { authorKey: 'zara', docPath: 'vault/z.md', action: 'updated', answered: true },
      { authorKey: 'alice', docPath: 'vault/a.md', action: 'reviewed', answered: true },
      { authorKey: 'mike', docPath: 'vault/m.md', action: 'archived', answered: true },
    ]
    const body = buildPrBody(items)
    const alicePos = body.indexOf('### alice')
    const mikePos = body.indexOf('### mike')
    const zaraPos = body.indexOf('### zara')
    expect(alicePos).toBeLessThan(mikePos)
    expect(mikePos).toBeLessThan(zaraPos)
  })

  it('preserves item order within an author', () => {
    const items: CloseoutItem[] = [
      { authorKey: 'alice', docPath: 'vault/first.md', action: 'reviewed', answered: true },
      { authorKey: 'alice', docPath: 'vault/second.md', action: 'archived', answered: true },
      { authorKey: 'alice', docPath: 'vault/third.md', action: 'updated', answered: true },
    ]
    const body = buildPrBody(items)
    const firstPos = body.indexOf('vault/first.md')
    const secondPos = body.indexOf('vault/second.md')
    const thirdPos = body.indexOf('vault/third.md')
    expect(firstPos).toBeLessThan(secondPos)
    expect(secondPos).toBeLessThan(thirdPos)
  })

  it('returns _No changes this cycle._ when no answered items and no stale support risks', () => {
    const items: CloseoutItem[] = [
      { authorKey: 'alice', docPath: 'vault/guide.md', action: 'update', answered: false, audience: 'engineering' },
    ]
    const body = buildPrBody(items)
    expect(body).toBe('_No changes this cycle._')
  })

  it('returns _No changes this cycle._ for empty input', () => {
    expect(buildPrBody([])).toBe('_No changes this cycle._')
  })

  it('omits stale support block when there are no unanswered support items', () => {
    const items: CloseoutItem[] = [
      { authorKey: 'alice', docPath: 'vault/guide.md', action: 'reviewed', answered: true, audience: 'support' },
    ]
    const body = buildPrBody(items)
    expect(body).not.toContain('Stale Support Risks')
    expect(body).toContain('### alice')
  })

  it('renders stale block separator (---) before author sections', () => {
    const items: CloseoutItem[] = [
      { authorKey: 'alice', docPath: 'vault/support/faq.md', action: 'update', answered: false, audience: 'support' },
      { authorKey: 'alice', docPath: 'vault/guide.md', action: 'review', answered: true },
    ]
    const body = buildPrBody(items)
    const dashPos = body.indexOf('\n---\n')
    const authorPos = body.indexOf('### alice')
    expect(dashPos).toBeGreaterThan(-1)
    expect(dashPos).toBeLessThan(authorPos)
  })

  it('shows only stale block (no author sections) when all items are unanswered support docs', () => {
    const items: CloseoutItem[] = [
      { authorKey: 'bob', docPath: 'vault/support/x.md', action: 'update', answered: false, audience: 'support' },
    ]
    const body = buildPrBody(items)
    expect(body).toContain('## ⚠ Stale Support Risks')
    expect(body).not.toContain('### bob')
  })
})

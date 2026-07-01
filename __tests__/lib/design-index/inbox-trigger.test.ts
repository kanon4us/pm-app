// __tests__/lib/design-index/inbox-trigger.test.ts
import { parseDesignIndexStatuses, isDesignIndexStatus, extractFigmaUrl } from '@/lib/design-index/inbox-trigger'

describe('status parsing', () => {
  it('parses, lowercases and trims a comma list', () => {
    expect(parseDesignIndexStatuses(' In Progress , In Design ')).toEqual(['in progress', 'in design'])
  })
  it('returns [] for empty/undefined', () => {
    expect(parseDesignIndexStatuses(undefined)).toEqual([])
    expect(parseDesignIndexStatuses('')).toEqual([])
  })
  it('matches case-insensitively', () => {
    expect(isDesignIndexStatus('In Progress', ['in progress'])).toBe(true)
    expect(isDesignIndexStatus('done', ['in progress'])).toBe(false)
  })
})

describe('extractFigmaUrl', () => {
  it('reads the figma_link custom field by name', () => {
    const fields = [
      { name: 'Priority', value: 'high' },
      { name: 'Figma Link', value: 'https://figma.com/design/abc/x' },
    ]
    expect(extractFigmaUrl(fields)).toBe('https://figma.com/design/abc/x')
  })
  it('returns null when absent', () => {
    expect(extractFigmaUrl([{ name: 'Priority', value: 'high' }])).toBeNull()
    expect(extractFigmaUrl(undefined)).toBeNull()
  })
})

import {
  parsePrototypeStatuses,
  isPrototypeStatus,
  hasPrototypeTag,
  extractFviScore,
  extractObjectives,
  resolveAppIdentity,
} from '@/lib/features/gatekeeper-extract'

describe('prototype status parsing', () => {
  it('normalizes and matches case-insensitively', () => {
    const statuses = parsePrototypeStatuses('Ready for Prototype, proto ready ')
    expect(statuses).toEqual(['ready for prototype', 'proto ready'])
    expect(isPrototypeStatus('READY FOR PROTOTYPE', statuses)).toBe(true)
    expect(isPrototypeStatus('in progress', statuses)).toBe(false)
    expect(isPrototypeStatus(undefined, statuses)).toBe(false)
  })

  it('empty env means no status ever matches', () => {
    expect(isPrototypeStatus('ready for prototype', parsePrototypeStatuses(undefined))).toBe(false)
  })
})

describe('hasPrototypeTag', () => {
  it('matches the configured tag case-insensitively', () => {
    expect(hasPrototypeTag(['bug', 'Proto-Ready'])).toBe(true)
    expect(hasPrototypeTag(['bug'], 'proto-ready')).toBe(false)
    expect(hasPrototypeTag(['go'], 'GO')).toBe(true)
  })
})

describe('extractFviScore', () => {
  it('reads numeric and numeric-string FVI fields', () => {
    expect(extractFviScore([{ name: 'FVI', value: 4.2 }])).toBe(4.2)
    expect(extractFviScore([{ name: 'FVI Score', value: '3.5' }])).toBe(3.5)
  })

  it('ignores non-FVI and non-numeric fields', () => {
    expect(extractFviScore([{ name: 'Figma', value: 'url' }])).toBeNull()
    expect(extractFviScore([{ name: 'FVI', value: 'high' }])).toBeNull()
    expect(extractFviScore(undefined)).toBeNull()
  })

  it('does not confuse prefixed names like FVIewport', () => {
    expect(extractFviScore([{ name: 'FVIewport', value: 9 }])).toBeNull()
  })
})

describe('extractObjectives', () => {
  it('prefers the custom field', () => {
    expect(
      extractObjectives([{ name: 'Objectives', value: 'Ship it' }], '## Objectives\nfrom description')
    ).toBe('Ship it')
  })

  it('parses a markdown heading section, stopping at the next heading', () => {
    const desc = 'Intro\n\n## Objectives\n- faster casting\n- fewer clicks\n\n## Scope\nout'
    expect(extractObjectives(undefined, desc)).toBe('- faster casting\n- fewer clicks')
  })

  it('parses bold and colon pseudo-headings', () => {
    expect(extractObjectives(undefined, '**Goals**\nreduce churn\n\n**Notes**\nx')).toBe('reduce churn')
    expect(extractObjectives(undefined, 'Objectives:\nimprove NPS')).toBe('improve NPS')
  })

  it('returns null when absent', () => {
    expect(extractObjectives(undefined, 'just a description')).toBeNull()
    expect(extractObjectives(undefined, null)).toBeNull()
  })
})

describe('resolveAppIdentity', () => {
  it('explicit app: tag wins', () => {
    expect(resolveAppIdentity({ tags: ['app:mobile'] })).toEqual({ app: 'mobile', source: 'tag' })
  })

  it('alias tags map to slugs', () => {
    expect(resolveAppIdentity({ tags: ['education-cms'] }).app).toBe('cms')
    expect(resolveAppIdentity({ tags: ['Mobile-App'] }).app).toBe('mobile')
  })

  it('falls back to the list repo mapping', () => {
    expect(
      resolveAppIdentity({ tags: ['bug'], listRepoFullName: 'Viscap-Media/media-sync-desktop' })
    ).toEqual({ app: 'desktop', source: 'list-repo' })
  })

  it('defaults to web', () => {
    expect(resolveAppIdentity({ tags: [], listRepoFullName: null })).toEqual({ app: 'web', source: 'default' })
  })
})

import {
  parsePrototypeStatuses,
  isPrototypeStatus,
  hasPrototypeTag,
  extractFviScore,
  extractObjectives,
  resolveAppIdentity,
  isPrototypeReady,
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

  const relevantApp = (label: string, id = 'opt1') => ({
    name: 'Relevant App', type: 'labels', value: [id],
    type_config: { options: [{ id, orderindex: 0, label }] },
  })

  it('routes from the Relevant App field (Web → web)', () => {
    expect(resolveAppIdentity({ tags: [], fields: [relevantApp('Web')] }))
      .toEqual({ app: 'web', source: 'relevant-app' })
  })

  it('maps iOS/Android → mobile and Mac/Win → desktop', () => {
    expect(resolveAppIdentity({ tags: [], fields: [relevantApp('iOS')] }).app).toBe('mobile')
    expect(resolveAppIdentity({ tags: [], fields: [relevantApp('Android')] }).app).toBe('mobile')
    expect(resolveAppIdentity({ tags: [], fields: [relevantApp('Mac')] }).app).toBe('desktop')
    expect(resolveAppIdentity({ tags: [], fields: [relevantApp('Win')] }).app).toBe('desktop')
  })

  it('Relevant App wins over tag and list repo', () => {
    expect(resolveAppIdentity({
      tags: ['app:cms'],
      listRepoFullName: 'Viscap-Media/media-sync-mobile',
      fields: [relevantApp('Web')],
    })).toEqual({ app: 'web', source: 'relevant-app' })
  })

  it('unresolvable Relevant App label falls through to existing precedence', () => {
    expect(resolveAppIdentity({ tags: ['app:mobile'], fields: [relevantApp('Linux', 'z')] }).app).toBe('mobile')
  })
})

describe('isPrototypeReady', () => {
  const figma = { name: 'Figma', type: 'short_text', value: 'https://www.figma.com/design/abc?node-id=1' }
  // value 2 → "In progress" in THIS field's ordering
  const designInProgress = {
    name: 'Design states', type: 'drop_down', value: 2,
    type_config: { options: [
      { id: 'a', orderindex: 0, label: 'Approved' },
      { id: 'b', orderindex: 1, label: 'Done' },
      { id: 'c', orderindex: 2, label: 'In progress' },
    ] },
  }

  it('true when a Design states field resolves to In progress AND a figma.com link is present', () => {
    expect(isPrototypeReady([designInProgress, figma])).toBe(true)
  })

  it('resolves label per-field, never by raw value (the duplicate-field trap)', () => {
    // Same raw value 2, but here orderindex 2 = "Done" — must NOT trigger.
    const designDoneHere = {
      name: 'Design states', type: 'drop_down', value: 2,
      type_config: { options: [
        { id: 'x0', orderindex: 0, label: 'Took it' },
        { id: 'x1', orderindex: 1, label: 'In progress' },
        { id: 'x2', orderindex: 2, label: 'Done' },
      ] },
    }
    expect(isPrototypeReady([designDoneHere, figma])).toBe(false)
  })

  it('matches when ANY of duplicate Design states fields resolves to In progress', () => {
    const emptyDup = { name: 'Design states', type: 'drop_down', value: null, type_config: { options: [] } }
    expect(isPrototypeReady([emptyDup, designInProgress, figma])).toBe(true)
  })

  it('resolves an option by id as well as by orderindex', () => {
    const byId = { name: 'Design states', type: 'drop_down', value: 'c',
      type_config: { options: [{ id: 'c', label: 'In progress' }] } }
    expect(isPrototypeReady([byId, figma])).toBe(true)
  })

  it('false without a figma.com link', () => {
    expect(isPrototypeReady([designInProgress])).toBe(false)
    expect(isPrototypeReady([designInProgress, { name: 'Figma', value: '' }])).toBe(false)
    expect(isPrototypeReady([designInProgress, { name: 'Figma', value: 'https://example.com/x' }])).toBe(false)
  })

  it('false when no Design states field is In progress', () => {
    const done = { ...designInProgress, value: 1 } // "Done"
    expect(isPrototypeReady([done, figma])).toBe(false)
  })

  it('false / safe on empty or undefined fields', () => {
    expect(isPrototypeReady([])).toBe(false)
    expect(isPrototypeReady(undefined)).toBe(false)
  })
})

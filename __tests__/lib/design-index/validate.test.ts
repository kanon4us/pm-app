// __tests__/lib/design-index/validate.test.ts
import { validateDesignIndex } from '@/lib/design-index/validate'
import type { DesignIndex, ValidationContext, UserStoryStatus } from '@/lib/design-index/types'

const ctx: ValidationContext = { pathExists: () => true, knownClickupIds: null }

function baseIndex(): DesignIndex {
  return {
    version: 1,
    apps: { web: { figmaProject: '▣ WEB APP' } },
    features: [
      {
        id: 'settings-billing',
        app: 'web',
        section: 'Settings',
        feature: 'Billing',
        figmaFileKey: 'abc123',
        figmaFileUrl: 'https://figma.com/design/abc123/Settings-Billing',
        codePaths: ['app/sprint/**'],
        userStories: [
          {
            clickupId: 'US-1234',
            title: 'Default payment method',
            status: 'in-design',
            figmaPageNodeId: '1:234',
            sourceOfTruthNodeId: '1:235',
            sandboxNodeId: '1:236',
          },
        ],
      },
    ],
  }
}

describe('validateDesignIndex — structure', () => {
  it('returns no errors for a valid index', () => {
    expect(validateDesignIndex(baseIndex(), ctx)).toEqual([])
  })

  it('flags a non-numeric version', () => {
    const idx = baseIndex()
    // @ts-expect-error intentional bad value
    idx.version = 'one'
    const errors = validateDesignIndex(idx, ctx)
    expect(errors.some((e) => e.includes('version'))).toBe(true)
  })

  it('flags a feature whose app is not declared in apps', () => {
    const idx = baseIndex()
    idx.features[0].app = 'cms'
    const errors = validateDesignIndex(idx, ctx)
    expect(errors.some((e) => e.includes('cms'))).toBe(true)
  })

  it('flags an invalid user-story status', () => {
    const idx = baseIndex()
    // @ts-expect-error intentional bad value
    idx.features[0].userStories[0].status = 'wip'
    const errors = validateDesignIndex(idx, ctx)
    expect(errors.some((e) => e.includes('status'))).toBe(true)
  })
})

describe('validateDesignIndex — rules', () => {
  it('flags more than MAX_ACTIVE_STORIES active pages in one file', () => {
    const idx = baseIndex()
    idx.features[0].userStories = Array.from({ length: 6 }, (_, i) => ({
      clickupId: `US-${i}`,
      title: `Story ${i}`,
      status: 'in-design' as const,
      figmaPageNodeId: `1:${i}0`,
      sourceOfTruthNodeId: `1:${i}1`,
      sandboxNodeId: `1:${i}2`,
    }))
    const errors = validateDesignIndex(idx, ctx)
    expect(errors.some((e) => e.includes('active'))).toBe(true)
  })

  it('does NOT count shipped/archived stories against the cap', () => {
    const idx = baseIndex()
    idx.features[0].userStories = Array.from({ length: 8 }, (_, i) => ({
      clickupId: `US-${i}`,
      title: `Story ${i}`,
      status: (i < 3 ? 'in-design' : 'shipped') as UserStoryStatus,
      figmaPageNodeId: `1:${i}0`,
      sourceOfTruthNodeId: `1:${i}1`,
      sandboxNodeId: `1:${i}2`,
    }))
    expect(validateDesignIndex(idx, ctx)).toEqual([])
  })

  it('flags duplicate clickupId across features (join-key must be unique)', () => {
    const idx = baseIndex()
    idx.features.push({
      ...idx.features[0],
      id: 'settings-account',
      // same clickupId US-1234 reused — illegal
    })
    const errors = validateDesignIndex(idx, ctx)
    expect(errors.some((e) => e.includes('duplicate') && e.includes('US-1234'))).toBe(true)
  })

  it('flags duplicate feature ids', () => {
    const idx = baseIndex()
    idx.features.push({ ...idx.features[0], userStories: [] })
    const errors = validateDesignIndex(idx, ctx)
    expect(errors.some((e) => e.includes('duplicate feature id'))).toBe(true)
  })

  it('flags a codePaths glob that resolves to nothing', () => {
    const idx = baseIndex()
    idx.features[0].codePaths = ['app/does-not-exist/**']
    const errors = validateDesignIndex(idx, { pathExists: () => false, knownClickupIds: null })
    expect(errors.some((e) => e.includes('does-not-exist'))).toBe(true)
  })

  it('flags empty codePaths', () => {
    const idx = baseIndex()
    idx.features[0].codePaths = []
    const errors = validateDesignIndex(idx, ctx)
    expect(errors.some((e) => e.includes('codePaths'))).toBe(true)
  })

  it('flags a clickupId not in the known set when one is provided', () => {
    const idx = baseIndex()
    const errors = validateDesignIndex(idx, {
      pathExists: () => true,
      knownClickupIds: new Set(['US-9999']),
    })
    expect(errors.some((e) => e.includes('US-1234') && e.includes('ClickUp'))).toBe(true)
  })
})

import {
  inferApp,
  inferSectionFeature,
  inferCodePaths,
  inferClickupId,
} from '@/lib/design-migration/inference'

describe('inferApp', () => {
  it('maps known web projects to web', () => {
    expect(inferApp('Performance Hub', 'Performance Hub')).toBe('web')
    expect(inferApp('Viscap UI', 'Settings')).toBe('web')
  })
  it('maps the mobile project to mobile', () => {
    expect(inferApp('MVP Mobile App', 'Home')).toBe('mobile')
  })
  it('maps desktop to archive-bound null', () => {
    expect(inferApp('Media Sync Desktop App', 'Sync')).toBeNull()
  })
  it('returns null for unknown projects', () => {
    expect(inferApp('Totally Unknown', 'x')).toBeNull()
  })
})

describe('inferSectionFeature', () => {
  it('splits "Section — Feature" on the em dash', () => {
    expect(inferSectionFeature('Settings — Billing')).toEqual({
      section: 'Settings',
      feature: 'Billing',
    })
  })
  it('splits "Section / Feature" on the slash', () => {
    expect(inferSectionFeature('Performance Hub / Filters')).toEqual({
      section: 'Performance Hub',
      feature: 'Filters',
    })
  })
  it('uses the whole name as both when no separator', () => {
    expect(inferSectionFeature('Casting')).toEqual({ section: 'Casting', feature: 'Casting' })
  })
})

describe('inferCodePaths', () => {
  it('maps a known section to real repo dirs', () => {
    expect(inferCodePaths('Performance Hub', 'Performance Hub')).toEqual(['app/sprint/**'])
  })
  it('returns [] for an unknown section', () => {
    expect(inferCodePaths('Mystery', 'Thing')).toEqual([])
  })
})

describe('inferClickupId', () => {
  it('uses a US-#### page name when present', () => {
    expect(inferClickupId('US-1234 · Default payment', 'web-settings', 0)).toEqual({
      clickupId: 'US-1234',
      inferredFromPageName: true,
    })
  })
  it('emits a unique placeholder otherwise', () => {
    expect(inferClickupId('Some page', 'web-settings', 2)).toEqual({
      clickupId: 'PENDING-web-settings-2',
      inferredFromPageName: false,
    })
  })
})

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
  it('splits on a backslash delimiter', () => {
    expect(inferSectionFeature('Billing & Usage\\Settings')).toEqual({
      section: 'Billing & Usage',
      feature: 'Settings',
    })
  })
  it('splits on a slash with no leading space', () => {
    expect(inferSectionFeature('Concept/ Ideation')).toEqual({
      section: 'Concept',
      feature: 'Ideation',
    })
  })
})

describe('inferCodePaths', () => {
  it('anchors on the project name for single-area spaces', () => {
    expect(inferCodePaths('Perfomance Hub', 'Filter&Setting', 'x')).toEqual(['app/sprint/**'])
    expect(inferCodePaths('ActorHub', 'Casting', 'x')).toEqual([
      'app/actor-hub/**',
      'components/actors/**',
    ])
  })
  it('falls back to the section lookup for the Viscap UI monolith', () => {
    expect(inferCodePaths('Viscap UI', 'Media Library', 'Upload')).toEqual([
      'app/media/**',
      'components/media/**',
    ])
  })
  it('returns [] when neither project nor section is known', () => {
    expect(inferCodePaths('Mystery', 'Thing', 'x')).toEqual([])
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

import { inventoryToManifest, featureIdFor } from '@/lib/design-migration/manifest'
import type { FigmaInventory } from '@/lib/design-migration/types'

function inv(over: Partial<FigmaInventory['files'][0]> = {}): FigmaInventory {
  return {
    fetchedAt: '2026-06-29T00:00:00.000Z',
    files: [
      {
        projectName: 'Viscap UI',
        fileKey: 'k1',
        fileName: 'Settings — Billing',
        fileUrl: 'https://figma.com/design/k1/Settings-Billing',
        pages: [{ nodeId: '1:1', name: 'US-1234 · Default payment' }],
        frameCount: 10,
        ...over,
      },
    ],
  }
}

describe('inventoryToManifest', () => {
  it('maps a known web file to product zone with section/feature/codePaths', () => {
    const m = inventoryToManifest(inv())
    const f = m.files[0]
    expect(f.zone).toBe('product')
    expect(f.app).toBe('web')
    expect(f.targetSection).toBe('Settings')
    expect(f.targetFeature).toBe('Billing')
    expect(f.codePaths).toEqual(['app/setup/**', 'lib/field-config.ts'])
    expect(f.unassigned).toBe(false)
  })

  it('infers a US-#### clickupId from the page name', () => {
    const m = inventoryToManifest(inv())
    expect(m.files[0].pages[0]).toMatchObject({
      clickupId: 'US-1234',
      inferredFromPageName: true,
    })
  })

  it('emits unique placeholders for non-US page names', () => {
    const m = inventoryToManifest(
      inv({ pages: [{ nodeId: '1:1', name: 'Overview' }, { nodeId: '1:2', name: 'Detail' }] })
    )
    const ids = m.files[0].pages.map((p) => p.clickupId)
    expect(ids).toEqual(['PENDING-web-settings-billing-0', 'PENDING-web-settings-billing-1'])
    expect(new Set(ids).size).toBe(2)
  })

  it('flags oversized files', () => {
    const m = inventoryToManifest(inv({ frameCount: 99 }))
    expect(m.files[0].oversized).toBe(true)
  })

  it('routes desktop files to the archive zone', () => {
    const m = inventoryToManifest(inv({ projectName: 'Desktop', fileName: 'Sync' }))
    expect(m.files[0].zone).toBe('archive')
  })

  it('marks unknown-app files unassigned with empty codePaths', () => {
    const m = inventoryToManifest(inv({ projectName: 'Totally Unknown', fileName: 'Weird' }))
    const f = m.files[0]
    expect(f.unassigned).toBe(true)
    expect(f.codePaths).toEqual([])
  })

  it('builds a stable kebab featureId', () => {
    expect(featureIdFor('web', 'Settings', 'Billing')).toBe('web-settings-billing')
  })
})

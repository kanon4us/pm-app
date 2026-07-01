import { diffManifestVsInventory } from '@/lib/design-migration/verify'
import type { FigmaInventory, MigrationManifest } from '@/lib/design-migration/types'

function manifest(): MigrationManifest {
  return {
    version: 1,
    builtAt: '2026-06-29T00:00:00.000Z',
    files: [
      {
        sourceFileKey: 'k1',
        sourceFileUrl: 'https://figma.com/design/k1/Settings-Billing',
        zone: 'product',
        app: 'web',
        targetSection: 'Settings',
        targetFeature: 'Billing',
        codePaths: ['app/settings/**'],
        unassigned: false,
        oversized: false,
        pages: [{ nodeId: '1:1', name: 'US-1', clickupId: 'US-1', inferredFromPageName: true }],
      },
    ],
  }
}

function freshInv(keys: string[]): FigmaInventory {
  return {
    fetchedAt: '2026-06-29T01:00:00.000Z',
    files: keys.map((k) => ({
      projectName: '▣ WEB APP',
      fileKey: k,
      fileName: 'Settings — Billing',
      fileUrl: `https://figma.com/design/${k}/x`,
      pages: [{ nodeId: '1:1', name: 'US-1' }],
      frameCount: 5,
    })),
  }
}

describe('diffManifestVsInventory', () => {
  it('reports no drift when every manifest file is still present', () => {
    const report = diffManifestVsInventory(manifest(), freshInv(['k1']))
    expect(report.drift).toBe(false)
    expect(report.missing).toEqual([])
  })

  it('reports a manifest file missing from the fresh inventory', () => {
    const report = diffManifestVsInventory(manifest(), freshInv([]))
    expect(report.drift).toBe(true)
    expect(report.missing).toEqual(['k1'])
  })

  it('reports inventory files not present in the manifest as extra', () => {
    const report = diffManifestVsInventory(manifest(), freshInv(['k1', 'k2']))
    expect(report.drift).toBe(true)
    expect(report.extra).toEqual(['k2'])
  })
})

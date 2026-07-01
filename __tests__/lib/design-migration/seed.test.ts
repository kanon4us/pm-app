import { manifestToIndexEntries, toDesignIndex } from '@/lib/design-migration/seed'
import { validateDesignIndex } from '@/lib/design-index/validate'
import type { MigrationManifest, ManifestFile } from '@/lib/design-migration/types'

function file(over: Partial<ManifestFile> = {}): ManifestFile {
  return {
    sourceFileKey: 'k1',
    sourceFileUrl: 'https://figma.com/design/k1/Settings-Billing',
    zone: 'product',
    app: 'web',
    targetSection: 'Settings',
    targetFeature: 'Billing',
    codePaths: ['app/settings/**'],
    unassigned: false,
    oversized: false,
    pages: [
      { nodeId: '1:1', name: 'US-1234', clickupId: 'US-1234', inferredFromPageName: true },
    ],
    ...over,
  }
}

function manifest(files: ManifestFile[]): MigrationManifest {
  return { version: 1, builtAt: '2026-06-29T00:00:00.000Z', files }
}

describe('manifestToIndexEntries', () => {
  it('routes a fully-mapped file to reconciled', () => {
    const { reconciled, pending } = manifestToIndexEntries(manifest([file()]))
    expect(reconciled).toHaveLength(1)
    expect(pending).toHaveLength(0)
    expect(reconciled[0].userStories[0].status).toBe('shipped')
  })

  it('routes a placeholder-clickup file to pending', () => {
    const { reconciled, pending } = manifestToIndexEntries(
      manifest([
        file({
          pages: [
            { nodeId: '1:1', name: 'Overview', clickupId: 'PENDING-web-settings-billing-0', inferredFromPageName: false },
          ],
        }),
      ])
    )
    expect(reconciled).toHaveLength(0)
    expect(pending).toHaveLength(1)
    expect(pending[0].reason).toContain('placeholder-clickup')
  })

  it('routes an unassigned file to pending', () => {
    const { reconciled, pending } = manifestToIndexEntries(
      manifest([file({ unassigned: true, codePaths: [], app: null, targetSection: null, targetFeature: null })])
    )
    expect(reconciled).toHaveLength(0)
    expect(pending).toHaveLength(1)
  })

  it('produces a reconciled set that passes the strict validator', () => {
    const { reconciled } = manifestToIndexEntries(manifest([file()]))
    const index = toDesignIndex(reconciled)
    const errors = validateDesignIndex(index, { pathExists: () => true, knownClickupIds: null })
    expect(errors).toEqual([])
  })
})

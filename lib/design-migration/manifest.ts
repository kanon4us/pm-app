// lib/design-migration/manifest.ts
import {
  inferApp,
  inferSectionFeature,
  inferCodePaths,
  inferClickupId,
} from './inference'
import {
  OVERSIZED_FRAME_THRESHOLD,
  type FigmaInventory,
  type ManifestFile,
  type MigrationManifest,
  type Zone,
} from './types'

export function featureIdFor(app: string, section: string, feature: string): string {
  return [app, section, feature]
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Planning/diagram projects → the ◇ FLOWS & PLANNING zone (not archive). */
const FLOWS_PROJECTS = new Set([
  'Flowcharts',
  'Data Planning',
  'User Story and Planning',
  'Sales Process',
])

function zoneFor(projectName: string, app: string | null): Zone {
  if (projectName === 'Desktop' || projectName === 'Media Sync Desktop App') return 'archive'
  if (FLOWS_PROJECTS.has(projectName)) return 'flows'
  if (app) return 'product'
  return 'archive'
}

export function inventoryToManifest(inventory: FigmaInventory): MigrationManifest {
  const files: ManifestFile[] = inventory.files.map((file) => {
    const app = inferApp(file.projectName, file.fileName)
    const zone = zoneFor(file.projectName, app)
    const { section, feature } = inferSectionFeature(file.fileName)
    const codePaths = app ? inferCodePaths(file.projectName, section, feature) : []
    const featureId = app ? featureIdFor(app, section, feature) : `unassigned-${file.fileKey}`
    const unassigned = !app || codePaths.length === 0

    const pages = file.pages.map((p, i) => {
      const { clickupId, inferredFromPageName } = inferClickupId(p.name, featureId, i)
      return { nodeId: p.nodeId, name: p.name, clickupId, inferredFromPageName }
    })

    return {
      sourceFileKey: file.fileKey,
      sourceFileUrl: file.fileUrl,
      zone,
      app,
      targetSection: app ? section : null,
      targetFeature: app ? feature : null,
      codePaths,
      unassigned,
      oversized: file.frameCount > OVERSIZED_FRAME_THRESHOLD,
      pages,
    }
  })

  return { version: 1, builtAt: new Date().toISOString(), files }
}

// scripts/verify-figma-migration.ts
import * as fs from 'fs'
import * as path from 'path'
import { diffManifestVsInventory } from '../lib/design-migration/verify'
import type { FigmaInventory, MigrationManifest } from '../lib/design-migration/types'

const REPO_ROOT = path.join(__dirname, '..')
const INV_PATH = path.join(REPO_ROOT, 'design', 'figma-inventory.json')
const MANIFEST_PATH = path.join(REPO_ROOT, 'design', 'migration-manifest.json')

function read<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T
}

function main() {
  let manifest: MigrationManifest
  let fresh: FigmaInventory
  try {
    manifest = read<MigrationManifest>(MANIFEST_PATH)
    fresh = read<FigmaInventory>(INV_PATH)
  } catch (err) {
    console.error('✗ Could not read manifest/inventory:', (err as Error).message)
    process.exit(1)
  }

  const report = diffManifestVsInventory(manifest, fresh)
  if (!report.drift) {
    console.log('✓ No drift — workspace matches the manifest.')
    process.exit(0)
  }
  console.error('✗ Drift detected:')
  if (report.missing.length) console.error(`  missing from Figma: ${report.missing.join(', ')}`)
  if (report.extra.length) console.error(`  not in manifest: ${report.extra.join(', ')}`)
  process.exit(1)
}

main()

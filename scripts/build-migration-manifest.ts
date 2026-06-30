// scripts/build-migration-manifest.ts
// Phase 1: inventory → proposed migration manifest (human-reviewed before Phase 4).
import * as fs from 'fs'
import * as path from 'path'
import { inventoryToManifest } from '../lib/design-migration/manifest'
import type { FigmaInventory } from '../lib/design-migration/types'

const REPO_ROOT = path.join(__dirname, '..')
const INV_PATH = path.join(REPO_ROOT, 'design', 'figma-inventory.json')
const OUT_PATH = path.join(REPO_ROOT, 'design', 'migration-manifest.json')

function main() {
  let inventory: FigmaInventory
  try {
    inventory = JSON.parse(fs.readFileSync(INV_PATH, 'utf8')) as FigmaInventory
  } catch (err) {
    console.error(`✗ Could not read ${INV_PATH}:`, (err as Error).message)
    process.exit(1)
  }
  const manifest = inventoryToManifest(inventory)
  fs.writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + '\n')
  const unassigned = manifest.files.filter((f) => f.unassigned).length
  const oversized = manifest.files.filter((f) => f.oversized).length
  console.log(
    `✓ Wrote ${manifest.files.length} files to ${OUT_PATH} (${unassigned} unassigned, ${oversized} oversized) — review before Phase 4.`
  )
}

main()

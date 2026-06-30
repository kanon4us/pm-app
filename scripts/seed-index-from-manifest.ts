// scripts/seed-index-from-manifest.ts
import * as fs from 'fs'
import * as path from 'path'
import { manifestToIndexEntries, toDesignIndex } from '../lib/design-migration/seed'
import { validateDesignIndex } from '../lib/design-index/validate'
import type { MigrationManifest } from '../lib/design-migration/types'
import type { Feature, ValidationContext } from '../lib/design-index/types'

const REPO_ROOT = path.join(__dirname, '..')
const MANIFEST_PATH = path.join(REPO_ROOT, 'design', 'migration-manifest.json')
const INDEX_PATH = path.join(REPO_ROOT, 'design', 'figma-index.json')
const PENDING_PATH = path.join(REPO_ROOT, 'design', 'figma-index.pending.json')

function pathExists(glob: string): boolean {
  const firstStar = glob.indexOf('*')
  const staticPart = firstStar === -1 ? glob : glob.slice(0, firstStar)
  const cleaned = staticPart.replace(/\/+$/, '')
  if (!cleaned) return true
  return fs.existsSync(path.join(REPO_ROOT, cleaned))
}

function main() {
  let manifest: MigrationManifest
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as MigrationManifest
  } catch (err) {
    console.error(`✗ Could not read ${MANIFEST_PATH}:`, (err as Error).message)
    process.exit(1)
  }

  const { reconciled, pending } = manifestToIndexEntries(manifest)

  // Path-existence is the reconciled/pending boundary the pure transform can't
  // check (no fs). Demote any would-be-reconciled feature whose codePaths don't
  // resolve on disk into the pending bucket, rather than failing the whole seed.
  const seedReconciled: Feature[] = []
  for (const f of reconciled) {
    const missing = f.codePaths.filter((g) => !pathExists(g))
    if (missing.length === 0) {
      seedReconciled.push(f)
    } else {
      pending.push({
        featureId: f.id,
        reason: ['unassigned-codepaths'],
        partial: { figmaFileKey: f.figmaFileKey, figmaFileUrl: f.figmaFileUrl, codePaths: f.codePaths },
      })
    }
  }

  // The surviving reconciled set must be strictly valid or we write nothing.
  const ctx: ValidationContext = { pathExists, knownClickupIds: null }
  const index = toDesignIndex(seedReconciled)
  const errors = validateDesignIndex(index, ctx)
  if (errors.length > 0) {
    console.error(`✗ Reconciled set failed validation (${errors.length}) — writing nothing:`)
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }

  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n')
  fs.writeFileSync(
    PENDING_PATH,
    JSON.stringify({ version: 1, entries: pending }, null, 2) + '\n'
  )
  console.log(
    `✓ Seeded ${seedReconciled.length} reconciled → figma-index.json, ${pending.length} pending → figma-index.pending.json`
  )
}

main()

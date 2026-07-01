// scripts/validate-design-index.ts
import * as fs from 'fs'
import * as path from 'path'
import { validateDesignIndex } from '../lib/design-index/validate'
import type { DesignIndex, ValidationContext } from '../lib/design-index/types'

const REPO_ROOT = path.join(__dirname, '..')
const INDEX_PATH = path.join(REPO_ROOT, 'design', 'figma-index.json')

/**
 * Dependency-free glob existence check. Reduces a glob to its static prefix
 * (everything before the first `*`) and asserts that prefix exists on disk.
 * Catches deleted dirs and typo'd paths — enough for an anti-rot guard.
 */
function pathExists(glob: string): boolean {
  const firstStar = glob.indexOf('*')
  const staticPart = firstStar === -1 ? glob : glob.slice(0, firstStar)
  // Trim a trailing partial segment / slash so "app/foo/**" → "app/foo".
  const cleaned = staticPart.replace(/\/+$/, '')
  if (!cleaned) return true // pattern like "**" — treat as repo root, always exists
  return fs.existsSync(path.join(REPO_ROOT, cleaned))
}

function loadIndex(): DesignIndex {
  const raw = fs.readFileSync(INDEX_PATH, 'utf8')
  return JSON.parse(raw) as DesignIndex
}

function main() {
  let index: DesignIndex
  try {
    index = loadIndex()
  } catch (err) {
    console.error(`✗ Could not read/parse ${INDEX_PATH}:`, (err as Error).message)
    process.exit(1)
  }

  // ClickUp check is opt-in: only enforced when a token-backed id set is present.
  // Kept null here so the guard runs in CI without secrets; the ClickUp webhook
  // subsystem (separate plan) will populate this.
  const ctx: ValidationContext = { pathExists, knownClickupIds: null }

  const errors = validateDesignIndex(index, ctx)
  if (errors.length > 0) {
    console.error(`✗ design/figma-index.json failed validation (${errors.length}):`)
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }

  console.log('✓ design/figma-index.json is valid.')
  process.exit(0)
}

main()

// scripts/figma-inventory.ts
// Phase 0: read-only enumeration of the Figma workspace → design/figma-inventory.json.
import * as dotenv from 'dotenv'
import * as fs from 'fs'
import * as path from 'path'

// Load .env.local (Next.js convention) so FIGMA_MIGRATION_TOKEN / FIGMA_TEAM_ID
// are available without exporting them in the shell.
dotenv.config({ path: '.env.local' })
import {
  fetchTeamProjects,
  fetchProjectFiles,
  fetchFileDocument,
} from '../lib/figma/client'
import { toInventoryFile } from '../lib/design-migration/figma-map'
import type { FigmaInventory, FigmaInventoryFile } from '../lib/design-migration/types'

const REPO_ROOT = path.join(__dirname, '..')
const OUT_PATH = path.join(REPO_ROOT, 'design', 'figma-inventory.json')

const TOKEN = process.env.FIGMA_MIGRATION_TOKEN
const TEAM_ID = process.env.FIGMA_TEAM_ID

async function main() {
  if (!TOKEN || !TEAM_ID) {
    console.error('✗ Set FIGMA_MIGRATION_TOKEN and FIGMA_TEAM_ID in the environment.')
    process.exit(1)
  }

  const files: FigmaInventoryFile[] = []
  const projects = await fetchTeamProjects(TOKEN, TEAM_ID)
  console.log(`Found ${projects.length} projects.`)

  for (const project of projects) {
    const projFiles = await fetchProjectFiles(TOKEN, project.id)
    console.log(`• ${project.name} (${projFiles.length} files)`)
    for (const f of projFiles) {
      try {
        const detail = await fetchFileDocument(TOKEN, f.key)
        files.push(toInventoryFile(project.name, f.key, f.name, detail as object))
      } catch (err) {
        console.warn(`  ! skipping ${f.name} (${f.key}): ${(err as Error).message}`)
      }
    }
  }

  const inventory: FigmaInventory = { fetchedAt: new Date().toISOString(), files }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true })
  fs.writeFileSync(OUT_PATH, JSON.stringify(inventory, null, 2) + '\n')
  console.log(`✓ Wrote ${files.length} files to ${OUT_PATH}`)
}

main().catch((err) => {
  console.error('✗ inventory failed:', (err as Error).message)
  process.exit(1)
})

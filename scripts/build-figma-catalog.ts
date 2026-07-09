// scripts/build-figma-catalog.ts
// Regenerates design/figma-antd-catalog.json from the published antd team library.
// Run: npm run figma:catalog   (needs FIGMA_MIGRATION_TOKEN or FIGMA_ACCESS_TOKEN + FIGMA_TEAM_ID)
import * as dotenv from 'dotenv'
// Next.js keeps secrets in .env.local, which plain `dotenv/config` (loads .env)
// would miss — match the other scripts/*.ts and load it explicitly.
dotenv.config({ path: '.env.local' })
import fs from 'node:fs'
import path from 'node:path'
import { figmaGetJson } from '../lib/figma/client'
import type { CatalogComponent, ComponentCatalog } from '../lib/figma/component-catalog'

const FIGMA_API = 'https://api.figma.com'
const TOKEN = process.env.FIGMA_MIGRATION_TOKEN ?? process.env.FIGMA_ACCESS_TOKEN
const TEAM_ID = process.env.FIGMA_TEAM_ID ?? '1155279883633947706'
const LIBRARY_FILE_KEY = process.env.FIGMA_ANTD_LIBRARY_KEY ?? 'DpIOFPBpzpVVmZyZvzPJS4'
const ICON_NAME_RE = /icon/i

interface ComponentSetMeta { key: string; name: string; node_id: string }

async function main() {
  if (!TOKEN) {
    console.error('✗ Set FIGMA_MIGRATION_TOKEN or FIGMA_ACCESS_TOKEN.')
    process.exit(1)
  }
  // /v1/teams/{id}/component_sets paginates — follow the cursor until exhausted.
  const allSets: ComponentSetMeta[] = []
  let after: string | undefined
  do {
    const url = `${FIGMA_API}/v1/teams/${TEAM_ID}/component_sets?page_size=1000${after ? `&after=${after}` : ''}`
    const res = (await figmaGetJson(TOKEN, url)) as {
      meta?: { component_sets?: ComponentSetMeta[]; cursor?: { after?: string | number } }
    }
    allSets.push(...(res.meta?.component_sets ?? []))
    const next = res.meta?.cursor?.after
    after = next != null ? String(next) : undefined
  } while (after)

  const sets = allSets.filter((s) => !ICON_NAME_RE.test(s.name))

  const nodeIds = [...new Set(sets.map((s) => s.node_id))]
  const variantsByNodeId = new Map<string, Record<string, string[]>>()
  const BATCH = 50
  for (let i = 0; i < nodeIds.length; i += BATCH) {
    const batch = nodeIds.slice(i, i + BATCH)
    const nodesRes = (await figmaGetJson(
      TOKEN,
      `${FIGMA_API}/v1/files/${LIBRARY_FILE_KEY}/nodes?ids=${encodeURIComponent(batch.join(','))}`
    )) as { nodes?: Record<string, { document?: { componentPropertyDefinitions?: Record<string, { type?: string; variantOptions?: string[] }> } } | null> }
    for (const [nodeId, entry] of Object.entries(nodesRes.nodes ?? {})) {
      // Figma returns null for a requested node it can't resolve — skip those.
      const defs = entry?.document?.componentPropertyDefinitions ?? {}
      const variants: Record<string, string[]> = {}
      for (const [prop, def] of Object.entries(defs)) {
        if (def.type === 'VARIANT' && Array.isArray(def.variantOptions)) variants[prop] = def.variantOptions
      }
      if (Object.keys(variants).length) variantsByNodeId.set(nodeId, variants)
    }
  }

  const components: CatalogComponent[] = sets.map((s) => {
    const variants = variantsByNodeId.get(s.node_id)
    return { name: s.name, key: s.key, type: 'set' as const, ...(variants ? { variants } : {}) }
  })

  const catalog: ComponentCatalog = {
    generatedAt: new Date().toISOString(),
    libraryFileKey: LIBRARY_FILE_KEY,
    components,
  }
  const out = path.join(process.cwd(), 'design', 'figma-antd-catalog.json')
  fs.writeFileSync(out, JSON.stringify(catalog, null, 2) + '\n')
  console.log(`✓ Wrote ${components.length} component sets to ${out}`)
}

main().catch((e) => { console.error(e); process.exit(1) })

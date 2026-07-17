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
import { mergeCatalogSources } from '../lib/figma/catalog-merge'

const FIGMA_API = 'https://api.figma.com'
// Prefer FIGMA_ACCESS_TOKEN: FIGMA_MIGRATION_TOKEN is expired/revoked (401/403).
const TOKEN = process.env.FIGMA_ACCESS_TOKEN ?? process.env.FIGMA_MIGRATION_TOKEN
const TEAM_ID = process.env.FIGMA_TEAM_ID ?? '1155279883633947706'
const LIBRARY_FILE_KEY = process.env.FIGMA_ANTD_LIBRARY_KEY ?? 'DpIOFPBpzpVVmZyZvzPJS4'
const VISCAP_LIBRARY_FILE_KEY = process.env.FIGMA_VISCAP_LIBRARY_KEY ?? 'L2WtMQ5D7np7KDJ2vm3Ly0'
const ICON_NAME_RE = /icon/i

interface ComponentSetMeta { key: string; name: string; node_id: string }

async function fetchVariants(
  token: string,
  fileKey: string,
  sets: ComponentSetMeta[],
): Promise<Map<string, Record<string, string[]>>> {
  const nodeIds = [...new Set(sets.map((s) => s.node_id))]
  const variantsByNodeId = new Map<string, Record<string, string[]>>()
  const BATCH = 50
  for (let i = 0; i < nodeIds.length; i += BATCH) {
    const batch = nodeIds.slice(i, i + BATCH)
    const nodesRes = (await figmaGetJson(
      token,
      `${FIGMA_API}/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(batch.join(','))}`
    )) as { nodes?: Record<string, { document?: { componentPropertyDefinitions?: Record<string, { type?: string; variantOptions?: string[] }> } } | null> }
    for (const [nodeId, entry] of Object.entries(nodesRes.nodes ?? {})) {
      const defs = entry?.document?.componentPropertyDefinitions ?? {}
      const variants: Record<string, string[]> = {}
      for (const [prop, def] of Object.entries(defs)) {
        if (def.type === 'VARIANT' && Array.isArray(def.variantOptions)) variants[prop] = def.variantOptions
      }
      if (Object.keys(variants).length) variantsByNodeId.set(nodeId, variants)
    }
  }
  return variantsByNodeId
}

async function fetchFileComponentSets(token: string, fileKey: string): Promise<ComponentSetMeta[]> {
  const res = (await figmaGetJson(
    token,
    `${FIGMA_API}/v1/files/${fileKey}/component_sets`
  )) as { meta?: { component_sets?: ComponentSetMeta[] } }
  return res.meta?.component_sets ?? []
}

async function main() {
  if (!TOKEN) {
    console.error('✗ Set FIGMA_MIGRATION_TOKEN or FIGMA_ACCESS_TOKEN.')
    process.exit(1)
  }
  // antd — TEAM-sourced, paginated
  const antdSets: ComponentSetMeta[] = []
  let after: string | undefined
  do {
    const url = `${FIGMA_API}/v1/teams/${TEAM_ID}/component_sets?page_size=1000${after ? `&after=${after}` : ''}`
    const res = (await figmaGetJson(TOKEN, url)) as {
      meta?: { component_sets?: ComponentSetMeta[]; cursor?: { after?: string | number } }
    }
    antdSets.push(...(res.meta?.component_sets ?? []))
    const next = res.meta?.cursor?.after
    after = next != null ? String(next) : undefined
  } while (after)
  const antdFiltered = antdSets.filter((s) => !ICON_NAME_RE.test(s.name))
  const antdVariants = await fetchVariants(TOKEN, LIBRARY_FILE_KEY, antdFiltered)
  const antdComponents: CatalogComponent[] = antdFiltered.map((s) => {
    const variants = antdVariants.get(s.node_id)
    return { name: s.name, key: s.key, type: 'set' as const, library: 'antd' as const, ...(variants ? { variants } : {}) }
  })

  // Viscap — FILE-sourced (the real design system)
  const viscapSets = (await fetchFileComponentSets(TOKEN, VISCAP_LIBRARY_FILE_KEY)).filter((s) => !ICON_NAME_RE.test(s.name))
  const viscapVariants = await fetchVariants(TOKEN, VISCAP_LIBRARY_FILE_KEY, viscapSets)
  const viscapComponents: CatalogComponent[] = viscapSets.map((s) => {
    const variants = viscapVariants.get(s.node_id)
    return { name: s.name, key: s.key, type: 'set' as const, library: 'viscap' as const, ...(variants ? { variants } : {}) }
  })

  const components = mergeCatalogSources(viscapComponents, antdComponents)

  const catalog: ComponentCatalog = {
    generatedAt: new Date().toISOString(),
    libraryFileKey: LIBRARY_FILE_KEY,
    components,
  }
  const out = path.join(process.cwd(), 'design', 'figma-antd-catalog.json')
  fs.writeFileSync(out, JSON.stringify(catalog, null, 2) + '\n')
  console.log(`✓ Wrote ${components.length} sets (${viscapComponents.length} viscap + ${antdComponents.length} antd) to ${out}`)
}

main().catch((e) => { console.error(e); process.exit(1) })

// lib/figma/component-catalog.ts
// Loads the committed antd library catalog (name → component-set key + the
// real Figma variant property options). Consumed ONLY by the layout resolver —
// the plugin receives already-resolved keys, so it never reads this.
// Regenerate with `npm run figma:catalog` when the Figma library changes.
import fs from 'node:fs'
import path from 'node:path'

export interface CatalogComponent {
  name: string
  key: string
  type: 'set' | 'component'
  /** propName → allowed option strings, read from the set's VARIANT property defs. */
  variants?: Record<string, string[]>
}

export interface ComponentCatalog {
  generatedAt: string
  libraryFileKey: string
  components: CatalogComponent[]
}

let cache: ComponentCatalog | null = null

/** Loads + caches design/figma-antd-catalog.json. */
export function getComponentCatalog(): ComponentCatalog {
  if (cache) return cache
  const raw = fs.readFileSync(
    path.join(process.cwd(), 'design', 'figma-antd-catalog.json'),
    'utf8'
  )
  cache = JSON.parse(raw) as ComponentCatalog
  return cache
}

/** Case-insensitive exact-name lookup. */
export function findComponentByName(cat: ComponentCatalog, name: string): CatalogComponent | undefined {
  const lower = name.toLowerCase()
  return cat.components.find((c) => c.name.toLowerCase() === lower)
}

/** Fast key → component map for the resolver's validation pass. */
export function catalogByKey(cat: ComponentCatalog): Map<string, CatalogComponent> {
  return new Map(cat.components.map((c) => [c.key, c]))
}

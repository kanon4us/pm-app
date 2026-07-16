// lib/figma/catalog-merge.ts
// Merges catalog sources with Viscap priority: every Viscap component is kept;
// antd components fill gaps but never override a key the Viscap library already
// provides. Dedupe is by component-set key.
import type { CatalogComponent } from './component-catalog'

export function mergeCatalogSources(
  viscap: CatalogComponent[],
  antd: CatalogComponent[],
): CatalogComponent[] {
  const byKey = new Map<string, CatalogComponent>()
  for (const c of viscap) byKey.set(c.key, c)
  for (const c of antd) if (!byKey.has(c.key)) byKey.set(c.key, c)
  return [...byKey.values()]
}

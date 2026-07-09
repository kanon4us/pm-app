// figma-plugin/src/build-layout.ts
// Pure, deterministic walker: turns a FigmaLayoutSpec into Figma nodes via an
// injected FigmaApi. No dependency on the `figma` global, so it is fully unit-
// testable outside Figma. All Figma-side judgment (which component, which
// variant) was made upstream by the resolver; this only executes.
import type { FigmaLayoutSpec, LayoutNode } from '../../lib/figma/layout-spec'
import {
  type FigmaApi, type FPage, type FFrame, type FComponentSet,
  FALLBACK_FONT, APP_FONT,
} from './figma-api'

export interface BuildHooks {
  /** Ask the user before archiving existing pages. Return false to abort. */
  confirmArchive(pageNames: string[]): Promise<boolean>
  /** Called every ~20 nodes so the caller can yield the UI thread. */
  onYield(): Promise<void>
}

export interface BuildSummary {
  pagesBuilt: number
  pagesArchived: number
  instancesPlaced: number
  placeholders: number
  framesBuilt: number
  fontSubstituted: boolean
  aborted: boolean
  failures: string[]
}

const YIELD_EVERY = 20

const TEXT_SIZE: Record<string, number> = { heading: 20, body: 14, caption: 12 }

export async function buildLayout(
  api: FigmaApi,
  spec: FigmaLayoutSpec,
  hooks: BuildHooks
): Promise<BuildSummary> {
  const summary: BuildSummary = {
    pagesBuilt: 0, pagesArchived: 0, instancesPlaced: 0, placeholders: 0,
    framesBuilt: 0, fontSubstituted: false, aborted: false, failures: [],
  }

  // 1. Archive confirmation up-front (non-destructive: rename, never remove).
  const targetNames = spec.pages.map((p) => p.name)
  const collisions = api.pages.filter((p) => targetNames.includes(p.name))
  if (collisions.length > 0) {
    const ok = await hooks.confirmArchive(collisions.map((p) => p.name))
    if (!ok) { summary.aborted = true; return summary }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    for (const p of collisions) {
      p.name = `${p.name} (Archived ${stamp})`
      summary.pagesArchived++
    }
  }

  // 2. Build each page.
  const importCache = new Map<string, FComponentSet | null>()
  let sinceYield = 0
  const maybeYield = async () => {
    if (++sinceYield >= YIELD_EVERY) { sinceYield = 0; await hooks.onYield() }
  }

  const loadFont = async (): Promise<{ family: string; style: string }> => {
    try {
      await api.loadFontAsync(APP_FONT)
      return APP_FONT
    } catch {
      summary.fontSubstituted = true
      await api.loadFontAsync(FALLBACK_FONT)
      return FALLBACK_FONT
    }
  }

  const importSet = async (key: string): Promise<FComponentSet | null> => {
    if (importCache.has(key)) return importCache.get(key) ?? null
    try {
      const set = await api.importComponentSetByKeyAsync(key)
      importCache.set(key, set)
      return set
    } catch (err) {
      importCache.set(key, null)
      summary.failures.push(`import ${key}: ${err instanceof Error ? err.message : 'failed'}`)
      return null
    }
  }

  const buildNode = async (node: LayoutNode, parent: FPage | FFrame): Promise<void> => {
    await maybeYield()
    switch (node.type) {
      case 'instance': {
        const set = await importSet(node.componentKey)
        if (!set) { buildPlaceholder({ type: 'placeholder', name: node.name ?? node.componentKey, note: 'import failed' }, parent); return }
        const inst = set.defaultVariant.createInstance()
        if (node.name) inst.name = node.name
        if (node.variant && Object.keys(node.variant).length) {
          try { inst.setProperties(node.variant) } catch (e) { summary.failures.push(`variant ${node.componentKey}: ${e instanceof Error ? e.message : 'failed'}`) }
        }
        parent.appendChild(inst)
        summary.instancesPlaced++
        return
      }
      case 'frame': {
        const frame = api.createFrame()
        frame.name = node.name ?? 'Frame'
        frame.layoutMode = node.layout
        frame.itemSpacing = node.spacing ?? 8
        const pad = node.padding ?? 16
        frame.paddingTop = frame.paddingRight = frame.paddingBottom = frame.paddingLeft = pad
        frame.primaryAxisSizingMode = 'AUTO'
        frame.counterAxisSizingMode = 'AUTO'
        parent.appendChild(frame)
        summary.framesBuilt++
        for (const child of node.children) await buildNode(child, frame)
        return
      }
      case 'text': {
        const font = await loadFont()
        const t = api.createText()
        t.fontName = font
        t.characters = node.characters
        t.fontSize = TEXT_SIZE[node.style ?? 'body'] ?? 14
        parent.appendChild(t)
        return
      }
      case 'placeholder': {
        buildPlaceholder(node, parent)
        return
      }
    }
  }

  const buildPlaceholder = (node: { type: 'placeholder'; name: string; note?: string }, parent: FPage | FFrame) => {
    const frame = api.createFrame()
    frame.name = `⬚ ${node.name}${node.note ? ` — ${node.note}` : ''}`
    frame.layoutMode = 'VERTICAL'
    frame.paddingTop = frame.paddingRight = frame.paddingBottom = frame.paddingLeft = 16
    frame.dashPattern = [4, 4]
    parent.appendChild(frame)
    summary.placeholders++
  }

  for (const page of spec.pages) {
    const fpage = api.createPage()
    fpage.name = page.name
    for (const node of page.nodes) await buildNode(node, fpage)
    summary.pagesBuilt++
  }

  return summary
}

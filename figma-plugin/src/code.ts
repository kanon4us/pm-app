// figma-plugin/src/code.ts — main-thread shell. Uses the real `figma` global,
// adapts it to FigmaApi, and delegates the actual building to the pure walker.
import { buildLayout, type BuildHooks, type BuildSummary } from './build-layout'
import type { FigmaApi } from './figma-api'
import type { FigmaLayoutSpec } from '../../lib/figma/layout-spec'

interface PublishPayload { featureId: string; token: string; baseUrl: string }

figma.showUI(__html__, { width: 340, height: 260 })

// The real figma global already matches the FigmaApi shape structurally; adapt
// the couple of members whose names differ (pages, factory methods). The
// `as unknown as` casts exist because the real types are richer than FigmaApi.
const api: FigmaApi = {
  get pages() { return figma.root.children as unknown as FigmaApi['pages'] },
  createPage: () => figma.createPage() as unknown as FigmaApi['pages'][number],
  createFrame: () => figma.createFrame() as unknown as ReturnType<FigmaApi['createFrame']>,
  createText: () => figma.createText() as unknown as ReturnType<FigmaApi['createText']>,
  importComponentSetByKeyAsync: (key) => figma.importComponentSetByKeyAsync(key) as unknown as ReturnType<FigmaApi['importComponentSetByKeyAsync']>,
  loadFontAsync: (font) => figma.loadFontAsync(font),
}

figma.ui.onmessage = async (msg: { type: string; payload?: string }) => {
  if (msg.type !== 'publish') return
  let parsed: PublishPayload
  try {
    parsed = JSON.parse(msg.payload ?? '')
    if (!parsed.featureId || !parsed.token || !parsed.baseUrl) throw new Error('missing fields')
  } catch {
    figma.ui.postMessage({ type: 'error', message: 'Invalid publish payload — re-copy it from pm-app.' })
    return
  }

  // 1. Fetch the resolved layout spec (token-authed). Never log the token.
  let spec: FigmaLayoutSpec
  try {
    const res = await fetch(`${parsed.baseUrl}/api/features/${parsed.featureId}/figma-layout`, {
      headers: { Authorization: `Bearer ${parsed.token}` },
    })
    if (!res.ok) throw new Error(`layout fetch ${res.status}`)
    spec = (await res.json()) as FigmaLayoutSpec
  } catch (e) {
    figma.ui.postMessage({ type: 'error', message: `Could not fetch layout: ${e instanceof Error ? e.message : 'error'}` })
    return
  }

  // 2. Build, with a confirm-before-archive hook + UI-thread yields.
  const hooks: BuildHooks = {
    confirmArchive: async (names) => {
      figma.ui.postMessage({ type: 'confirm-archive', names })
      return await new Promise<boolean>((resolve) => {
        const handler = (m: { type: string; ok?: boolean }) => {
          if (m.type === 'confirm-archive-result') { figma.ui.off('message', handler as never); resolve(!!m.ok) }
        }
        figma.ui.on('message', handler as never)
      })
    },
    onYield: () => new Promise((r) => setTimeout(r, 0)),
  }

  let summary: BuildSummary
  try {
    summary = await buildLayout(api, spec, hooks)
  } catch (e) {
    figma.ui.postMessage({ type: 'error', message: `Build failed: ${e instanceof Error ? e.message : 'error'}` })
    return
  }
  if (summary.aborted) { figma.notify('Publish cancelled — no changes made.'); return }

  // 3. Write the file key back (best-effort). figma.fileKey is undefined for an
  // unsaved file or a plugin without file access — skip rather than POST a body
  // the endpoint would reject (400), and record it in the summary.
  const fileKey = figma.fileKey
  if (fileKey) {
    try {
      await fetch(`${parsed.baseUrl}/api/features/${parsed.featureId}/figma-file`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${parsed.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileKey }),
      })
    } catch {
      summary.failures.push('writeback: could not POST figma-file')
    }
  } else {
    summary.failures.push('writeback skipped: figma.fileKey unavailable (save the file first)')
  }

  // 4. Summary.
  const parts = [
    `${summary.pagesBuilt} page(s)`,
    `${summary.instancesPlaced} instances`,
    summary.placeholders ? `${summary.placeholders} placeholder(s)` : '',
    summary.pagesArchived ? `${summary.pagesArchived} archived` : '',
    summary.fontSubstituted ? 'font substituted (Inter)' : '',
    summary.failures.length ? `${summary.failures.length} issue(s)` : '',
  ].filter(Boolean)
  figma.notify(`Published: ${parts.join(' · ')}`)
  figma.ui.postMessage({ type: 'done', summary })
}

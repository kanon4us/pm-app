# Publish Stitch → Figma — Plan 2 (the Figma plugin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Prerequisite:** Plan 1 is merged (or at least present on this branch) — `GET /api/features/[id]/figma-layout` returns a real `FigmaLayoutSpec`, and `lib/figma/layout-spec.ts` exists (this plugin `import type`s it).

**Goal:** A local **development** Figma plugin (`figma-plugin/`) that fetches a resolved `FigmaLayoutSpec` from pm-app and deterministically builds it as real antd library instances + auto-layout frames — non-destructively (archives existing same-named pages, never wipes them), yielding to the UI thread, with a font fallback — then writes the file key back to pm-app.

**Architecture:** The core is a **pure layout-spec walker** (`build-layout.ts`) that depends only on a small injected `FigmaApi` interface — so it is fully unit-testable outside Figma with a fake API (the risky mechanic — `importComponentSetByKeyAsync` → `createInstance` → auto-layout — is already validated by a throwaway plugin). A thin `code.ts` shell adapts the real `figma` global to `FigmaApi`, drives the walker, handles the archive-confirm and writeback, and is validated manually. Auth is a pasted publish payload `{ featureId, token, baseUrl }` (no `clientStorage`).

**Tech Stack:** Figma Plugin API (`@figma/plugin-typings`), TypeScript, esbuild (bundles `code.ts` → `code.js`), a static `ui.html`. Walker tests run in the repo's existing jest **node** project (ts-jest).

**Reference spec:** `docs/superpowers/specs/2026-07-08-publish-stitch-to-figma-design.md` (Component E) — read it before starting.

---

## File Structure

**Create:**
- `figma-plugin/manifest.json` — dev-plugin manifest (`networkAccess.allowedDomains`).
- `figma-plugin/tsconfig.json` — plugin-scoped TS config (`@figma/plugin-typings`, includes the one shared type file).
- `figma-plugin/build.mjs` — esbuild bundling script.
- `figma-plugin/src/figma-api.ts` — the minimal `FigmaApi` interface the walker depends on + the node-tree types.
- `figma-plugin/src/build-layout.ts` — the **pure walker** (no `figma` global).
- `figma-plugin/src/code.ts` — the Figma-API shell (main thread; uses the real `figma` global).
- `figma-plugin/ui.html` — textarea + Publish button.
- `figma-plugin/README.md` — import + run instructions.
- `__tests__/figma-plugin/build-layout.test.ts` — walker unit tests (with a fake `FigmaApi`).

**Modify:**
- `tsconfig.json` — add `figma-plugin` to `exclude` (it has its own config; keep it out of the Next typecheck).
- `package.json` — add `plugin:build` script + `esbuild` / `@figma/plugin-typings` devDeps.

---

## Task 1: Plugin scaffold

**Files:**
- Create: `figma-plugin/manifest.json`, `figma-plugin/tsconfig.json`, `figma-plugin/build.mjs`, `figma-plugin/ui.html`, `figma-plugin/README.md`
- Modify: `tsconfig.json`, `package.json`

- [ ] **Step 1: Write `figma-plugin/manifest.json`**

```json
{
  "name": "Viscap — Publish Stitch",
  "id": "viscap-publish-stitch-dev",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "editorType": ["figma"],
  "networkAccess": {
    "allowedDomains": ["https://viscap.edgefixautomation.com", "http://localhost:3000"],
    "reasoning": "Fetches the resolved layout spec from pm-app and posts the published file key back."
  }
}
```

> `allowedDomains` must list every `baseUrl` a payload might carry. Prod host + localhost cover the dev-plugin use. Add others if the PM runs pm-app elsewhere.

- [ ] **Step 2: Write `figma-plugin/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM"],
    "strict": true,
    "typeRoots": ["../node_modules/@figma", "../node_modules/@types"],
    "moduleResolution": "bundler",
    "module": "ESNext",
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "../lib/figma/layout-spec.ts"]
}
```

- [ ] **Step 3: Write `figma-plugin/build.mjs`**

```js
// figma-plugin/build.mjs — bundles the main-thread code to a single code.js.
import { build } from 'esbuild'

await build({
  entryPoints: ['figma-plugin/src/code.ts'],
  bundle: true,
  target: 'es2020',
  format: 'iife',
  outfile: 'figma-plugin/code.js',
  logLevel: 'info',
})
```

- [ ] **Step 4: Write a placeholder `figma-plugin/ui.html`** (fleshed out in Task 5)

```html
<!DOCTYPE html>
<html><body><p>Publish UI (wired in Task 5)</p></body></html>
```

- [ ] **Step 5: Add devDeps + build script**

Run:

```bash
npm install --save-dev esbuild @figma/plugin-typings
```

In `package.json` `scripts`, add:

```json
    "plugin:build": "node figma-plugin/build.mjs",
```

- [ ] **Step 6: Keep the plugin out of the Next typecheck**

In the root `tsconfig.json`, add `"figma-plugin"` to the `exclude` array:

```json
  "exclude": ["node_modules", "figma-plugin"]
```

- [ ] **Step 7: Write `figma-plugin/README.md`**

````markdown
# Viscap — Publish Stitch (dev plugin)

Builds a feature's resolved Figma layout spec (from pm-app) into the currently
open Figma file, as real antd library instances.

## Install (once)
1. `npm run plugin:build` (from repo root) — produces `figma-plugin/code.js`.
2. Figma desktop → Plugins → Development → **Import plugin from manifest…** →
   pick `figma-plugin/manifest.json`.

## Use
1. In pm-app's Feature Editor, open **Design → Figma** and click
   **Copy Publish Payload**.
2. Create/open the feature's Figma file in the correct Application project.
3. Run the plugin, paste the payload, click **Publish**.
4. It builds a "Components" page + one "Workflow: …" page per workflow. If those
   pages already exist they are **archived (renamed)**, never deleted — confirm
   when prompted.
````

- [ ] **Step 8: Verify the build wiring (with a stub code.ts)**

Create a temporary `figma-plugin/src/code.ts`:

```ts
figma.closePlugin('stub')
```

Run: `npm run plugin:build`
Expected: writes `figma-plugin/code.js`, exit 0.

- [ ] **Step 9: Commit**

```bash
git add figma-plugin package.json tsconfig.json
git commit -m "chore(plugin): scaffold figma-plugin (manifest, esbuild, tsconfig)"
```

---

## Task 2: The `FigmaApi` interface

**Files:**
- Create: `figma-plugin/src/figma-api.ts`

This is the seam that makes the walker testable. It declares *only* the Figma
Plugin-API surface the walker uses — a subset the fake can implement fully.

- [ ] **Step 1: Write `figma-plugin/src/figma-api.ts`**

```ts
// figma-plugin/src/figma-api.ts
// The minimal Figma Plugin-API surface the pure walker depends on. The real
// shell (code.ts) adapts the global `figma` to this; tests inject a fake.

export interface FontName { family: string; style: string }

export interface FNode {
  type: string
  name: string
  remove(): void
}

export interface FInstance extends FNode {
  setProperties(props: Record<string, string>): void
}

export interface FComponentSet {
  defaultVariant: { createInstance(): FInstance }
}

export interface FText extends FNode {
  fontName: FontName
  characters: string
  fontSize: number
}

export interface FFrame extends FNode {
  layoutMode: 'NONE' | 'HORIZONTAL' | 'VERTICAL'
  itemSpacing: number
  paddingTop: number
  paddingRight: number
  paddingBottom: number
  paddingLeft: number
  primaryAxisSizingMode: 'FIXED' | 'AUTO'
  counterAxisSizingMode: 'FIXED' | 'AUTO'
  dashPattern: number[]
  appendChild(child: FNode): void
}

export interface FPage extends FNode {
  appendChild(child: FNode): void
}

/** Everything the walker needs — nothing it doesn't. */
export interface FigmaApi {
  /** Existing pages, so the walker can detect + archive same-named ones. */
  pages: FPage[]
  createPage(): FPage
  createFrame(): FFrame
  createText(): FText
  importComponentSetByKeyAsync(key: string): Promise<FComponentSet>
  loadFontAsync(font: FontName): Promise<void>
}

export const FALLBACK_FONT: FontName = { family: 'Inter', style: 'Regular' }
export const APP_FONT: FontName = { family: 'Montserrat', style: 'Regular' }
```

- [ ] **Step 2: Commit**

```bash
git add figma-plugin/src/figma-api.ts
git commit -m "feat(plugin): FigmaApi seam for the pure walker"
```

---

## Task 3: The pure layout-spec walker (TDD)

**Files:**
- Create: `__tests__/figma-plugin/build-layout.test.ts`
- Create: `figma-plugin/src/build-layout.ts`

The walker takes `(api: FigmaApi, spec, hooks)` and builds every page. It must:
import each `instance` key (cached), apply pre-validated `variant` props, build `frame` auto-layout recursively, render `text` with a font fallback, render `placeholder` as a dashed frame, **archive** an existing same-named page (rename, don't remove), and **yield** every ~20 nodes.

- [ ] **Step 1: Write the walker test with a fake `FigmaApi`**

Create `__tests__/figma-plugin/build-layout.test.ts`:

```ts
// __tests__/figma-plugin/build-layout.test.ts
import { buildLayout } from '../../figma-plugin/src/build-layout'
import type { FigmaApi, FPage, FFrame, FText, FInstance, FComponentSet, FontName } from '../../figma-plugin/src/figma-api'

// ── Fake Figma API ────────────────────────────────────────────────────────────
function makeFake(opts: { existingPages?: string[]; missingFonts?: string[]; failKeys?: string[] } = {}) {
  const events: string[] = []
  const importedKeys: string[] = []
  let pages: FPage[] = (opts.existingPages ?? []).map((name) => fakePage(name))

  function fakePage(name: string): FPage {
    return { type: 'PAGE', name, appendChild: () => {}, remove: () => { events.push(`remove-page:${name}`) } }
  }
  function fakeInstance(): FInstance {
    return { type: 'INSTANCE', name: 'inst', setProperties: (p) => events.push(`setProps:${JSON.stringify(p)}`), remove: () => {} }
  }
  const api: FigmaApi = {
    get pages() { return pages },
    createPage() { const p = fakePage('new'); pages = [...pages, p]; events.push('create-page'); return p },
    createFrame() {
      const f: FFrame = {
        type: 'FRAME', name: '', layoutMode: 'NONE', itemSpacing: 0,
        paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
        primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'AUTO', dashPattern: [],
        appendChild: () => { events.push('frame-append') }, remove: () => {},
      }
      return f
    },
    createText() {
      const t: FText = { type: 'TEXT', name: '', fontName: { family: 'Montserrat', style: 'Regular' }, characters: '', fontSize: 14, remove: () => {} }
      return t
    },
    async importComponentSetByKeyAsync(key: string): Promise<FComponentSet> {
      if (opts.failKeys?.includes(key)) throw new Error('import failed')
      importedKeys.push(key)
      return { defaultVariant: { createInstance: () => fakeInstance() } }
    },
    async loadFontAsync(font: FontName) {
      if (opts.missingFonts?.includes(font.family)) throw new Error(`font ${font.family} not available`)
    },
  }
  return { api, events, importedKeys, get pages() { return pages } }
}

const noHooks = { confirmArchive: async () => true, onYield: async () => {} }

it('imports each instance key (cached) and applies validated variants', async () => {
  const fake = makeFake()
  await buildLayout(fake.api, { pages: [{ name: 'Components', nodes: [
    { type: 'instance', componentKey: 'btnkey', variant: { Type: 'primary' } },
    { type: 'instance', componentKey: 'btnkey' }, // same key → cached, imported once
    { type: 'instance', componentKey: 'inpkey' },
  ] }] }, noHooks)
  expect(fake.importedKeys).toEqual(['btnkey', 'inpkey'])
  expect(fake.events).toContain('setProps:{"Type":"primary"}')
})

it('builds nested frames with auto-layout', async () => {
  const fake = makeFake()
  const res = await buildLayout(fake.api, { pages: [{ name: 'Workflow: W', nodes: [
    { type: 'frame', name: 'Bar', layout: 'HORIZONTAL', spacing: 8, padding: 16, children: [
      { type: 'text', characters: 'Hi', style: 'heading' },
    ] },
  ] }] }, noHooks)
  expect(res.framesBuilt).toBeGreaterThan(0)
  expect(fake.events).toContain('frame-append')
})

it('falls back to Inter when the app font is unavailable', async () => {
  const fake = makeFake({ missingFonts: ['Montserrat'] })
  const res = await buildLayout(fake.api, { pages: [{ name: 'Components', nodes: [
    { type: 'text', characters: 'Label' },
  ] }] }, noHooks)
  expect(res.fontSubstituted).toBe(true) // did not throw; used fallback
})

it('renders a placeholder as a dashed frame', async () => {
  const fake = makeFake()
  const res = await buildLayout(fake.api, { pages: [{ name: 'Components', nodes: [
    { type: 'placeholder', name: 'TalentCard (recreate)', note: 'reuseOf code' },
  ] }] }, noHooks)
  expect(res.placeholders).toBe(1)
})

it('degrades a failed import to a placeholder and continues', async () => {
  const fake = makeFake({ failKeys: ['badkey'] })
  const res = await buildLayout(fake.api, { pages: [{ name: 'Components', nodes: [
    { type: 'instance', componentKey: 'badkey' },
    { type: 'instance', componentKey: 'okkey' },
  ] }] }, noHooks)
  expect(res.placeholders).toBe(1)
  expect(res.instancesPlaced).toBe(1)
})

it('archives (renames) an existing same-named page instead of removing content', async () => {
  const fake = makeFake({ existingPages: ['Components'] })
  const res = await buildLayout(fake.api, { pages: [{ name: 'Components', nodes: [] }] }, noHooks)
  // Existing page renamed to "Components (Archived …)"; never removed.
  const archived = fake.pages.find((p) => p.name.startsWith('Components (Archived'))
  expect(archived).toBeTruthy()
  expect(fake.events).not.toContain('remove-page:Components')
  expect(res.pagesArchived).toBe(1)
})

it('aborts before building when confirmArchive returns false', async () => {
  const fake = makeFake({ existingPages: ['Components'] })
  const res = await buildLayout(fake.api, { pages: [{ name: 'Components', nodes: [] }] }, {
    confirmArchive: async () => false,
    onYield: async () => {},
  })
  expect(res.aborted).toBe(true)
  expect(fake.events).not.toContain('create-page')
})

it('yields to the UI thread on large trees (~every 20 nodes)', async () => {
  const fake = makeFake()
  let yields = 0
  const many = Array.from({ length: 45 }, (_, i) => ({ type: 'text' as const, characters: `t${i}` }))
  await buildLayout(fake.api, { pages: [{ name: 'Components', nodes: many }] }, {
    confirmArchive: async () => true,
    onYield: async () => { yields++ },
  })
  expect(yields).toBeGreaterThanOrEqual(2) // 45 nodes / 20 → at least 2 yields
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest __tests__/figma-plugin/build-layout.test.ts`
Expected: FAIL — `Cannot find module '../../figma-plugin/src/build-layout'`.

- [ ] **Step 3: Implement `figma-plugin/src/build-layout.ts`**

```ts
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
```

- [ ] **Step 4: Run the walker tests to verify they pass**

Run: `npx jest __tests__/figma-plugin/build-layout.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add figma-plugin/src/build-layout.ts __tests__/figma-plugin/build-layout.test.ts
git commit -m "feat(plugin): pure layout-spec walker + tests (archive, yield, font fallback)"
```

---

## Task 4: The Figma-API shell (`code.ts`)

**Files:**
- Create/replace: `figma-plugin/src/code.ts`

Adapts the real `figma` global to `FigmaApi`, drives the walker, wires the UI
messages, confirms archiving, POSTs the writeback, and notifies a summary. This
layer is validated **manually** (the throwaway plugin already proved the core
mechanic); no automated test.

- [ ] **Step 1: Implement `figma-plugin/src/code.ts`**

```ts
// figma-plugin/src/code.ts — main-thread shell. Uses the real `figma` global,
// adapts it to FigmaApi, and delegates the actual building to the pure walker.
import { buildLayout, type BuildHooks, type BuildSummary } from './build-layout'
import type { FigmaApi } from './figma-api'
import type { FigmaLayoutSpec } from '../../lib/figma/layout-spec'

interface PublishPayload { featureId: string; token: string; baseUrl: string }

figma.showUI(__html__, { width: 340, height: 260 })

// The real figma global already matches the FigmaApi shape structurally; adapt
// the couple of members whose names differ (pages, factory methods).
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

  // 3. Write the file key back (best-effort).
  try {
    await fetch(`${parsed.baseUrl}/api/features/${parsed.featureId}/figma-file`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${parsed.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileKey: figma.fileKey }),
    })
  } catch {
    summary.failures.push('writeback: could not POST figma-file')
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
```

> Read `node_modules/@figma/plugin-typings` if any member signature (e.g. `importComponentSetByKeyAsync`, `figma.fileKey`, `figma.ui.on/off`) differs from the above — the `as unknown as` adapters exist precisely because the real types are richer than `FigmaApi`. Adjust the adapter, not the walker.

- [ ] **Step 2: Build to verify it bundles + typechecks under the plugin tsconfig**

Run: `npx tsc --noEmit -p figma-plugin/tsconfig.json && npm run plugin:build`
Expected: no type errors; `figma-plugin/code.js` rebuilt.

- [ ] **Step 3: Commit**

```bash
git add figma-plugin/src/code.ts figma-plugin/code.js
git commit -m "feat(plugin): Figma-API shell — fetch, build, confirm-archive, writeback"
```

---

## Task 5: The plugin UI (`ui.html`)

**Files:**
- Replace: `figma-plugin/ui.html`

- [ ] **Step 1: Implement `figma-plugin/ui.html`**

```html
<!DOCTYPE html>
<html>
<head>
<style>
  body { font: 12px sans-serif; margin: 0; padding: 12px; color: #222; }
  textarea { width: 100%; height: 90px; box-sizing: border-box; font-family: monospace; }
  button { margin-top: 8px; padding: 6px 12px; cursor: pointer; }
  #status { margin-top: 8px; white-space: pre-wrap; color: #555; }
  .err { color: #c00; }
</style>
</head>
<body>
  <p>Paste the <b>Publish Payload</b> from pm-app (Design → Figma → Copy Publish Payload):</p>
  <textarea id="payload" placeholder='{"featureId":"…","token":"…","baseUrl":"…"}'></textarea>
  <button id="publish">Publish</button>
  <div id="status"></div>
  <script>
    const $ = (id) => document.getElementById(id)
    $('publish').onclick = () => {
      $('status').className = ''
      $('status').textContent = 'Publishing…'
      parent.postMessage({ pluginMessage: { type: 'publish', payload: $('payload').value } }, '*')
    }
    onmessage = (e) => {
      const msg = e.data.pluginMessage
      if (!msg) return
      if (msg.type === 'error') { $('status').className = 'err'; $('status').textContent = msg.message }
      else if (msg.type === 'confirm-archive') {
        const ok = confirm(`${msg.names.length} page(s) already exist and will be archived (renamed, not deleted):\n\n${msg.names.join('\n')}\n\nContinue?`)
        parent.postMessage({ pluginMessage: { type: 'confirm-archive-result', ok } }, '*')
      }
      else if (msg.type === 'done') { $('status').textContent = 'Done. See the notification for the summary.' }
    }
  </script>
</body>
</html>
```

- [ ] **Step 2: Rebuild + commit**

```bash
npm run plugin:build
git add figma-plugin/ui.html figma-plugin/code.js
git commit -m "feat(plugin): publish UI (payload textarea + archive confirm)"
```

---

## Task 6: Full verification + manual end-to-end + PR

- [ ] **Step 1: Full pm-app suite still green** (the walker test runs inside it)

Run: `npx jest`
Expected: PASS (Plan 1 tests + the 8 walker tests), 0 failures.

- [ ] **Step 2: Typechecks + builds (both projects)**

Run: `npx tsc --noEmit && npx next build && npx tsc --noEmit -p figma-plugin/tsconfig.json && npm run plugin:build`
Expected: all clean.

- [ ] **Step 3: Manual end-to-end (documented, not automated)**

Requires: Plan 1 endpoints reachable (local dev server or prod), a feature with a `ux_stitch`, the real catalog committed, `FIGMA_PLUGIN_TOKEN` set, Michael's Full Figma seat.

1. `npm run plugin:build`; import `figma-plugin/manifest.json` into Figma (Development plugins).
2. In pm-app Feature Editor → **Design → Figma → Copy Publish Payload**.
3. Create/open the feature's Figma file inside the correct Application project.
4. Run the plugin, paste the payload, **Publish**.
5. Verify: a "Components" page + one "Workflow: …" page per workflow appear, built from **real antd library instances** (`Select a node → right panel shows the library component`); placeholders show as dashed frames; the `figma.notify` summary matches.
6. Re-run to confirm **non-destructive archiving**: the confirm dialog lists the existing pages; after confirming, the old pages are renamed `… (Archived …)` and new ones built; nothing is deleted.
7. In pm-app, confirm `features.figma_file_key` is now set (the writeback landed).

- [ ] **Step 4: Open the PR**

```bash
git push
gh pr create --title "feat: publish stitch → Figma, Plan 2 (the plugin)" --body "$(cat <<'EOF'
Plan 2 of Spec #2 — the local dev Figma plugin. A pure layout-spec walker
(unit-tested outside Figma with a fake API) + a thin Figma-API shell. Fetches
the resolved layout spec from Plan 1's GET /figma-layout, builds real antd
library instances + auto-layout, non-destructively archives existing pages,
yields to the UI thread, falls back to Inter when Montserrat is absent, and
POSTs figma_file_key back.

Imported as a Development plugin (not org-published in v1). Manual e2e steps in
figma-plugin/README.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review notes (spec coverage — Component E + Testing)

- `figma-plugin/` dev plugin (own manifest/tsconfig/esbuild) → Task 1. ✓
- Pure layout-spec walker tested outside Figma with a fake API → Tasks 2, 3. ✓
- Thin Figma-API shell, validated manually → Task 4. ✓
- Paste-payload auth (`{featureId,token,baseUrl}`, no clientStorage) → Tasks 4, 5. ✓
- `importComponentSetByKeyAsync` → instantiate → auto-layout; variant via setProperties → Task 3. ✓
- Non-destructive re-publish (archive/rename, never remove) + confirm → Task 3 (walker) + Task 4/5 (confirm wiring). ✓
- Yield every ~20 nodes → Task 3. ✓
- `loadFontAsync` try/catch → Inter fallback → Task 3. ✓
- Failed import degrades to placeholder, one bad component never aborts → Task 3. ✓
- Writeback POST /figma-file with figma.fileKey → Task 4. ✓
- Summary via figma.notify → Task 4. ✓
- manifest `networkAccess.allowedDomains` = pm-app origin → Task 1. ✓

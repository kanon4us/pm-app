# Publish Stitch → Figma — Plan 1 (pm-app side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give pm-app everything needed to turn an approved feature's `ux_stitch` into a fully-resolved, variant-validated **Figma layout spec** (component keys + auto-layout tree), served over a token-authed endpoint, plus the PM-facing reuse-refs UI and the "Copy Publish Payload" affordance — all testable with fixtures, no Figma runtime required.

**Architecture:** A committed antd **catalog** (name→key + real variant options, generated from the Figma REST API) and the PM's **reuse refs** feed a **Gemini 2.5 Pro resolver** (`lib/features/figma-layout.ts`) that emits a `FigmaLayoutSpec`. A code-side normalizer validates every component key and variant against the catalog (unknown key → `placeholder`, unknown variant prop/option → stripped). Two token-gated routes (`GET figma-layout`, `POST figma-file`) plus one session-gated `GET publish-payload` route bridge to the plugin (Plan 2). This mirrors Spec #1's `ux-architect.ts` isolation and **write-only-on-success / never-throw** discipline.

**Tech Stack:** Next.js (App Router, this repo's fork — read `node_modules/next/dist/docs/` before route work), TypeScript, `@google/genai` v2.10.0 (Gemini 2.5 Pro, `Type`/`Schema` JSON mode), Supabase (service client), antd 5 (Feature Editor UI), jest + ts-jest (node + jsdom projects).

**Reference spec:** `docs/superpowers/specs/2026-07-08-publish-stitch-to-figma-design.md`

---

## File Structure

**Create:**
- `supabase/migrations/037_feature_figma_publish.sql` — `reuse_refs` + `figma_file_key` columns.
- `lib/figma/layout-spec.ts` — the **shared wire-contract types** (`FigmaLayoutSpec`, `LayoutPage`, `LayoutNode`). Zero runtime deps so Plan 2's plugin can `import type` it across the process boundary.
- `lib/figma/component-catalog.ts` — `getComponentCatalog()` loader + types.
- `design/figma-antd-catalog.json` — generated, committed catalog (real keys + variant options).
- `scripts/build-figma-catalog.ts` — one-shot generator (Figma REST → the JSON above).
- `lib/features/reuse-refs.ts` — `resolveReuseRefs(feature)` + reuse-ref types.
- `lib/features/figma-layout.ts` — `resolveFigmaLayout(featureId)` (Gemini) + `normalizeLayoutSpec` validator.
- `app/api/features/[id]/figma-layout/route.ts` — `GET`, token-authed.
- `app/api/features/[id]/figma-file/route.ts` — `POST`, token-authed.
- `app/api/features/[id]/publish-payload/route.ts` — `GET`, session-authed.
- `app/features/[id]/components/ReuseRefsPanel.tsx` — reuse-ref editor + Copy Publish Payload.
- Tests under `__tests__/lib/figma/`, `__tests__/lib/features/`, `__tests__/api/features/`.

**Modify:**
- `lib/supabase/types.ts` — add both columns to `features` Row/Insert/Update.
- `lib/claude/tools/figma.ts` — extract `getFigmaNodeStyleSummary(userId, url)` (reused by `executeGetFigmaStyles` and `resolveReuseRefs`).
- `app/api/features/[id]/route.ts` — accept `reuse_refs` in `PATCH`.
- `proxy.ts` — add a regex-based public matcher for the two token-gated `figma-*` routes.
- `next.config.ts` — bundle the catalog JSON into the `figma-layout` route trace.
- `app/features/[id]/page.tsx` — mount the ReuseRefsPanel drawer; add `reuse_refs` to the `Feature` interface.

---

## Task 1: Migration 037 + Supabase types

**Files:**
- Create: `supabase/migrations/037_feature_figma_publish.sql`
- Modify: `lib/supabase/types.ts:238-247`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/037_feature_figma_publish.sql`:

```sql
-- 037_feature_figma_publish.sql
-- Spec #2: PM-curated reuse references + the published Figma file linkage.
-- Additive; manual prod apply per convention (BEFORE deploying code that reads them).
alter table features add column if not exists reuse_refs     jsonb;   -- { refs: [{ kind, value, note }] }
alter table features add column if not exists figma_file_key text;    -- set by the plugin after publish (Spec #3 read-back)
```

- [ ] **Step 2: Add both columns to `features` in `lib/supabase/types.ts`**

In the `features` block (around line 238-247), add `reuse_refs: Json | null` and `figma_file_key: string | null` to `Row`, and the optional forms to `Insert` and `Update`. Row edit:

```ts
        Row: {
          id: string; name: string; description: string | null; status: 'draft' | 'active' | 'archived'
          fvi_score: number | null; objectives: string | null; objectives_json: Json | null; ux_stitch: Json | null; clickup_details: string | null
          planning_phase: 'planning' | 'approved' | 'prototyping'; spec_content: string | null
          app: 'web' | 'cms' | 'mobile' | 'desktop'
          code_paths: string[]; prototype_branch: string | null; prototype_pr_url: string | null
          reuse_refs: Json | null; figma_file_key: string | null
          created_at: string; updated_at: string
        }
```

Append `; reuse_refs?: Json | null; figma_file_key?: string | null` before the closing `}` of both the `Insert` and `Update` object literals.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/037_feature_figma_publish.sql lib/supabase/types.ts
git commit -m "feat(features): migration 037 + types for reuse_refs & figma_file_key"
```

---

## Task 2: Shared layout-spec contract types

**Files:**
- Create: `lib/figma/layout-spec.ts`

These types are the JSON contract between the resolver (Task 5) and the plugin walker (Plan 2). Keep this file **pure types, zero imports** so Plan 2 can `import type` it without dragging server deps into the plugin bundle.

- [ ] **Step 1: Write the contract**

Create `lib/figma/layout-spec.ts`:

```ts
// lib/figma/layout-spec.ts
// The wire contract between pm-app's layout resolver and the Figma plugin.
// Pure types only — no runtime deps — so the plugin build can `import type` it.

/** A real antd library instance, keyed by its team-library component-set key. */
export interface InstanceNode {
  type: 'instance'
  componentKey: string
  name?: string
  /** Variant props, e.g. { Type: 'primary' }. Validated against the catalog upstream. */
  variant?: Record<string, string>
}

/** An auto-layout container. */
export interface FrameNode {
  type: 'frame'
  name?: string
  layout: 'HORIZONTAL' | 'VERTICAL'
  spacing?: number
  padding?: number
  children: LayoutNode[]
}

/** Literal text (labels, headings, mock copy). */
export interface TextNode {
  type: 'text'
  characters: string
  style?: 'heading' | 'body' | 'caption'
}

/** A gap: a reuse target with no published library key. Rendered as a labeled placeholder. */
export interface PlaceholderNode {
  type: 'placeholder'
  name: string
  note?: string
}

export type LayoutNode = InstanceNode | FrameNode | TextNode | PlaceholderNode

export interface LayoutPage {
  /** "Components" for the component-library page, or "Workflow: <name>" per stitch workflow. */
  name: string
  nodes: LayoutNode[]
}

export interface FigmaLayoutSpec {
  pages: LayoutPage[]
}

export const LAYOUT_NODE_TYPES = ['instance', 'frame', 'text', 'placeholder'] as const
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add lib/figma/layout-spec.ts
git commit -m "feat(figma): shared layout-spec wire-contract types"
```

---

## Task 3: antd component catalog (loader + generator)

**Files:**
- Create: `lib/figma/component-catalog.ts`
- Create: `design/figma-antd-catalog.json` (starts as a small committed fixture; regenerated by the script)
- Create: `scripts/build-figma-catalog.ts`
- Create: `__tests__/lib/figma/component-catalog.test.ts`
- Modify: `package.json` (add `figma:catalog` script)

The **loader** is what code depends on and is unit-tested against a committed fixture. The **generator** produces the real file as an ops step (needs a Figma token) — it is not part of the jest suite.

- [ ] **Step 1: Write the loader test (against a fixture-shaped file)**

Create `__tests__/lib/figma/component-catalog.test.ts`:

```ts
// __tests__/lib/figma/component-catalog.test.ts
import fs from 'node:fs'
import path from 'node:path'

const CATALOG_PATH = path.join(process.cwd(), 'design', 'figma-antd-catalog.json')

describe('getComponentCatalog', () => {
  beforeEach(() => jest.resetModules())

  it('loads the committed catalog and indexes by name', () => {
    const { getComponentCatalog, findComponentByName } = require('@/lib/figma/component-catalog')
    const cat = getComponentCatalog()
    expect(cat.libraryFileKey).toBeTruthy()
    expect(Array.isArray(cat.components)).toBe(true)
    // Button set is present in the real library and any reasonable fixture.
    const button = findComponentByName(cat, 'Button')
    expect(button?.key).toBeTruthy()
  })

  it('exposes variant options for a set when present', () => {
    const { getComponentCatalog, findComponentByName } = require('@/lib/figma/component-catalog')
    const cat = getComponentCatalog()
    const button = findComponentByName(cat, 'Button')
    if (button?.variants) {
      for (const [prop, opts] of Object.entries(button.variants)) {
        expect(typeof prop).toBe('string')
        expect(Array.isArray(opts)).toBe(true)
      }
    }
  })

  it('excludes icon-set noise (icons flagged/absent from the resolver catalog)', () => {
    const { getComponentCatalog } = require('@/lib/figma/component-catalog')
    const cat = getComponentCatalog()
    // The generator drops the ~hundreds of icon components; sanity-cap the size.
    expect(cat.components.length).toBeLessThan(400)
  })

  it('the on-disk catalog file parses as JSON', () => {
    expect(() => JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'))).not.toThrow()
  })
})
```

- [ ] **Step 2: Create the committed fixture catalog**

Create `design/figma-antd-catalog.json` with a minimal but real-shaped seed (the generator overwrites it with the full set later; these are verified real keys from the spec/memory):

```json
{
  "generatedAt": "2026-07-08T00:00:00.000Z",
  "libraryFileKey": "DpIOFPBpzpVVmZyZvzPJS4",
  "components": [
    { "name": "Button", "key": "7747670f6c7a9743711e9226f9d66edbf9c20999", "type": "set", "variants": { "Type": ["default", "primary", "dashed", "text", "link"] } },
    { "name": "Input", "key": "c36bfe7e88fbe39f5262cebfb38a275a94e9e1fe", "type": "set" },
    { "name": "Card", "key": "637b1836b85464ed4eee80b426e4f9810730ed58", "type": "set" }
  ]
}
```

- [ ] **Step 3: Run the loader test to verify it fails**

Run: `npx jest __tests__/lib/figma/component-catalog.test.ts`
Expected: FAIL — `Cannot find module '@/lib/figma/component-catalog'`.

- [ ] **Step 4: Write the loader**

Create `lib/figma/component-catalog.ts`:

```ts
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
```

- [ ] **Step 5: Run the loader test to verify it passes**

Run: `npx jest __tests__/lib/figma/component-catalog.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Write the generator script**

Create `scripts/build-figma-catalog.ts`. It pages the team's component sets, then reads each set's `componentPropertyDefinitions` (VARIANT props → `variantOptions`) from the library file's nodes endpoint, in batches. Uses the existing `figmaGetJson` (X-Figma-Token PAT) helper.

```ts
// scripts/build-figma-catalog.ts
// Regenerates design/figma-antd-catalog.json from the published antd team library.
// Run: npm run figma:catalog   (needs FIGMA_MIGRATION_TOKEN or FIGMA_ACCESS_TOKEN + FIGMA_TEAM_ID)
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { figmaGetJson } from '@/lib/figma/client'
import type { CatalogComponent, ComponentCatalog } from '@/lib/figma/component-catalog'

const FIGMA_API = 'https://api.figma.com'
const TOKEN = process.env.FIGMA_MIGRATION_TOKEN ?? process.env.FIGMA_ACCESS_TOKEN
const TEAM_ID = process.env.FIGMA_TEAM_ID ?? '1155279883633947706'
// The antd team library file (verified). All published sets live here.
const LIBRARY_FILE_KEY = process.env.FIGMA_ANTD_LIBRARY_KEY ?? 'DpIOFPBpzpVVmZyZvzPJS4'
// Icon components pollute the catalog and never help the resolver — drop them.
const ICON_NAME_RE = /icon/i

interface ComponentSetMeta { key: string; name: string; node_id: string }

async function main() {
  if (!TOKEN) {
    console.error('✗ Set FIGMA_MIGRATION_TOKEN or FIGMA_ACCESS_TOKEN.')
    process.exit(1)
  }
  // 1. All component SETS in the team (these are the variant families).
  const setsRes = (await figmaGetJson(
    TOKEN,
    `${FIGMA_API}/v1/teams/${TEAM_ID}/component_sets`
  )) as { meta?: { component_sets?: ComponentSetMeta[] } }
  const sets = (setsRes.meta?.component_sets ?? []).filter((s) => !ICON_NAME_RE.test(s.name))

  // 2. Read real variant property defs from the library file, batched by node id.
  const idsByNode = new Map(sets.map((s) => [s.node_id, s]))
  const nodeIds = [...idsByNode.keys()]
  const variantsByNodeId = new Map<string, Record<string, string[]>>()
  const BATCH = 50
  for (let i = 0; i < nodeIds.length; i += BATCH) {
    const batch = nodeIds.slice(i, i + BATCH)
    const nodesRes = (await figmaGetJson(
      TOKEN,
      `${FIGMA_API}/v1/files/${LIBRARY_FILE_KEY}/nodes?ids=${encodeURIComponent(batch.join(','))}`
    )) as { nodes?: Record<string, { document?: { componentPropertyDefinitions?: Record<string, { type?: string; variantOptions?: string[] }> } }> }
    for (const [nodeId, entry] of Object.entries(nodesRes.nodes ?? {})) {
      const defs = entry.document?.componentPropertyDefinitions ?? {}
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
```

- [ ] **Step 7: Register the npm script**

In `package.json` `scripts`, add alongside the other `figma:*` entries:

```json
    "figma:catalog": "ts-node scripts/build-figma-catalog.ts",
```

- [ ] **Step 8: Typecheck (script + loader)**

Run: `npx tsc --noEmit`
Expected: PASS.

> **Ops note (not a test step):** Once creds are available, run `npm run figma:catalog` to overwrite `design/figma-antd-catalog.json` with the full ~100-set real catalog, and commit it. The committed fixture from Step 2 keeps builds/tests green until then. Do this before the resolver is used against real features.

- [ ] **Step 9: Commit**

```bash
git add lib/figma/component-catalog.ts design/figma-antd-catalog.json scripts/build-figma-catalog.ts __tests__/lib/figma/component-catalog.test.ts package.json
git commit -m "feat(figma): antd catalog loader + generator + committed seed"
```

---

## Task 4: Reuse references — figma read refactor + `resolveReuseRefs`

**Files:**
- Modify: `lib/claude/tools/figma.ts` (extract `getFigmaNodeStyleSummary`)
- Create: `lib/features/reuse-refs.ts`
- Create: `__tests__/lib/features/reuse-refs.test.ts`

- [ ] **Step 1: Extract a reusable style-summary function in `lib/claude/tools/figma.ts`**

Add an exported function that does parse → auth → fetch → summarize, and refactor `executeGetFigmaStyles` to call it. Insert near the other exports (after `executeGetFigmaStyles`), and replace the body of `executeGetFigmaStyles`'s fetch/summarize section with a call to it:

```ts
/**
 * Parses a Figma URL, resolves auth, fetches the node, and returns the compact
 * style-token summary — the same output get_figma_styles surfaces to chat.
 * Reused by resolveReuseRefs. Throws with a PM-readable message on failure.
 */
export async function getFigmaNodeStyleSummary(
  userId: string | undefined,
  url: string
): Promise<string> {
  const parsed = parseFigmaUrl(url ?? '')
  if (!parsed) throw new Error(`Not a Figma URL: ${url}`)
  if (!parsed.nodeId) throw new Error('The URL has no node-id — needs a specific frame link.')
  const auth = await resolveFigmaAuth(userId)
  if (!auth) throw new Error('Figma access is not configured — set FIGMA_ACCESS_TOKEN in the pm-app environment')
  const res = await fetch(
    `${FIGMA_API}/v1/files/${parsed.fileKey}/nodes?ids=${encodeURIComponent(parsed.nodeId)}`,
    { headers: auth.headers }
  )
  if (!res.ok) {
    const apiErr = await res.json().then((d: { err?: string }) => d.err).catch(() => null)
    throw new Error(`Figma API error ${res.status}${apiErr ? `: ${apiErr}` : ''}.`)
  }
  const data = (await res.json()) as { nodes?: Record<string, { document?: FigmaStyleNode }> }
  const root = data.nodes?.[parsed.nodeId]?.document
  if (!root) throw new Error(`Figma returned no node for ${parsed.nodeId}`)
  return summarizeStyles(root)
}
```

Then simplify `executeGetFigmaStyles` to reuse it (keeping its `applied.framesViewed++` and error wrapping):

```ts
export async function executeGetFigmaStyles(
  userId: string | undefined,
  input: { url: string },
  applied: AppliedChanges
): Promise<{ result: ToolResultContent; isError: boolean }> {
  try {
    const summary = await getFigmaNodeStyleSummary(userId, input.url ?? '')
    applied.framesViewed++
    return { result: summary, isError: false }
  } catch (err) {
    return { result: err instanceof Error ? err.message : 'get_figma_styles failed', isError: true }
  }
}
```

- [ ] **Step 2: Verify the existing figma tests still pass**

Run: `npx jest __tests__/lib/features/conversation.test.ts` (and any figma tool test)
Expected: PASS — the refactor is behavior-preserving.

- [ ] **Step 3: Write the reuse-refs resolution test**

Create `__tests__/lib/features/reuse-refs.test.ts`:

```ts
// __tests__/lib/features/reuse-refs.test.ts
const mockStyleSummary = jest.fn()
jest.mock('@/lib/claude/tools/figma', () => ({
  getFigmaNodeStyleSummary: (...a: unknown[]) => mockStyleSummary(...a),
}))
const mockReadRepoFile = jest.fn()
jest.mock('@/lib/github/design-index-pr', () => ({
  readRepoFile: (...a: unknown[]) => mockReadRepoFile(...a),
}))

import { resolveReuseRefs } from '@/lib/features/reuse-refs'

const feature = { id: 'f1', app: 'web', reuse_refs: null } as never

beforeEach(() => {
  jest.clearAllMocks()
  process.env.GITHUB_TOKEN = 'gh-test'
})

it('returns [] when there are no refs', async () => {
  expect(await resolveReuseRefs({ ...(feature as object), reuse_refs: null } as never)).toEqual([])
  expect(await resolveReuseRefs({ ...(feature as object), reuse_refs: { refs: [] } } as never)).toEqual([])
})

it('resolves a figma ref via the style summary path', async () => {
  mockStyleSummary.mockResolvedValue('Fonts: Montserrat; Fill colors: #00aaff')
  const out = await resolveReuseRefs({
    ...(feature as object),
    reuse_refs: { refs: [{ kind: 'figma', value: 'https://figma.com/design/x?node-id=1-2', note: 'the card' }] },
  } as never)
  expect(mockStyleSummary).toHaveBeenCalled()
  expect(out[0].kind).toBe('figma')
  expect(out[0].resolved).toContain('#00aaff')
  expect(out[0].note).toBe('the card')
})

it('resolves a code ref via readRepoFile against the app repo', async () => {
  mockReadRepoFile.mockResolvedValue('export function TalentCard() { return null }')
  const out = await resolveReuseRefs({
    ...(feature as object),
    reuse_refs: { refs: [{ kind: 'code', value: 'components/Admin/Talent/TalentCard.tsx', note: 'reuse this' }] },
  } as never)
  expect(mockReadRepoFile).toHaveBeenCalledWith('gh-test', 'Viscap-Media/app.viscap.ai', 'components/Admin/Talent/TalentCard.tsx', 'develop')
  expect(out[0].resolved).toContain('TalentCard')
})

it('passes screenshot refs through as a reference line', async () => {
  const out = await resolveReuseRefs({
    ...(feature as object),
    reuse_refs: { refs: [{ kind: 'screenshot', value: 'https://store/img.png', note: 'like this' }] },
  } as never)
  expect(out[0].kind).toBe('screenshot')
  expect(out[0].resolved).toContain('https://store/img.png')
})

it('skips (does not throw) a ref whose resolution errors', async () => {
  mockStyleSummary.mockRejectedValue(new Error('bad url'))
  const out = await resolveReuseRefs({
    ...(feature as object),
    reuse_refs: { refs: [
      { kind: 'figma', value: 'nope', note: 'x' },
      { kind: 'screenshot', value: 'https://store/ok.png', note: 'y' },
    ] },
  } as never)
  // The failed figma ref is dropped; the screenshot one survives.
  expect(out).toHaveLength(1)
  expect(out[0].kind).toBe('screenshot')
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx jest __tests__/lib/features/reuse-refs.test.ts`
Expected: FAIL — `Cannot find module '@/lib/features/reuse-refs'`.

- [ ] **Step 5: Implement `lib/features/reuse-refs.ts`**

```ts
// lib/features/reuse-refs.ts
// Turns the PM's durable reuse_refs list into compact, LLM-ready context.
// Each ref is resolved via a pipeline pm-app already has (figma read / repo read /
// stored screenshot). A ref that fails to resolve is SKIPPED, never thrown — one
// bad ref must not sink the whole resolve.
import type { Feature } from '@/lib/features/client'
import { getFigmaNodeStyleSummary } from '@/lib/claude/tools/figma'
import { readRepoFile } from '@/lib/github/design-index-pr'
import { getAppTarget } from '@/lib/claude/apps'

export type ReuseRefKind = 'figma' | 'code' | 'screenshot'
export interface ReuseRef { kind: ReuseRefKind; value: string; note: string }
export interface ReuseRefs { refs: ReuseRef[] }
export interface ResolvedReuseRef extends ReuseRef { resolved: string }

const MAX_CODE_CHARS = 4000

function parseReuseRefs(raw: unknown): ReuseRef[] {
  if (!raw || typeof raw !== 'object') return []
  const refs = (raw as { refs?: unknown }).refs
  if (!Array.isArray(refs)) return []
  return refs.filter(
    (r): r is ReuseRef =>
      !!r && typeof r === 'object' &&
      ['figma', 'code', 'screenshot'].includes((r as ReuseRef).kind) &&
      typeof (r as ReuseRef).value === 'string'
  )
}

export async function resolveReuseRefs(feature: Feature): Promise<ResolvedReuseRef[]> {
  const refs = parseReuseRefs(feature.reuse_refs)
  if (refs.length === 0) return []
  const target = getAppTarget(feature.app)
  const out: ResolvedReuseRef[] = []
  for (const ref of refs) {
    try {
      let resolved: string
      if (ref.kind === 'figma') {
        // No chat user in this server context — falls back to FIGMA_ACCESS_TOKEN PAT.
        const styles = await getFigmaNodeStyleSummary(undefined, ref.value)
        resolved = `[Figma reuse] ${ref.note}\n${styles}`
      } else if (ref.kind === 'code') {
        const token = process.env.GITHUB_TOKEN
        if (!token) throw new Error('no GITHUB_TOKEN')
        const src = await readRepoFile(token, target.repo, ref.value, target.baseBranch)
        if (src == null) throw new Error(`not found: ${ref.value}`)
        resolved = `[Code reuse] ${ref.value} — ${ref.note}\n${src.slice(0, MAX_CODE_CHARS)}`
      } else {
        resolved = `[Screenshot reuse] ${ref.note}: ${ref.value}`
      }
      out.push({ ...ref, resolved })
    } catch (err) {
      console.warn('[reuse-refs] skipped', ref.kind, ref.value, err instanceof Error ? err.message : err)
    }
  }
  return out
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx jest __tests__/lib/features/reuse-refs.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add lib/claude/tools/figma.ts lib/features/reuse-refs.ts __tests__/lib/features/reuse-refs.test.ts
git commit -m "feat(features): resolveReuseRefs + extract getFigmaNodeStyleSummary"
```

---

## Task 5: The layout resolver (Gemini + validator)

**Files:**
- Create: `lib/features/figma-layout.ts`
- Create: `__tests__/lib/features/figma-layout.test.ts`

The resolver calls Gemini for the *judgment* (which component, how composed), then a deterministic **`normalizeLayoutSpec`** coerces the output into the closed node union and validates every key + variant against the catalog. Recursion in Gemini `responseSchema` is unreliable, so the schema is intentionally shallow (`pages[].nodes[]` as loose objects) and the code validator does the real structural enforcement.

- [ ] **Step 1: Write the resolver + validator test**

Create `__tests__/lib/features/figma-layout.test.ts`:

```ts
// __tests__/lib/features/figma-layout.test.ts
process.env.GEMINI_API_KEY = 'test-key'

const mockGenerateContent = jest.fn()
jest.mock('@google/genai', () => ({
  __esModule: true,
  GoogleGenAI: jest.fn().mockImplementation(() => ({ models: { generateContent: mockGenerateContent } })),
  Type: new Proxy({}, { get: (_t, p) => String(p) }),
}))

const mockGetFeature = jest.fn()
jest.mock('@/lib/features/client', () => ({ getFeature: (...a: unknown[]) => mockGetFeature(...a) }))
jest.mock('@/lib/features/reuse-refs', () => ({ resolveReuseRefs: jest.fn().mockResolvedValue([]) }))
jest.mock('@/lib/figma/component-catalog', () => ({
  getComponentCatalog: () => ({
    generatedAt: 'x', libraryFileKey: 'lib',
    components: [
      { name: 'Button', key: 'btnkey', type: 'set', variants: { Type: ['default', 'primary'] } },
      { name: 'Input', key: 'inpkey', type: 'set' },
    ],
  }),
  findComponentByName: jest.requireActual('@/lib/figma/component-catalog').findComponentByName,
  catalogByKey: jest.requireActual('@/lib/figma/component-catalog').catalogByKey,
}))

import { resolveFigmaLayout } from '@/lib/features/figma-layout'

const feature = { id: 'f1', app: 'web', ux_stitch: { summary: 's', workflows: [{ name: 'W' }] } }

beforeEach(() => {
  jest.clearAllMocks()
  process.env.GEMINI_API_KEY = 'test-key'
  mockGetFeature.mockResolvedValue(feature)
})

function geminiReturns(spec: unknown) {
  mockGenerateContent.mockResolvedValue({ text: JSON.stringify(spec) })
}

it('returns null when the feature has no ux_stitch', async () => {
  mockGetFeature.mockResolvedValue({ ...feature, ux_stitch: null })
  expect(await resolveFigmaLayout('f1')).toBeNull()
  expect(mockGenerateContent).not.toHaveBeenCalled()
})

it('includes stitch + catalog in the prompt', async () => {
  geminiReturns({ pages: [] })
  await resolveFigmaLayout('f1')
  const call = mockGenerateContent.mock.calls[0][0]
  expect(JSON.stringify(call.contents)).toContain('btnkey')     // catalog key present
  expect(JSON.stringify(call.contents)).toContain('workflows')  // stitch present
})

it('keeps a valid instance + valid variant', async () => {
  geminiReturns({ pages: [{ name: 'Components', nodes: [
    { type: 'instance', componentKey: 'btnkey', name: 'CTA', variant: { Type: 'primary' } },
  ] }] })
  const spec = await resolveFigmaLayout('f1')
  const node = spec!.pages[0].nodes[0]
  expect(node).toEqual({ type: 'instance', componentKey: 'btnkey', name: 'CTA', variant: { Type: 'primary' } })
})

it('downgrades an unknown componentKey to a placeholder', async () => {
  geminiReturns({ pages: [{ name: 'Components', nodes: [
    { type: 'instance', componentKey: 'ghostkey', name: 'Mystery' },
  ] }] })
  const spec = await resolveFigmaLayout('f1')
  expect(spec!.pages[0].nodes[0].type).toBe('placeholder')
})

it('strips an unknown variant prop/option (keeps the instance, drops the bad variant)', async () => {
  geminiReturns({ pages: [{ name: 'Components', nodes: [
    { type: 'instance', componentKey: 'btnkey', variant: { Type: 'Primary', Bogus: 'x' } }, // wrong-case option + unknown prop
  ] }] })
  const spec = await resolveFigmaLayout('f1')
  const node = spec!.pages[0].nodes[0] as { type: string; variant?: Record<string, string> }
  expect(node.type).toBe('instance')
  expect(node.variant).toBeUndefined() // both invalid → stripped entirely
})

it('recurses frame children and validates nested instances', async () => {
  geminiReturns({ pages: [{ name: 'Workflow: W', nodes: [
    { type: 'frame', name: 'Bar', layout: 'HORIZONTAL', spacing: 8, padding: 16, children: [
      { type: 'instance', componentKey: 'inpkey' },
      { type: 'instance', componentKey: 'nope' },
      { type: 'text', characters: 'Search', style: 'body' },
    ] },
  ] }] })
  const spec = await resolveFigmaLayout('f1')
  const frame = spec!.pages[0].nodes[0] as { type: string; children: { type: string }[] }
  expect(frame.type).toBe('frame')
  expect(frame.children.map((c) => c.type)).toEqual(['instance', 'placeholder', 'text'])
})

it('returns null (no partial) when Gemini returns unparseable JSON', async () => {
  mockGenerateContent.mockResolvedValue({ text: '{ not json' })
  expect(await resolveFigmaLayout('f1')).toBeNull()
})

it('returns null when Gemini throws', async () => {
  mockGenerateContent.mockRejectedValue(new Error('timeout'))
  expect(await resolveFigmaLayout('f1')).toBeNull()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/lib/features/figma-layout.test.ts`
Expected: FAIL — `Cannot find module '@/lib/features/figma-layout'`.

- [ ] **Step 3: Implement `lib/features/figma-layout.ts`**

```ts
// lib/features/figma-layout.ts
// The layout resolver: ux_stitch + reuse_refs + antd catalog → a fully-keyed
// FigmaLayoutSpec. Gemini does the "which component" judgment; a deterministic
// validator then enforces the closed node union and checks every key + variant
// against the catalog (unknown key → placeholder; unknown variant → stripped).
// Discipline mirrors ux-architect.ts: the ONLY Gemini caller here, never throws,
// returns null rather than a partial spec.
import { GoogleGenAI, Type, type Schema } from '@google/genai'
import { getFeature } from '@/lib/features/client'
import { resolveReuseRefs } from '@/lib/features/reuse-refs'
import { getComponentCatalog, catalogByKey } from '@/lib/figma/component-catalog'
import type { CatalogComponent } from '@/lib/figma/component-catalog'
import type { FigmaLayoutSpec, LayoutNode, LayoutPage } from '@/lib/figma/layout-spec'

const GEMINI_MODEL = 'gemini-2.5-pro'
const MAX_OUTPUT_TOKENS = 32768

const RESOLVER_SYSTEM = `You convert a mid-fidelity UX stitch into a concrete Figma layout spec built from a fixed Ant Design component library.

Rules:
- For each screen region, choose the CLOSEST real component from the catalog and reference it by its exact "key". Use ONLY keys present in the catalog.
- Compose components with auto-layout FRAMES to match each screen's structure.
- When the stitch marks a component as reuseOf, prefer that reused component.
- Emit a "placeholder" node ONLY when nothing in the catalog fits and no key is available.
- Set "variant" ONLY using the exact property names and option strings the catalog lists for that key. If unsure, omit variant.
- Apply a baseline spacing scale to EVERY frame so the output breathes: padding 16-24, gaps 8/16/24. Match the design contract's tokens. Never emit tight, hand-detangle spacing.
- Produce one page named "Components" listing the components you used, plus one page named "Workflow: <name>" per stitch workflow.
- Node shapes: instance {type:'instance',componentKey,name?,variant?} | frame {type:'frame',name?,layout:'HORIZONTAL'|'VERTICAL',spacing?,padding?,children:[]} | text {type:'text',characters,style?} | placeholder {type:'placeholder',name,note?}.
- NEVER emit code.`

// Shallow schema on purpose: Gemini responseSchema can't express the recursive
// node union, so nodes come back loosely typed and normalizeLayoutSpec enforces
// the real structure + key/variant validity in code.
const LAYOUT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    pages: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          nodes: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {}, required: [] } },
        },
        required: ['name', 'nodes'],
      },
    },
  },
  required: ['pages'],
}

const LAYOUTS = ['HORIZONTAL', 'VERTICAL'] as const
const TEXT_STYLES = ['heading', 'body', 'caption'] as const

/** Validates one raw node into the closed union, or null to drop it. */
function normalizeNode(raw: unknown, byKey: Map<string, CatalogComponent>): LayoutNode | null {
  if (!raw || typeof raw !== 'object') return null
  const n = raw as Record<string, unknown>
  switch (n.type) {
    case 'instance': {
      const componentKey = typeof n.componentKey === 'string' ? n.componentKey : ''
      const comp = byKey.get(componentKey)
      if (!comp) {
        // Unknown key → visible gap instead of a silent failure.
        return { type: 'placeholder', name: typeof n.name === 'string' ? n.name : 'Unknown component', note: `unmapped key ${componentKey}` }
      }
      const node: LayoutNode = { type: 'instance', componentKey }
      if (typeof n.name === 'string') node.name = n.name
      const variant = validateVariant(n.variant, comp)
      if (variant) node.variant = variant
      return node
    }
    case 'frame': {
      const layout = LAYOUTS.includes(n.layout as (typeof LAYOUTS)[number]) ? (n.layout as 'HORIZONTAL' | 'VERTICAL') : 'VERTICAL'
      const children = Array.isArray(n.children)
        ? n.children.map((c) => normalizeNode(c, byKey)).filter((c): c is LayoutNode => c !== null)
        : []
      const node: LayoutNode = { type: 'frame', layout, children }
      if (typeof n.name === 'string') node.name = n.name
      if (typeof n.spacing === 'number') node.spacing = n.spacing
      if (typeof n.padding === 'number') node.padding = n.padding
      return node
    }
    case 'text': {
      if (typeof n.characters !== 'string') return null
      const node: LayoutNode = { type: 'text', characters: n.characters }
      if (TEXT_STYLES.includes(n.style as (typeof TEXT_STYLES)[number])) node.style = n.style as (typeof TEXT_STYLES)[number]
      return node
    }
    case 'placeholder': {
      const node: LayoutNode = { type: 'placeholder', name: typeof n.name === 'string' ? n.name : 'Placeholder' }
      if (typeof n.note === 'string') node.note = n.note
      return node
    }
    default:
      return null
  }
}

/** Keeps only variant props/options present in the catalog for this component. */
function validateVariant(raw: unknown, comp: CatalogComponent): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || !comp.variants) return undefined
  const out: Record<string, string> = {}
  for (const [prop, val] of Object.entries(raw as Record<string, unknown>)) {
    const allowed = comp.variants[prop]
    if (allowed && typeof val === 'string' && allowed.includes(val)) out[prop] = val
  }
  return Object.keys(out).length ? out : undefined
}

/** Coerces the raw Gemini object into a valid FigmaLayoutSpec (null if unusable). */
export function normalizeLayoutSpec(raw: unknown, byKey: Map<string, CatalogComponent>): FigmaLayoutSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const pagesRaw = (raw as { pages?: unknown }).pages
  if (!Array.isArray(pagesRaw)) return null
  const pages: LayoutPage[] = pagesRaw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string')
    .map((p) => ({
      name: p.name as string,
      nodes: Array.isArray(p.nodes)
        ? (p.nodes as unknown[]).map((nd) => normalizeNode(nd, byKey)).filter((nd): nd is LayoutNode => nd !== null)
        : [],
    }))
  return { pages }
}

export async function resolveFigmaLayout(featureId: string): Promise<FigmaLayoutSpec | null> {
  const feature = await getFeature(featureId)
  if (!feature) return null
  if (!feature.ux_stitch) {
    console.log('[figma-layout] skip: no ux_stitch', featureId)
    return null
  }
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.warn('[figma-layout] skip: GEMINI_API_KEY unset')
    return null
  }

  const catalog = getComponentCatalog()
  const reuse = await resolveReuseRefs(feature)
  const prompt = [
    'UX STITCH (source structure):',
    JSON.stringify(feature.ux_stitch),
    '',
    'ANT DESIGN CATALOG (choose components by key; variant options are authoritative):',
    JSON.stringify(catalog.components),
    '',
    reuse.length ? `REUSE REFERENCES (prefer these where the stitch marks reuseOf):\n${reuse.map((r) => r.resolved).join('\n---\n')}` : '',
    '',
    'Produce the Figma layout spec as JSON matching the response schema and the node shapes described.',
  ].filter(Boolean).join('\n')

  let raw: unknown
  try {
    const ai = new GoogleGenAI({ apiKey })
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        systemInstruction: RESOLVER_SYSTEM,
        responseMimeType: 'application/json',
        responseSchema: LAYOUT_SCHEMA,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
    })
    const text = response.text
    if (!text) {
      console.warn('[figma-layout] empty Gemini response for', featureId)
      return null
    }
    raw = JSON.parse(text)
  } catch (err) {
    console.warn('[figma-layout] generation failed for', featureId, err instanceof Error ? err.message : err)
    return null
  }

  const spec = normalizeLayoutSpec(raw, catalogByKey(catalog))
  if (!spec || spec.pages.length === 0) {
    console.warn('[figma-layout] normalized spec empty for', featureId)
    return null
  }
  return spec
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest __tests__/lib/features/figma-layout.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/features/figma-layout.ts __tests__/lib/features/figma-layout.test.ts
git commit -m "feat(features): Gemini layout resolver + deterministic key/variant validator"
```

---

## Task 6: Endpoints + proxy + trace + PATCH

**Files:**
- Create: `app/api/features/[id]/figma-layout/route.ts`
- Create: `app/api/features/[id]/figma-file/route.ts`
- Create: `app/api/features/[id]/publish-payload/route.ts`
- Modify: `proxy.ts`
- Modify: `next.config.ts`
- Modify: `app/api/features/[id]/route.ts` (PATCH accepts `reuse_refs`)
- Create: `__tests__/api/features/figma-endpoints.test.ts`

> Before writing routes, skim `node_modules/next/dist/docs/` for this fork's route-handler + `params` conventions — the existing routes here `await params` (a Promise), so match that.

- [ ] **Step 1: Write the endpoint tests**

Create `__tests__/api/features/figma-endpoints.test.ts`:

```ts
// __tests__/api/features/figma-endpoints.test.ts
const mockResolveLayout = jest.fn()
jest.mock('@/lib/features/figma-layout', () => ({ resolveFigmaLayout: (...a: unknown[]) => mockResolveLayout(...a) }))
const mockUpdateFeature = jest.fn().mockResolvedValue({})
jest.mock('@/lib/features/client', () => ({ updateFeature: (...a: unknown[]) => mockUpdateFeature(...a) }))
const mockGetSessionUser = jest.fn()
jest.mock('@/lib/auth', () => ({ getSessionUser: (...a: unknown[]) => mockGetSessionUser(...a) }))

import { GET as getLayout } from '@/app/api/features/[id]/figma-layout/route'
import { POST as postFile } from '@/app/api/features/[id]/figma-file/route'
import { GET as getPayload } from '@/app/api/features/[id]/publish-payload/route'

const params = Promise.resolve({ id: 'f1' })
function req(headers: Record<string, string> = {}, body?: unknown) {
  return new Request('http://localhost/x', {
    method: body ? 'POST' : 'GET',
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  }) as never
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env.FIGMA_PLUGIN_TOKEN = 'plug-secret'
})

describe('GET figma-layout (token auth)', () => {
  it('401s without the token', async () => {
    const res = await getLayout(req(), { params })
    expect(res.status).toBe(401)
  })
  it('200s with the token and returns the spec', async () => {
    mockResolveLayout.mockResolvedValue({ pages: [{ name: 'Components', nodes: [] }] })
    const res = await getLayout(req({ authorization: 'Bearer plug-secret' }), { params })
    expect(res.status).toBe(200)
    expect((await res.json()).pages[0].name).toBe('Components')
  })
  it('502s when the resolver returns null', async () => {
    mockResolveLayout.mockResolvedValue(null)
    const res = await getLayout(req({ authorization: 'Bearer plug-secret' }), { params })
    expect(res.status).toBe(502)
  })
})

describe('POST figma-file (token auth)', () => {
  it('401s without the token', async () => {
    const res = await postFile(req({}, { fileKey: 'abc' }), { params })
    expect(res.status).toBe(401)
  })
  it('persists figma_file_key with the token', async () => {
    const res = await postFile(req({ authorization: 'Bearer plug-secret' }, { fileKey: 'abc' }), { params })
    expect(res.status).toBe(200)
    expect(mockUpdateFeature).toHaveBeenCalledWith('f1', { figma_file_key: 'abc' })
  })
  it('400s when fileKey is missing', async () => {
    const res = await postFile(req({ authorization: 'Bearer plug-secret' }, {}), { params })
    expect(res.status).toBe(400)
  })
})

describe('GET publish-payload (session auth)', () => {
  it('401s when not signed in', async () => {
    mockGetSessionUser.mockResolvedValue(null)
    const res = await getPayload(req(), { params })
    expect(res.status).toBe(401)
  })
  it('returns { featureId, token, baseUrl } for a signed-in PM', async () => {
    mockGetSessionUser.mockResolvedValue({ id: 'u1' })
    const res = await getPayload(req({ host: 'app.example.com' }), { params })
    const body = await res.json()
    expect(body.featureId).toBe('f1')
    expect(body.token).toBe('plug-secret')
    expect(typeof body.baseUrl).toBe('string')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest __tests__/api/features/figma-endpoints.test.ts`
Expected: FAIL — route modules not found.

- [ ] **Step 3: Implement `GET figma-layout`**

Create `app/api/features/[id]/figma-layout/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { resolveFigmaLayout } from '@/lib/features/figma-layout'

// Gemini resolve runs inline; give it room.
export const maxDuration = 120

/** Returns the fully-resolved Figma layout spec. Token-gated (plugin is external). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = process.env.FIGMA_PLUGIN_TOKEN
  const auth = req.headers.get('authorization')
  if (!token || auth !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  const spec = await resolveFigmaLayout(id)
  if (!spec) return NextResponse.json({ error: 'Could not resolve a layout (missing stitch or Gemini failure)' }, { status: 502 })
  return NextResponse.json(spec)
}
```

- [ ] **Step 4: Implement `POST figma-file`**

Create `app/api/features/[id]/figma-file/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { updateFeature } from '@/lib/features/client'

/** Stores the Figma file key the plugin published into. Token-gated. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = process.env.FIGMA_PLUGIN_TOKEN
  const auth = req.headers.get('authorization')
  if (!token || auth !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const fileKey = (body as { fileKey?: unknown }).fileKey
  if (typeof fileKey !== 'string' || !fileKey) {
    return NextResponse.json({ error: 'fileKey required' }, { status: 400 })
  }
  await updateFeature(id, { figma_file_key: fileKey })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 5: Implement `GET publish-payload`**

Create `app/api/features/[id]/publish-payload/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'

/**
 * Hands the authed PM the copy-paste payload for the Figma plugin:
 * { featureId, token, baseUrl }. Session-gated — this is how FIGMA_PLUGIN_TOKEN
 * reaches the browser, only for a signed-in user. Never logged.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const token = process.env.FIGMA_PLUGIN_TOKEN
  if (!token) return NextResponse.json({ error: 'FIGMA_PLUGIN_TOKEN not configured' }, { status: 500 })
  const baseUrl = process.env.PUBLIC_APP_URL ?? new URL(req.url).origin
  return NextResponse.json({ featureId: id, token, baseUrl })
}
```

- [ ] **Step 6: Whitelist the two token-gated routes in `proxy.ts`**

The existing `PUBLIC_PATHS` matcher is prefix-based and can't express the dynamic `[id]` segment. Add a regex list and OR it into the public check. After the `PUBLIC_PATHS` array, add:

```ts
// Token-gated feature sub-routes (FIGMA_PLUGIN_TOKEN bearer, checked in-route).
// The plugin is external and carries no session cookie, so the proxy must not
// gate them — same rationale as the cron routes. The [id] segment forces a
// regex rather than a prefix. NOTE: publish-payload is intentionally NOT here —
// it stays session-gated.
const PUBLIC_PATH_PATTERNS: RegExp[] = [
  /^\/api\/features\/[^/]+\/figma-(layout|file)$/,
]
```

Then extend the public check in `proxy()` (the block at line ~38):

```ts
  // 1. Public paths — no auth required
  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/')) ||
    PUBLIC_PATH_PATTERNS.some((re) => re.test(pathname))
  ) {
    return NextResponse.next()
  }
```

- [ ] **Step 7: Add a proxy test for the new matcher**

Append to `__tests__/proxy.test.ts` (match its existing style — it imports `proxy` and builds `NextRequest`s). Add cases asserting: `/api/features/f1/figma-layout` and `/api/features/f1/figma-file` are allowed without a session; `/api/features/f1/publish-payload` and `/api/features/f1` are NOT (still 401/redirect). Read the file first to mirror its exact request-construction helper, then add:

```ts
it('allows figma-layout/figma-file without a session (token-gated in-route)', async () => {
  for (const p of ['/api/features/f1/figma-layout', '/api/features/f1/figma-file']) {
    const res = await proxy(makeReq(p)) // makeReq = the file's existing helper
    expect(res.status).not.toBe(401)
  }
})
it('still gates publish-payload and the base feature route on session', async () => {
  const res = await proxy(makeReq('/api/features/f1/publish-payload'))
  expect(res.status).toBe(401)
})
```

- [ ] **Step 8: Bundle the catalog into the figma-layout route trace**

In `next.config.ts`, extend `outputFileTracingIncludes`:

```ts
  outputFileTracingIncludes: {
    "/api/features/[id]/conversation/message": ["./design/DESIGN-*.md"],
    "/api/features/[id]/figma-layout": ["./design/figma-antd-catalog.json"],
  },
```

- [ ] **Step 9: Accept `reuse_refs` in the feature PATCH route**

In `app/api/features/[id]/route.ts` `PATCH`, destructure `reuse_refs` from the body and include it in the `updateFeature` call:

```ts
  const { status, name, description, planning_phase, app, reuse_refs } = body
```

and in the `updateFeature({...})` object add:

```ts
    ...(reuse_refs !== undefined && { reuse_refs }),
```

- [ ] **Step 10: Run the endpoint + proxy tests**

Run: `npx jest __tests__/api/features/figma-endpoints.test.ts __tests__/proxy.test.ts`
Expected: PASS.

- [ ] **Step 11: Typecheck + commit**

```bash
npx tsc --noEmit
git add app/api/features/[id]/figma-layout app/api/features/[id]/figma-file app/api/features/[id]/publish-payload app/api/features/[id]/route.ts proxy.ts next.config.ts __tests__/api/features/figma-endpoints.test.ts __tests__/proxy.test.ts
git commit -m "feat(api): figma-layout/figma-file/publish-payload routes + proxy allowlist + catalog trace"
```

---

## Task 7: Reuse-refs UI + Copy Publish Payload

**Files:**
- Create: `app/features/[id]/components/ReuseRefsPanel.tsx`
- Modify: `app/features/[id]/page.tsx`
- Create: `__tests__/components/ReuseRefsPanel.test.tsx`

The panel lives in a Drawer opened from a Header button, so the 3-pane layout is untouched. It edits `features.reuse_refs` (saved via PATCH) and offers "Copy Publish Payload" (fetches `publish-payload`, writes to clipboard).

- [ ] **Step 1: Write the component test**

Create `__tests__/components/ReuseRefsPanel.test.tsx` (jsdom project; antd is mocked via `__mocks__/antd.tsx`). Read `__mocks__/antd.tsx` first to see which primitives are stubbed, then:

```tsx
// __tests__/components/ReuseRefsPanel.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ReuseRefsPanel } from '@/app/features/[id]/components/ReuseRefsPanel'

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ featureId: 'f1', token: 't', baseUrl: 'http://x' }) }) as never
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } })
})

it('renders existing refs', () => {
  render(<ReuseRefsPanel featureId="f1" refs={[{ kind: 'code', value: 'a/b.tsx', note: 'reuse' }]} onSaved={() => {}} />)
  expect(screen.getByDisplayValue('a/b.tsx')).toBeTruthy()
})

it('adds a ref and PATCHes reuse_refs', async () => {
  render(<ReuseRefsPanel featureId="f1" refs={[]} onSaved={() => {}} />)
  fireEvent.click(screen.getByText(/add reference/i))
  fireEvent.click(screen.getByText(/save/i))
  await waitFor(() => {
    expect((global.fetch as jest.Mock)).toHaveBeenCalledWith('/api/features/f1', expect.objectContaining({ method: 'PATCH' }))
  })
})

it('copies the publish payload to the clipboard', async () => {
  render(<ReuseRefsPanel featureId="f1" refs={[]} onSaved={() => {}} />)
  fireEvent.click(screen.getByText(/copy publish payload/i))
  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledWith('/api/features/f1/publish-payload')
    expect(navigator.clipboard.writeText).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest __tests__/components/ReuseRefsPanel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ReuseRefsPanel.tsx`**

```tsx
// app/features/[id]/components/ReuseRefsPanel.tsx
'use client'
import { useState } from 'react'
import { Button, Select, Input, Space, Typography, message } from 'antd'

export type ReuseRefKind = 'figma' | 'code' | 'screenshot'
export interface ReuseRef { kind: ReuseRefKind; value: string; note: string }

const KIND_OPTIONS = [
  { value: 'figma', label: 'Figma link' },
  { value: 'code', label: 'Code path' },
  { value: 'screenshot', label: 'Screenshot URL' },
]

export function ReuseRefsPanel({
  featureId,
  refs,
  onSaved,
}: {
  featureId: string
  refs: ReuseRef[]
  onSaved: () => void
}) {
  const [rows, setRows] = useState<ReuseRef[]>(refs)
  const [saving, setSaving] = useState(false)

  function update(i: number, patch: Partial<ReuseRef>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }
  function add() {
    setRows((rs) => [...rs, { kind: 'figma', value: '', note: '' }])
  }
  function remove(i: number) {
    setRows((rs) => rs.filter((_, idx) => idx !== i))
  }

  async function save() {
    setSaving(true)
    try {
      await fetch(`/api/features/${featureId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reuse_refs: { refs: rows.filter((r) => r.value.trim()) } }),
      })
      message.success('Reuse references saved')
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  async function copyPayload() {
    const res = await fetch(`/api/features/${featureId}/publish-payload`)
    if (!res.ok) { message.error('Could not get publish payload'); return }
    const payload = await res.json()
    await navigator.clipboard.writeText(JSON.stringify(payload))
    message.success('Publish payload copied — paste it into the Figma plugin')
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        Components to recycle when generating this feature&apos;s Figma layout. Curate once; feeds every resolve.
      </Typography.Paragraph>
      {rows.map((r, i) => (
        <Space key={i} align="start" style={{ width: '100%' }}>
          <Select value={r.kind} onChange={(kind) => update(i, { kind })} options={KIND_OPTIONS} style={{ minWidth: 130 }} />
          <Input value={r.value} onChange={(e) => update(i, { value: e.target.value })} placeholder="Figma URL / repo path / image URL" style={{ minWidth: 220 }} />
          <Input value={r.note} onChange={(e) => update(i, { note: e.target.value })} placeholder="note" style={{ minWidth: 140 }} />
          <Button danger type="text" onClick={() => remove(i)}>✕</Button>
        </Space>
      ))}
      <Space>
        <Button onClick={add}>+ Add reference</Button>
        <Button type="primary" loading={saving} onClick={save}>Save</Button>
        <Button onClick={copyPayload}>Copy Publish Payload</Button>
      </Space>
    </Space>
  )
}
```

- [ ] **Step 4: Mount it as a Drawer in `page.tsx`**

Add `reuse_refs` to the `Feature` interface:

```ts
export interface Feature {
  id: string; name: string; description: string | null; status: string
  planning_phase: 'planning' | 'approved' | 'prototyping'; spec_content: string | null
  app: 'web' | 'cms' | 'mobile' | 'desktop'
  reuse_refs: { refs: { kind: 'figma' | 'code' | 'screenshot'; value: string; note: string }[] } | null
  stories: UserStory[]
}
```

Add imports (`Drawer` from antd, the panel), a `showReuse` state, a Header button, and the Drawer. In the imports line add `Drawer`; add `import { ReuseRefsPanel } from './components/ReuseRefsPanel'`. Add state: `const [showReuse, setShowReuse] = useState(false)`. In the `Header`, before the app `Select`, add:

```tsx
        <Button size="small" onClick={() => setShowReuse(true)}>Design → Figma</Button>
```

Before the closing `</Layout>` (outermost), add:

```tsx
      <Drawer title="Design → Figma" open={showReuse} onClose={() => setShowReuse(false)} width={640}>
        <ReuseRefsPanel
          featureId={id}
          refs={feature.reuse_refs?.refs ?? []}
          onSaved={() => { setShowReuse(false); reload() }}
        />
      </Drawer>
```

- [ ] **Step 5: Run the component test + typecheck**

Run: `npx jest __tests__/components/ReuseRefsPanel.test.tsx && npx tsc --noEmit`
Expected: PASS + clean typecheck. (If antd `message`/`Drawer` aren't in `__mocks__/antd.tsx`, add minimal stubs there — check the file first.)

- [ ] **Step 6: Commit**

```bash
git add app/features/[id]/components/ReuseRefsPanel.tsx app/features/[id]/page.tsx __tests__/components/ReuseRefsPanel.test.tsx __mocks__/antd.tsx
git commit -m "feat(ui): reuse references drawer + Copy Publish Payload"
```

---

## Task 8: Full verification + PR

- [ ] **Step 1: Full test suite**

Run: `npx jest`
Expected: PASS — the pre-existing suite plus the ~30 new tests, 0 failures.

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npx next build`
Expected: both clean.

- [ ] **Step 3: Manual curl smoke of the resolver (optional, needs GEMINI_API_KEY + a feature with ux_stitch)**

```bash
FID=<a feature id with ux_stitch>
FIGMA_PLUGIN_TOKEN=<local value>
curl -s -H "Authorization: Bearer $FIGMA_PLUGIN_TOKEN" \
  "http://localhost:3000/api/features/$FID/figma-layout" | head -c 800
```
Expected: a JSON layout spec (pages → nodes with real component keys). This is the artifact Plan 2's plugin consumes.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/publish-stitch-to-figma
gh pr create --title "feat: publish stitch → Figma, Plan 1 (pm-app resolver + reuse refs)" --body "$(cat <<'EOF'
Plan 1 of Spec #2. Adds migration 037 (reuse_refs + figma_file_key), the antd
catalog loader/generator, resolveReuseRefs, the Gemini layout resolver with
deterministic key/variant validation, and the token-gated figma-layout /
figma-file / publish-payload routes + reuse-refs UI.

**Ops before deploy:** apply migration 037; set FIGMA_PLUGIN_TOKEN (rotatable
secret) in Vercel Prod; run `npm run figma:catalog` to commit the full real
catalog. GEMINI_API_KEY already set (Spec #1).

Plan 2 (the Figma plugin) consumes GET /figma-layout.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review notes (spec coverage)

- Migration 037 (reuse_refs + figma_file_key) → Task 1. ✓
- Catalog with real variantOptions + generator → Task 3 (loader tested vs fixture; generator is the ops path that records real variants). ✓
- Reuse refs UI + resolution (figma/code/screenshot) → Tasks 4, 7. ✓
- Gemini resolver → keyed layout spec, variant-validated (unknown key→placeholder, bad variant→stripped) → Task 5. ✓
- `GET figma-layout` + `POST figma-file`, FIGMA_PLUGIN_TOKEN bearer, PUBLIC_PATHS → Task 6. ✓
- "Copy Publish Payload" ({featureId, token, baseUrl}) → Task 7 + publish-payload route (Task 6). ✓
- Baseline spacing prompt, write-only-on-success/never-throw → Task 5. ✓
- Catalog bundled via outputFileTracingIncludes → Task 6 Step 8. ✓

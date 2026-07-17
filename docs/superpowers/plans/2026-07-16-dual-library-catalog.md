# Dual-Library Catalog + Resolver Preference — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Figma layout resolver source components from BOTH the Viscap Media library (high priority — real Navbar, custom cards) and the antd library (fallback), so generated screens use the real design system instead of generic components.

**Architecture:** Tag every catalog component with its source `library` (`'viscap' | 'antd'`). Extend the catalog generator to pull the Viscap Components file's published component sets (by file key) in addition to the antd team library, then merge them Viscap-first (deduped by key). The resolver prompt is told to prefer `library: 'viscap'`. The plugin is unchanged — it still imports by component key.

**Tech Stack:** TypeScript, Node scripts, Figma REST API, Jest.

**Spec:** `docs/superpowers/specs/2026-07-16-figma-design-pipeline-overhaul-design.md` (Workstream A, catalog portion).

---

### Task 1: Tag catalog components with their source library

**Files:**
- Modify: `lib/figma/component-catalog.ts` (add `library` to `CatalogComponent`)
- Modify: `__tests__/lib/features/figma-layout.test.ts:14-24` (mock components need the new field)

- [ ] **Step 1: Add the `library` field to the type**

In `lib/figma/component-catalog.ts`, change the `CatalogComponent` interface:

```ts
export interface CatalogComponent {
  name: string
  key: string
  type: 'set' | 'component'
  /** Source library. The resolver prefers 'viscap' over 'antd' where both fit. */
  library: 'viscap' | 'antd'
  /** propName → allowed option strings, read from the set's VARIANT property defs. */
  variants?: Record<string, string[]>
}
```

- [ ] **Step 2: Update the resolver test mock so it still type-checks**

In `__tests__/lib/features/figma-layout.test.ts`, the `getComponentCatalog` mock lists two components — add `library: 'antd'` to each:

```ts
    components: [
      { name: 'Button', key: 'btnkey', type: 'set', library: 'antd', variants: { Type: ['default', 'primary'] } },
      { name: 'Input', key: 'inpkey', type: 'set', library: 'antd' },
    ],
```

- [ ] **Step 3: Run the resolver tests to confirm nothing broke**

Run: `npx jest __tests__/lib/features/figma-layout.test.ts`
Expected: PASS (15 tests). The added field is inert to existing logic.

- [ ] **Step 4: Commit**

```bash
git add lib/figma/component-catalog.ts __tests__/lib/features/figma-layout.test.ts
git commit -m "feat(catalog): tag components with source library"
```

---

### Task 2: Pure merge function (Viscap-first, dedupe by key)

**Files:**
- Create: `lib/figma/catalog-merge.ts`
- Test: `__tests__/lib/figma/catalog-merge.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/lib/figma/catalog-merge.test.ts`:

```ts
import { mergeCatalogSources } from '@/lib/figma/catalog-merge'
import type { CatalogComponent } from '@/lib/figma/component-catalog'

const v = (name: string, key: string): CatalogComponent => ({ name, key, type: 'set', library: 'viscap' })
const a = (name: string, key: string): CatalogComponent => ({ name, key, type: 'set', library: 'antd' })

it('keeps all viscap components and appends antd', () => {
  const out = mergeCatalogSources([v('Navbar', 'nav')], [a('Button', 'btn')])
  expect(out.map((c) => c.key)).toEqual(['nav', 'btn'])
})

it('viscap wins on a duplicate key — antd copy is dropped', () => {
  const out = mergeCatalogSources([v('Card', 'dup')], [a('Card', 'dup')])
  expect(out).toHaveLength(1)
  expect(out[0].library).toBe('viscap')
})

it('is order-stable: viscap first, then antd', () => {
  const out = mergeCatalogSources([v('A', 'a')], [a('B', 'b'), a('C', 'c')])
  expect(out.map((c) => c.key)).toEqual(['a', 'b', 'c'])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest __tests__/lib/figma/catalog-merge.test.ts`
Expected: FAIL — cannot find module `@/lib/figma/catalog-merge`.

- [ ] **Step 3: Implement the merge**

Create `lib/figma/catalog-merge.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest __tests__/lib/figma/catalog-merge.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/figma/catalog-merge.ts __tests__/lib/figma/catalog-merge.test.ts
git commit -m "feat(catalog): Viscap-first merge of catalog sources"
```

---

### Task 3: Fetch the Viscap Components library and merge it into the catalog

**Files:**
- Modify: `scripts/build-figma-catalog.ts`

The current script pulls antd via the TEAM endpoint. Add a second source: the Viscap Components **file** (`L2WtMQ5D7np7KDJ2vm3Ly0`), whose published sets come from `/v1/files/{key}/component_sets`. Refactor the "fetch sets + their variant defs → CatalogComponent[]" logic into a reusable helper, call it for each library, tag with `library`, and merge.

- [ ] **Step 1: Add the Viscap file key constant**

Near the other constants in `scripts/build-figma-catalog.ts`:

```ts
const VISCAP_LIBRARY_FILE_KEY = process.env.FIGMA_VISCAP_LIBRARY_KEY ?? 'L2WtMQ5D7np7KDJ2vm3Ly0'
```

- [ ] **Step 2: Extract a reusable "sets → variants" helper**

Add this function (it takes the file key that owns the node ids, so it works for both team-sourced antd and file-sourced Viscap):

```ts
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
```

- [ ] **Step 3: Add a file-based component-set fetcher (for Viscap)**

```ts
async function fetchFileComponentSets(token: string, fileKey: string): Promise<ComponentSetMeta[]> {
  const res = (await figmaGetJson(
    token,
    `${FIGMA_API}/v1/files/${fileKey}/component_sets`
  )) as { meta?: { component_sets?: ComponentSetMeta[] } }
  return res.meta?.component_sets ?? []
}
```

- [ ] **Step 4: Build both sources, tag, and merge in `main()`**

Replace the body of `main()` after the token guard with:

```ts
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
```

Add the import at the top:

```ts
import { mergeCatalogSources } from '../lib/figma/catalog-merge'
```

- [ ] **Step 5: Typecheck the script change**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Regenerate the catalog and confirm the Navbar is present as a Viscap set**

Run: `npm run figma:catalog`
Expected: prints `✓ Wrote N sets (9 viscap + M antd) …`. Then verify:

Run: `node -e "const c=require('./design/figma-antd-catalog.json'); console.log(c.components.filter(x=>x.library==='viscap').map(x=>x.name)); console.log('has Navbar:', c.components.some(x=>x.name==='Navbar'&&x.library==='viscap'))"`
Expected: lists Navbar + Menu Item / * and prints `has Navbar: true`.

- [ ] **Step 7: Commit (including the regenerated catalog)**

```bash
git add scripts/build-figma-catalog.ts design/figma-antd-catalog.json
git commit -m "feat(catalog): import the Viscap Components library alongside antd"
```

---

### Task 4: Tell the resolver to prefer Viscap components

**Files:**
- Modify: `lib/features/figma-layout.ts` (the `RESOLVER_SYSTEM` prompt)
- Test: `__tests__/lib/features/figma-layout.test.ts` (assert the preference rule is present)

The catalog is already serialized into the prompt (`JSON.stringify(catalog.components)`), so each component now carries `library`. Add an explicit preference rule.

- [ ] **Step 1: Add the preference rule to `RESOLVER_SYSTEM`**

In `lib/features/figma-layout.ts`, inside the `RESOLVER_SYSTEM` template's Rules list, add:

```
- Each catalog component carries a "library" field. PREFER components with library "viscap" (the real product design system) over "antd" whenever a Viscap component fits — especially navigation, menus, and media cards. Use "antd" only as a fallback for standard UI the Viscap library does not provide.
```

- [ ] **Step 2: Add a test asserting the rule ships in the prompt**

In `__tests__/lib/features/figma-layout.test.ts`, add (the test file already imports/mocks the module; assert on the system instruction passed to Gemini):

```ts
it('instructs the resolver to prefer the viscap library', async () => {
  geminiReturns({ pages: [{ name: 'Components', nodes: [] }] })
  await resolveFigmaLayout('f1')
  const call = mockGenerateContent.mock.calls[0][0]
  expect(call.config.systemInstruction).toMatch(/prefer components with library "viscap"/i)
})
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx jest __tests__/lib/features/figma-layout.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 4: Commit**

```bash
git add lib/features/figma-layout.ts __tests__/lib/features/figma-layout.test.ts
git commit -m "feat(resolver): prefer Viscap library components over antd"
```

---

### Task 5: Full verification

- [ ] **Step 1: Run the whole affected suite + typecheck + lint**

Run: `npx jest __tests__/lib/figma __tests__/lib/features/figma-layout.test.ts && npx tsc --noEmit && npx eslint lib/figma/catalog-merge.ts scripts/build-figma-catalog.ts lib/features/figma-layout.ts`
Expected: all green.

- [ ] **Step 2: End-to-end sanity (manual, needs prod-like data)**

Resolve a feature that has a `ux_stitch` and confirm the layout now references a Viscap `Navbar` component key (library `viscap`) rather than a generic antd one. This closes the "nav wrong everywhere" loop for the Figma-instance path.

---

## Notes for the implementer

- The plugin needs **no change** for this plan — it imports whatever component key the resolver emits. Separately confirm the plugin's Figma account has the Viscap Components + antd libraries **enabled**, or `importComponentSetByKeyAsync` will fail on real keys (spec Open Question 1).
- This plan does **not** cover: Components-Inspo indexing, Navbar active-state anchoring, or workflow-scoped/stateless payloads. Those are separate Phase-1 plans that build on this one.

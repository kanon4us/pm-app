# Figma Migration Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the inventory → manifest → verify → seed tooling that drives the Figma monolith→zoned migration (spec §8) and seeds `design/figma-index.json` + `design/figma-index.pending.json`.

**Architecture:** Pure, fixture-tested transform functions in `lib/design-migration/` wrapped by thin I/O scripts in `scripts/`. The Figma REST API is read-only (inventory + verify only); all canvas changes are manual. Reuses `lib/design-index/types.ts` (`Feature`, `validateDesignIndex`) and the relative-import + `ts-node` conventions established by the validator subsystem.

**Tech Stack:** TypeScript, Jest (ts-jest, node project), ts-node (CLI), Figma REST API. No new runtime dependencies.

**Scope note:** Subsystem #2 of 5. Builds Phases 0/1/5/6 (software). Phases 2–4 (manual Figma scaffold/archive/moves) and Phase 7 (reconciliation backlog) are operational, not code. Open-question defaults locked in by approval: inventory auth uses a dedicated `FIGMA_MIGRATION_TOKEN` PAT; the `codePaths` lookup is seeded from the current repo route map and refined during Phase 1 review.

**Conventions (verified against the validator subsystem):**
- Pure libs use **relative imports**, not the `@/` alias (so `ts-node` runs them). Tests use `@/` (Jest `moduleNameMapper`).
- Single test file: `npx jest __tests__/lib/design-migration/<name>.test.ts`
- Typecheck: `npm run typecheck`
- `tsconfig.json` already has the `ts-node` CommonJS override.

---

## File Structure

- `lib/design-migration/types.ts` — data shapes (inventory, manifest, pending entry).
- `lib/design-migration/inference.ts` — pure inference helpers + lookup tables (app, section/feature, codePaths, clickupId).
- `lib/design-migration/manifest.ts` — `inventoryToManifest` transform.
- `lib/design-migration/verify.ts` — `diffManifestVsInventory` transform.
- `lib/design-migration/seed.ts` — `manifestToIndexEntries` (reconciled/pending split).
- `lib/design-migration/figma-map.ts` — pure `toInventoryFile` (Figma API response → inventory row).
- `scripts/figma-inventory.ts` — fetch workspace → `design/figma-inventory.json`.
- `scripts/build-migration-manifest.ts` — inventory → `design/migration-manifest.json`.
- `scripts/verify-figma-migration.ts` — fresh inventory vs manifest → drift report + exit code.
- `scripts/seed-index-from-manifest.ts` — manifest → `figma-index.json` + `figma-index.pending.json`.
- `__tests__/lib/design-migration/*.test.ts` — unit tests for each pure module.
- `package.json` — add `figma:inventory`, `figma:manifest`, `figma:verify`, `figma:seed` scripts.

---

## Task 1: Migration types

**Files:**
- Create: `lib/design-migration/types.ts`

- [ ] **Step 1: Write the types**

```ts
// lib/design-migration/types.ts
import type { Feature } from '../design-index/types'

export interface FigmaInventoryFile {
  projectName: string
  fileKey: string
  fileName: string
  fileUrl: string
  pages: { nodeId: string; name: string }[]
  frameCount: number
}

export interface FigmaInventory {
  fetchedAt: string
  files: FigmaInventoryFile[]
}

export type Zone = 'foundations' | 'product' | 'flows' | 'archive'
export type AppKeyOrNull = 'web' | 'cms' | 'mobile' | null

export interface ManifestPage {
  nodeId: string
  name: string
  clickupId: string
  inferredFromPageName: boolean
}

export interface ManifestFile {
  sourceFileKey: string
  sourceFileUrl: string
  zone: Zone
  app: AppKeyOrNull
  targetSection: string | null
  targetFeature: string | null
  codePaths: string[]
  unassigned: boolean
  oversized: boolean
  pages: ManifestPage[]
}

export interface MigrationManifest {
  version: number
  builtAt: string
  files: ManifestFile[]
}

export type PendingReason =
  | 'placeholder-clickup'
  | 'unassigned-codepaths'
  | 'unassigned-feature'

export interface PendingEntry {
  featureId: string
  reason: PendingReason[]
  partial: Partial<Feature>
}

export interface IndexSplit {
  reconciled: Feature[]
  pending: PendingEntry[]
}

/** frameCount above this flags a file for a Phase-4 split. Tunable post-inventory. */
export const OVERSIZED_FRAME_THRESHOLD = 40
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: PASS (exit 0).

- [ ] **Step 3: Commit**

```bash
git add lib/design-migration/types.ts
git commit -m "feat(migration): inventory/manifest/pending type definitions"
```

---

## Task 2: Pure inference helpers + lookup tables

**Files:**
- Create: `lib/design-migration/inference.ts`
- Test: `__tests__/lib/design-migration/inference.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/design-migration/inference.test.ts
import {
  inferApp,
  inferSectionFeature,
  inferCodePaths,
  inferClickupId,
} from '@/lib/design-migration/inference'

describe('inferApp', () => {
  it('maps known web projects to web', () => {
    expect(inferApp('Performance Hub', 'Performance Hub')).toBe('web')
    expect(inferApp('Viscap UI', 'Settings')).toBe('web')
  })
  it('maps the mobile project to mobile', () => {
    expect(inferApp('MVP Mobile App', 'Home')).toBe('mobile')
  })
  it('maps desktop to archive-bound null', () => {
    expect(inferApp('Media Sync Desktop App', 'Sync')).toBeNull()
  })
  it('returns null for unknown projects', () => {
    expect(inferApp('Totally Unknown', 'x')).toBeNull()
  })
})

describe('inferSectionFeature', () => {
  it('splits "Section — Feature" on the em dash', () => {
    expect(inferSectionFeature('Settings — Billing')).toEqual({
      section: 'Settings',
      feature: 'Billing',
    })
  })
  it('splits "Section / Feature" on the slash', () => {
    expect(inferSectionFeature('Performance Hub / Filters')).toEqual({
      section: 'Performance Hub',
      feature: 'Filters',
    })
  })
  it('uses the whole name as both when no separator', () => {
    expect(inferSectionFeature('Casting')).toEqual({ section: 'Casting', feature: 'Casting' })
  })
})

describe('inferCodePaths', () => {
  it('maps a known section to real repo dirs', () => {
    expect(inferCodePaths('Performance Hub', 'Performance Hub')).toEqual(['app/sprint/**'])
  })
  it('returns [] for an unknown section', () => {
    expect(inferCodePaths('Mystery', 'Thing')).toEqual([])
  })
})

describe('inferClickupId', () => {
  it('uses a US-#### page name when present', () => {
    expect(inferClickupId('US-1234 · Default payment', 'web-settings', 0)).toEqual({
      clickupId: 'US-1234',
      inferredFromPageName: true,
    })
  })
  it('emits a unique placeholder otherwise', () => {
    expect(inferClickupId('Some page', 'web-settings', 2)).toEqual({
      clickupId: 'PENDING-web-settings-2',
      inferredFromPageName: false,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/lib/design-migration/inference.test.ts`
Expected: FAIL — "Cannot find module '@/lib/design-migration/inference'".

- [ ] **Step 3: Write the inference module**

```ts
// lib/design-migration/inference.ts
import type { AppKeyOrNull } from './types'

/** Source Figma project/file name → app. Refined during Phase 1 review. */
const WEB_PROJECTS = new Set([
  'Viscap UI', 'ActorHub', 'Actor Hub', 'Performance Hub', 'Perfomance Hub',
  'Creatives', 'Settings', 'Ideation', 'B-Doc', 'Brand Intranet',
  'Phase&Sprints', 'Phase & Sprints', 'Media Library', 'Login / Sign Up',
])
const CMS_PROJECTS = new Set(['CMS', 'CMS Web Application'])
const MOBILE_PROJECTS = new Set(['MVP Mobile App'])
const ARCHIVE_PROJECTS = new Set(['Media Sync Desktop App', 'Desktop'])

export function inferApp(projectName: string, _fileName: string): AppKeyOrNull {
  if (MOBILE_PROJECTS.has(projectName)) return 'mobile'
  if (CMS_PROJECTS.has(projectName)) return 'cms'
  if (ARCHIVE_PROJECTS.has(projectName)) return null
  if (WEB_PROJECTS.has(projectName)) return 'web'
  return null
}

export function inferSectionFeature(name: string): { section: string; feature: string } {
  const sep = name.includes(' — ') ? ' — ' : name.includes(' / ') ? ' / ' : null
  if (!sep) return { section: name.trim(), feature: name.trim() }
  const [section, ...rest] = name.split(sep)
  return { section: section.trim(), feature: rest.join(sep).trim() }
}

/** Section → real repo dirs. Seeded from the current route map; refined in Phase 1. */
const CODE_PATHS_BY_SECTION: Record<string, string[]> = {
  'Performance Hub': ['app/sprint/**'],
  'Phase&Sprints': ['app/sprint/**'],
  'Phase & Sprints': ['app/sprint/**'],
  'Settings': ['app/setup/**', 'lib/field-config.ts'],
  'Ideation': ['app/features/**'],
  'B-Doc': ['app/features/**'],
}

export function inferCodePaths(section: string, _feature: string): string[] {
  return CODE_PATHS_BY_SECTION[section] ?? []
}

const US_PATTERN = /^(US-\d+)/

export function inferClickupId(
  pageName: string,
  featureId: string,
  index: number
): { clickupId: string; inferredFromPageName: boolean } {
  const m = pageName.match(US_PATTERN)
  if (m) return { clickupId: m[1], inferredFromPageName: true }
  return { clickupId: `PENDING-${featureId}-${index}`, inferredFromPageName: false }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/lib/design-migration/inference.test.ts`
Expected: PASS (15 assertions across the describes).

- [ ] **Step 5: Commit**

```bash
git add lib/design-migration/inference.ts __tests__/lib/design-migration/inference.test.ts
git commit -m "feat(migration): pure inference helpers + lookup tables"
```

---

## Task 3: `inventoryToManifest` transform

**Files:**
- Create: `lib/design-migration/manifest.ts`
- Test: `__tests__/lib/design-migration/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/design-migration/manifest.test.ts
import { inventoryToManifest, featureIdFor } from '@/lib/design-migration/manifest'
import type { FigmaInventory } from '@/lib/design-migration/types'

function inv(over: Partial<FigmaInventory['files'][0]> = {}): FigmaInventory {
  return {
    fetchedAt: '2026-06-29T00:00:00.000Z',
    files: [
      {
        projectName: 'Viscap UI',
        fileKey: 'k1',
        fileName: 'Settings — Billing',
        fileUrl: 'https://figma.com/design/k1/Settings-Billing',
        pages: [{ nodeId: '1:1', name: 'US-1234 · Default payment' }],
        frameCount: 10,
        ...over,
      },
    ],
  }
}

describe('inventoryToManifest', () => {
  it('maps a known web file to product zone with section/feature/codePaths', () => {
    const m = inventoryToManifest(inv())
    const f = m.files[0]
    expect(f.zone).toBe('product')
    expect(f.app).toBe('web')
    expect(f.targetSection).toBe('Settings')
    expect(f.targetFeature).toBe('Billing')
    expect(f.codePaths).toEqual(['app/setup/**', 'lib/field-config.ts'])
    expect(f.unassigned).toBe(false)
  })

  it('infers a US-#### clickupId from the page name', () => {
    const m = inventoryToManifest(inv())
    expect(m.files[0].pages[0]).toMatchObject({
      clickupId: 'US-1234',
      inferredFromPageName: true,
    })
  })

  it('emits unique placeholders for non-US page names', () => {
    const m = inventoryToManifest(
      inv({ pages: [{ nodeId: '1:1', name: 'Overview' }, { nodeId: '1:2', name: 'Detail' }] })
    )
    const ids = m.files[0].pages.map((p) => p.clickupId)
    expect(ids).toEqual(['PENDING-web-settings-billing-0', 'PENDING-web-settings-billing-1'])
    expect(new Set(ids).size).toBe(2)
  })

  it('flags oversized files', () => {
    const m = inventoryToManifest(inv({ frameCount: 99 }))
    expect(m.files[0].oversized).toBe(true)
  })

  it('routes desktop files to the archive zone', () => {
    const m = inventoryToManifest(inv({ projectName: 'Desktop', fileName: 'Sync' }))
    expect(m.files[0].zone).toBe('archive')
  })

  it('marks unknown-app files unassigned with empty codePaths', () => {
    const m = inventoryToManifest(inv({ projectName: 'Totally Unknown', fileName: 'Weird' }))
    const f = m.files[0]
    expect(f.unassigned).toBe(true)
    expect(f.codePaths).toEqual([])
  })

  it('builds a stable kebab featureId', () => {
    expect(featureIdFor('web', 'Settings', 'Billing')).toBe('web-settings-billing')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/lib/design-migration/manifest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the transform**

```ts
// lib/design-migration/manifest.ts
import {
  inferApp,
  inferSectionFeature,
  inferCodePaths,
  inferClickupId,
} from './inference'
import {
  OVERSIZED_FRAME_THRESHOLD,
  type FigmaInventory,
  type ManifestFile,
  type MigrationManifest,
  type Zone,
} from './types'

export function featureIdFor(app: string, section: string, feature: string): string {
  return [app, section, feature]
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function zoneFor(projectName: string, app: string | null): Zone {
  if (projectName === 'Desktop' || projectName === 'Media Sync Desktop App') return 'archive'
  if (app) return 'product'
  return 'archive'
}

export function inventoryToManifest(inventory: FigmaInventory): MigrationManifest {
  const files: ManifestFile[] = inventory.files.map((file) => {
    const app = inferApp(file.projectName, file.fileName)
    const zone = zoneFor(file.projectName, app)
    const { section, feature } = inferSectionFeature(file.fileName)
    const codePaths = app ? inferCodePaths(section, feature) : []
    const featureId = app ? featureIdFor(app, section, feature) : `unassigned-${file.fileKey}`
    const unassigned = !app || codePaths.length === 0

    const pages = file.pages.map((p, i) => {
      const { clickupId, inferredFromPageName } = inferClickupId(p.name, featureId, i)
      return { nodeId: p.nodeId, name: p.name, clickupId, inferredFromPageName }
    })

    return {
      sourceFileKey: file.fileKey,
      sourceFileUrl: file.fileUrl,
      zone,
      app,
      targetSection: app ? section : null,
      targetFeature: app ? feature : null,
      codePaths,
      unassigned,
      oversized: file.frameCount > OVERSIZED_FRAME_THRESHOLD,
      pages,
    }
  })

  return { version: 1, builtAt: new Date().toISOString(), files }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/lib/design-migration/manifest.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/design-migration/manifest.ts __tests__/lib/design-migration/manifest.test.ts
git commit -m "feat(migration): inventoryToManifest transform"
```

---

## Task 4: `diffManifestVsInventory` transform

**Files:**
- Create: `lib/design-migration/verify.ts`
- Test: `__tests__/lib/design-migration/verify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/design-migration/verify.test.ts
import { diffManifestVsInventory } from '@/lib/design-migration/verify'
import type { FigmaInventory, MigrationManifest } from '@/lib/design-migration/types'

function manifest(): MigrationManifest {
  return {
    version: 1,
    builtAt: '2026-06-29T00:00:00.000Z',
    files: [
      {
        sourceFileKey: 'k1',
        sourceFileUrl: 'https://figma.com/design/k1/Settings-Billing',
        zone: 'product',
        app: 'web',
        targetSection: 'Settings',
        targetFeature: 'Billing',
        codePaths: ['app/setup/**'],
        unassigned: false,
        oversized: false,
        pages: [{ nodeId: '1:1', name: 'US-1', clickupId: 'US-1', inferredFromPageName: true }],
      },
    ],
  }
}

function freshInv(keys: string[]): FigmaInventory {
  return {
    fetchedAt: '2026-06-29T01:00:00.000Z',
    files: keys.map((k) => ({
      projectName: '▣ WEB APP',
      fileKey: k,
      fileName: 'Settings — Billing',
      fileUrl: `https://figma.com/design/${k}/x`,
      pages: [{ nodeId: '1:1', name: 'US-1' }],
      frameCount: 5,
    })),
  }
}

describe('diffManifestVsInventory', () => {
  it('reports no drift when every manifest file is still present', () => {
    const report = diffManifestVsInventory(manifest(), freshInv(['k1']))
    expect(report.drift).toBe(false)
    expect(report.missing).toEqual([])
  })

  it('reports a manifest file missing from the fresh inventory', () => {
    const report = diffManifestVsInventory(manifest(), freshInv([]))
    expect(report.drift).toBe(true)
    expect(report.missing).toEqual(['k1'])
  })

  it('reports inventory files not present in the manifest as extra', () => {
    const report = diffManifestVsInventory(manifest(), freshInv(['k1', 'k2']))
    expect(report.drift).toBe(true)
    expect(report.extra).toEqual(['k2'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/lib/design-migration/verify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the transform**

```ts
// lib/design-migration/verify.ts
import type { FigmaInventory, MigrationManifest } from './types'

export interface DriftReport {
  drift: boolean
  missing: string[] // manifest fileKeys absent from fresh inventory
  extra: string[]   // fresh inventory fileKeys absent from manifest
}

export function diffManifestVsInventory(
  manifest: MigrationManifest,
  fresh: FigmaInventory
): DriftReport {
  const manifestKeys = new Set(manifest.files.map((f) => f.sourceFileKey))
  const freshKeys = new Set(fresh.files.map((f) => f.fileKey))

  const missing = [...manifestKeys].filter((k) => !freshKeys.has(k))
  const extra = [...freshKeys].filter((k) => !manifestKeys.has(k))

  return { drift: missing.length > 0 || extra.length > 0, missing, extra }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/lib/design-migration/verify.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/design-migration/verify.ts __tests__/lib/design-migration/verify.test.ts
git commit -m "feat(migration): diffManifestVsInventory drift check"
```

---

## Task 5: `manifestToIndexEntries` (reconciled/pending split)

**Files:**
- Create: `lib/design-migration/seed.ts`
- Test: `__tests__/lib/design-migration/seed.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/design-migration/seed.test.ts
import { manifestToIndexEntries, toDesignIndex } from '@/lib/design-migration/seed'
import { validateDesignIndex } from '@/lib/design-index/validate'
import type { MigrationManifest, ManifestFile } from '@/lib/design-migration/types'

function file(over: Partial<ManifestFile> = {}): ManifestFile {
  return {
    sourceFileKey: 'k1',
    sourceFileUrl: 'https://figma.com/design/k1/Settings-Billing',
    zone: 'product',
    app: 'web',
    targetSection: 'Settings',
    targetFeature: 'Billing',
    codePaths: ['app/setup/**'],
    unassigned: false,
    oversized: false,
    pages: [
      { nodeId: '1:1', name: 'US-1234', clickupId: 'US-1234', inferredFromPageName: true },
    ],
    ...over,
  }
}

function manifest(files: ManifestFile[]): MigrationManifest {
  return { version: 1, builtAt: '2026-06-29T00:00:00.000Z', files }
}

describe('manifestToIndexEntries', () => {
  it('routes a fully-mapped file to reconciled', () => {
    const { reconciled, pending } = manifestToIndexEntries(manifest([file()]))
    expect(reconciled).toHaveLength(1)
    expect(pending).toHaveLength(0)
    expect(reconciled[0].userStories[0].status).toBe('shipped')
  })

  it('routes a placeholder-clickup file to pending', () => {
    const { reconciled, pending } = manifestToIndexEntries(
      manifest([
        file({
          pages: [
            { nodeId: '1:1', name: 'Overview', clickupId: 'PENDING-web-settings-billing-0', inferredFromPageName: false },
          ],
        }),
      ])
    )
    expect(reconciled).toHaveLength(0)
    expect(pending).toHaveLength(1)
    expect(pending[0].reason).toContain('placeholder-clickup')
  })

  it('routes an unassigned file to pending', () => {
    const { reconciled, pending } = manifestToIndexEntries(
      manifest([file({ unassigned: true, codePaths: [], app: null, targetSection: null, targetFeature: null })])
    )
    expect(reconciled).toHaveLength(0)
    expect(pending).toHaveLength(1)
  })

  it('produces a reconciled set that passes the strict validator', () => {
    const { reconciled } = manifestToIndexEntries(manifest([file()]))
    const index = toDesignIndex(reconciled)
    const errors = validateDesignIndex(index, { pathExists: () => true, knownClickupIds: null })
    expect(errors).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/lib/design-migration/seed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// lib/design-migration/seed.ts
import { featureIdFor } from './manifest'
import type { DesignIndex, Feature, UserStory } from '../design-index/types'
import type {
  IndexSplit,
  ManifestFile,
  MigrationManifest,
  PendingEntry,
  PendingReason,
} from './types'

function isPlaceholder(clickupId: string): boolean {
  return clickupId.startsWith('PENDING-')
}

function toFeature(f: ManifestFile): Feature {
  const userStories: UserStory[] = f.pages.map((p) => ({
    clickupId: p.clickupId,
    title: p.name,
    status: 'shipped', // legacy designs mirror the live product (spec §6)
    figmaPageNodeId: p.nodeId,
    sourceOfTruthNodeId: p.nodeId,
    sandboxNodeId: p.nodeId,
  }))
  return {
    id: featureIdFor(f.app!, f.targetSection!, f.targetFeature!),
    app: f.app!,
    section: f.targetSection!,
    feature: f.targetFeature!,
    figmaFileKey: f.sourceFileKey,
    figmaFileUrl: f.sourceFileUrl,
    codePaths: f.codePaths,
    userStories,
  }
}

function pendingReasons(f: ManifestFile): PendingReason[] {
  const reasons: PendingReason[] = []
  if (f.unassigned && (!f.app || !f.targetFeature)) reasons.push('unassigned-feature')
  if (f.codePaths.length === 0) reasons.push('unassigned-codepaths')
  if (f.pages.some((p) => isPlaceholder(p.clickupId))) reasons.push('placeholder-clickup')
  return reasons
}

export function manifestToIndexEntries(manifest: MigrationManifest): IndexSplit {
  const reconciled: Feature[] = []
  const pending: PendingEntry[] = []

  for (const f of manifest.files) {
    if (f.zone === 'archive') continue // archived originals aren't indexed
    const reasons = pendingReasons(f)
    if (reasons.length === 0 && f.app && f.targetSection && f.targetFeature) {
      reconciled.push(toFeature(f))
    } else {
      pending.push({
        featureId: f.app && f.targetSection && f.targetFeature
          ? featureIdFor(f.app, f.targetSection, f.targetFeature)
          : `unassigned-${f.sourceFileKey}`,
        reason: reasons.length > 0 ? reasons : ['unassigned-feature'],
        partial: {
          figmaFileKey: f.sourceFileKey,
          figmaFileUrl: f.sourceFileUrl,
          codePaths: f.codePaths,
        },
      })
    }
  }

  return { reconciled, pending }
}

export function toDesignIndex(features: Feature[]): DesignIndex {
  return {
    version: 1,
    apps: {
      web: { figmaProject: '▣ WEB APP' },
      cms: { figmaProject: '▣ CMS APP' },
      mobile: { figmaProject: '▣ MOBILE APP' },
    },
    features,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/lib/design-migration/seed.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/design-migration/seed.ts __tests__/lib/design-migration/seed.test.ts
git commit -m "feat(migration): manifestToIndexEntries reconciled/pending split"
```

---

## Task 6: Pure Figma response mapper

**Files:**
- Create: `lib/design-migration/figma-map.ts`
- Test: `__tests__/lib/design-migration/figma-map.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/design-migration/figma-map.test.ts
import { toInventoryFile } from '@/lib/design-migration/figma-map'

const fileResponse = {
  document: {
    children: [
      {
        id: '1:1',
        name: 'Page A',
        type: 'CANVAS',
        children: [
          { id: '1:2', name: 'Frame 1', type: 'FRAME' },
          { id: '1:3', name: 'Group', type: 'GROUP' },
        ],
      },
      {
        id: '2:1',
        name: 'Page B',
        type: 'CANVAS',
        children: [{ id: '2:2', name: 'Frame 2', type: 'FRAME' }],
      },
    ],
  },
}

describe('toInventoryFile', () => {
  it('extracts pages (canvases) and counts frames across pages', () => {
    const row = toInventoryFile('ProjX', 'k9', 'Settings — Billing', fileResponse)
    expect(row.projectName).toBe('ProjX')
    expect(row.fileKey).toBe('k9')
    expect(row.fileUrl).toBe('https://figma.com/design/k9/Settings-Billing')
    expect(row.pages).toEqual([
      { nodeId: '1:1', name: 'Page A' },
      { nodeId: '2:1', name: 'Page B' },
    ])
    expect(row.frameCount).toBe(2)
  })

  it('handles an empty document', () => {
    const row = toInventoryFile('ProjX', 'k0', 'Empty', { document: { children: [] } })
    expect(row.pages).toEqual([])
    expect(row.frameCount).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/lib/design-migration/figma-map.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the mapper**

```ts
// lib/design-migration/figma-map.ts
import type { FigmaInventoryFile } from './types'

interface RawNode {
  id: string
  name: string
  type: string
  children?: RawNode[]
}
interface RawFileResponse {
  document?: { children?: RawNode[] }
}

function slugForUrl(fileName: string): string {
  return fileName.trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function toInventoryFile(
  projectName: string,
  fileKey: string,
  fileName: string,
  response: RawFileResponse
): FigmaInventoryFile {
  const canvases = (response.document?.children ?? []).filter((n) => n.type === 'CANVAS')
  const pages = canvases.map((c) => ({ nodeId: c.id, name: c.name }))
  const frameCount = canvases.reduce(
    (sum, c) => sum + (c.children ?? []).filter((n) => n.type === 'FRAME').length,
    0
  )
  return {
    projectName,
    fileKey,
    fileName,
    fileUrl: `https://figma.com/design/${fileKey}/${slugForUrl(fileName)}`,
    pages,
    frameCount,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/lib/design-migration/figma-map.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/design-migration/figma-map.ts __tests__/lib/design-migration/figma-map.test.ts
git commit -m "feat(migration): pure Figma response → inventory mapper"
```

---

## Task 7: Inventory script (Phase 0)

**Files:**
- Create: `scripts/figma-inventory.ts`
- Modify: `package.json` (scripts block)

- [ ] **Step 1: Write the script**

```ts
// scripts/figma-inventory.ts
import * as fs from 'fs'
import * as path from 'path'
import { toInventoryFile } from '../lib/design-migration/figma-map'
import type { FigmaInventory, FigmaInventoryFile } from '../lib/design-migration/types'

const FIGMA_API = 'https://api.figma.com'
const REPO_ROOT = path.join(__dirname, '..')
const OUT_PATH = path.join(REPO_ROOT, 'design', 'figma-inventory.json')

const TOKEN = process.env.FIGMA_MIGRATION_TOKEN
const TEAM_ID = process.env.FIGMA_TEAM_ID

function headers() {
  return { 'X-Figma-Token': TOKEN as string }
}

async function getJson(url: string, attempt = 0): Promise<unknown> {
  const res = await fetch(url, { headers: headers() })
  if (res.status === 429 && attempt < 5) {
    const wait = 2 ** attempt * 1000
    console.warn(`  429 rate-limited, backing off ${wait}ms`)
    await new Promise((r) => setTimeout(r, wait))
    return getJson(url, attempt + 1)
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res.json()
}

interface ProjectsResp { projects: { id: string; name: string }[] }
interface FilesResp { files: { key: string; name: string }[] }

async function main() {
  if (!TOKEN || !TEAM_ID) {
    console.error('✗ Set FIGMA_MIGRATION_TOKEN and FIGMA_TEAM_ID in the environment.')
    process.exit(1)
  }

  const files: FigmaInventoryFile[] = []
  const { projects } = (await getJson(`${FIGMA_API}/v1/teams/${TEAM_ID}/projects`)) as ProjectsResp

  for (const project of projects) {
    console.log(`• ${project.name}`)
    const { files: projFiles } = (await getJson(
      `${FIGMA_API}/v1/projects/${project.id}/files`
    )) as FilesResp

    for (const f of projFiles) {
      try {
        const detail = await getJson(`${FIGMA_API}/v1/files/${f.key}?depth=2`)
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
```

- [ ] **Step 2: Add the npm script**

In `package.json` `"scripts"`, add:

```json
    "figma:inventory": "ts-node scripts/figma-inventory.ts"
```

- [ ] **Step 3: Verify it fails cleanly without credentials**

Run: `npm run figma:inventory`
Expected: FAIL exit 1 with "Set FIGMA_MIGRATION_TOKEN and FIGMA_TEAM_ID".

- [ ] **Step 4: Commit**

```bash
git add scripts/figma-inventory.ts package.json
git commit -m "feat(migration): figma-inventory script (Phase 0)"
```

---

## Task 8: Manifest + verify scripts (Phases 1 & 5)

**Files:**
- Create: `scripts/build-migration-manifest.ts`
- Create: `scripts/verify-figma-migration.ts`
- Modify: `package.json` (scripts block)

- [ ] **Step 1: Write the manifest builder**

```ts
// scripts/build-migration-manifest.ts
import * as fs from 'fs'
import * as path from 'path'
import { inventoryToManifest } from '../lib/design-migration/manifest'
import type { FigmaInventory } from '../lib/design-migration/types'

const REPO_ROOT = path.join(__dirname, '..')
const INV_PATH = path.join(REPO_ROOT, 'design', 'figma-inventory.json')
const OUT_PATH = path.join(REPO_ROOT, 'design', 'migration-manifest.json')

function main() {
  let inventory: FigmaInventory
  try {
    inventory = JSON.parse(fs.readFileSync(INV_PATH, 'utf8')) as FigmaInventory
  } catch (err) {
    console.error(`✗ Could not read ${INV_PATH}:`, (err as Error).message)
    process.exit(1)
  }
  const manifest = inventoryToManifest(inventory)
  fs.writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + '\n')
  const unassigned = manifest.files.filter((f) => f.unassigned).length
  const oversized = manifest.files.filter((f) => f.oversized).length
  console.log(
    `✓ Wrote ${manifest.files.length} files to ${OUT_PATH} (${unassigned} unassigned, ${oversized} oversized) — review before Phase 4.`
  )
}

main()
```

- [ ] **Step 2: Write the verify script**

```ts
// scripts/verify-figma-migration.ts
import * as fs from 'fs'
import * as path from 'path'
import { diffManifestVsInventory } from '../lib/design-migration/verify'
import type { FigmaInventory, MigrationManifest } from '../lib/design-migration/types'

const REPO_ROOT = path.join(__dirname, '..')
const INV_PATH = path.join(REPO_ROOT, 'design', 'figma-inventory.json')
const MANIFEST_PATH = path.join(REPO_ROOT, 'design', 'migration-manifest.json')

function read<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T
}

function main() {
  let manifest: MigrationManifest
  let fresh: FigmaInventory
  try {
    manifest = read<MigrationManifest>(MANIFEST_PATH)
    fresh = read<FigmaInventory>(INV_PATH)
  } catch (err) {
    console.error('✗ Could not read manifest/inventory:', (err as Error).message)
    process.exit(1)
  }

  const report = diffManifestVsInventory(manifest, fresh)
  if (!report.drift) {
    console.log('✓ No drift — workspace matches the manifest.')
    process.exit(0)
  }
  console.error('✗ Drift detected:')
  if (report.missing.length) console.error(`  missing from Figma: ${report.missing.join(', ')}`)
  if (report.extra.length) console.error(`  not in manifest: ${report.extra.join(', ')}`)
  process.exit(1)
}

main()
```

- [ ] **Step 3: Add npm scripts**

In `package.json` `"scripts"`, add:

```json
    "figma:manifest": "ts-node scripts/build-migration-manifest.ts",
    "figma:verify": "ts-node scripts/verify-figma-migration.ts"
```

- [ ] **Step 4: Verify both fail cleanly without input files**

Run: `npm run figma:manifest`
Expected: FAIL exit 1 with "Could not read .../figma-inventory.json".

Run: `npm run figma:verify`
Expected: FAIL exit 1 with "Could not read manifest/inventory".

- [ ] **Step 5: Commit**

```bash
git add scripts/build-migration-manifest.ts scripts/verify-figma-migration.ts package.json
git commit -m "feat(migration): manifest builder + drift verify scripts"
```

---

## Task 9: Seed script (Phase 6)

**Files:**
- Create: `scripts/seed-index-from-manifest.ts`
- Modify: `package.json` (scripts block)
- Test: `__tests__/scripts/seed-index-from-manifest.test.ts`

- [ ] **Step 1: Write the failing test (pure assembly is reused; test the validator gate via the lib)**

```ts
// __tests__/scripts/seed-index-from-manifest.test.ts
// Guards the contract the seed script relies on: a reconciled set assembled from
// a manifest must pass the strict validator with real-path injection.
import { manifestToIndexEntries, toDesignIndex } from '@/lib/design-migration/seed'
import { validateDesignIndex } from '@/lib/design-index/validate'
import type { MigrationManifest } from '@/lib/design-migration/types'

const manifest: MigrationManifest = {
  version: 1,
  builtAt: '2026-06-29T00:00:00.000Z',
  files: [
    {
      sourceFileKey: 'k1',
      sourceFileUrl: 'https://figma.com/design/k1/Settings-Billing',
      zone: 'product',
      app: 'web',
      targetSection: 'Settings',
      targetFeature: 'Billing',
      codePaths: ['app/setup/**'],
      unassigned: false,
      oversized: false,
      pages: [{ nodeId: '1:1', name: 'US-1', clickupId: 'US-1', inferredFromPageName: true }],
    },
  ],
}

it('reconciled output validates with real paths', () => {
  const { reconciled } = manifestToIndexEntries(manifest)
  const errors = validateDesignIndex(toDesignIndex(reconciled), {
    pathExists: () => true,
    knownClickupIds: null,
  })
  expect(errors).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it passes (depends only on Task 5 libs)**

Run: `npx jest __tests__/scripts/seed-index-from-manifest.test.ts`
Expected: PASS (1 test).

- [ ] **Step 3: Write the seed script**

```ts
// scripts/seed-index-from-manifest.ts
import * as fs from 'fs'
import * as path from 'path'
import { manifestToIndexEntries, toDesignIndex } from '../lib/design-migration/seed'
import { validateDesignIndex } from '../lib/design-index/validate'
import type { MigrationManifest } from '../lib/design-migration/types'
import type { ValidationContext } from '../lib/design-index/types'

const REPO_ROOT = path.join(__dirname, '..')
const MANIFEST_PATH = path.join(REPO_ROOT, 'design', 'migration-manifest.json')
const INDEX_PATH = path.join(REPO_ROOT, 'design', 'figma-index.json')
const PENDING_PATH = path.join(REPO_ROOT, 'design', 'figma-index.pending.json')

function pathExists(glob: string): boolean {
  const firstStar = glob.indexOf('*')
  const staticPart = firstStar === -1 ? glob : glob.slice(0, firstStar)
  const cleaned = staticPart.replace(/\/+$/, '')
  if (!cleaned) return true
  return fs.existsSync(path.join(REPO_ROOT, cleaned))
}

function main() {
  let manifest: MigrationManifest
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as MigrationManifest
  } catch (err) {
    console.error(`✗ Could not read ${MANIFEST_PATH}:`, (err as Error).message)
    process.exit(1)
  }

  const { reconciled, pending } = manifestToIndexEntries(manifest)
  const index = toDesignIndex(reconciled)

  const ctx: ValidationContext = { pathExists, knownClickupIds: null }
  const errors = validateDesignIndex(index, ctx)
  if (errors.length > 0) {
    console.error(`✗ Reconciled set failed validation (${errors.length}) — writing nothing:`)
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }

  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n')
  fs.writeFileSync(
    PENDING_PATH,
    JSON.stringify({ version: 1, entries: pending }, null, 2) + '\n'
  )
  console.log(
    `✓ Seeded ${reconciled.length} reconciled → figma-index.json, ${pending.length} pending → figma-index.pending.json`
  )
}

main()
```

- [ ] **Step 4: Add the npm script**

In `package.json` `"scripts"`, add:

```json
    "figma:seed": "ts-node scripts/seed-index-from-manifest.ts"
```

- [ ] **Step 5: Verify it fails cleanly without a manifest**

Run: `npm run figma:seed`
Expected: FAIL exit 1 with "Could not read .../migration-manifest.json".

> Note: this script overwrites `design/figma-index.json`. The seed from
> subsystem #1 is example data; once a real manifest exists, this becomes the
> source of that file. Until then, do not run `figma:seed` without a manifest.

- [ ] **Step 6: Run the full migration suite + typecheck**

Run: `npx jest __tests__/lib/design-migration/ __tests__/scripts/`
Expected: PASS (all migration tests).

Run: `npm run typecheck`
Expected: PASS (exit 0).

- [ ] **Step 7: Commit**

```bash
git add scripts/seed-index-from-manifest.ts __tests__/scripts/seed-index-from-manifest.test.ts package.json
git commit -m "feat(migration): seed-index-from-manifest script (Phase 6)"
```

---

## Self-Review

**Spec coverage (against `2026-06-29-figma-migration-runbook-design.md`):**
- §4.1 three pure transforms → Tasks 3 (`inventoryToManifest`), 4 (`diffManifestVsInventory`), 5 (`manifestToIndexEntries`).
- §4.2 four thin scripts → Tasks 7 (inventory), 8 (manifest + verify), 9 (seed).
- §5 data shapes → Task 1 (types) + Task 6 (`toInventoryFile`).
- §6 inference rules (app/section/feature/codePaths/clickupId, legacy `shipped`, oversized) → Tasks 2, 3.
- §7 reconciled/pending split + validator gate → Tasks 5, 9.
- §9 error handling (429 backoff, 403/404 warn-not-fatal, seed aborts on invalid) → Tasks 7, 9.
- §10 testing (pure transforms, fixtures, reuse validateDesignIndex) → Tasks 2–6, 9.
- §12 open-question defaults (PAT auth, codePaths lookup) → Task 7 (`FIGMA_MIGRATION_TOKEN`), Task 2 (lookup table).

**Out of scope (operational, by design):** Phases 2–4 manual Figma scaffold/archive/moves (Claude emits checklists at run time), Phase 7 reconciliation backlog.

**Placeholder scan:** No "TBD"/"similar to Task N"/"handle edge cases". All code blocks complete; lookup tables hold real repo dirs (refined in Phase 1, per spec).

**Type consistency:** `FigmaInventory`/`FigmaInventoryFile`/`ManifestFile`/`MigrationManifest`/`PendingEntry`/`IndexSplit` from Task 1 used identically in Tasks 3–9. `featureIdFor` defined in Task 3, imported in Task 5. `toDesignIndex`/`manifestToIndexEntries` defined in Task 5, reused in Task 9. `toInventoryFile` defined in Task 6, used in Task 7. `validateDesignIndex` + `ValidationContext` signatures match subsystem #1.

# Design Index + Validation Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `design/figma-index.json` (the ClickUp-keyed map of features → Figma frames + code paths) plus a `validate-design-index` script and CI guard that fails the build on a stale/invalid index.

**Architecture:** A pure, dependency-free TypeScript validator (`lib/design-index/`) holds all rules and is fully unit-testable via injected I/O (path existence + known ClickUp IDs). A thin CLI script (`scripts/validate-design-index.ts`) wires real filesystem/ClickUp checks and process exit codes. A GitHub Action runs the script on every PR. The validator reuses `parseFigmaUrl` from `lib/figma/client.ts` so Figma URL parsing stays DRY.

**Tech Stack:** TypeScript, Jest (ts-jest, node project), ts-node (for the CLI), GitHub Actions. No new runtime dependencies.

**Scope note:** This is subsystem #1 of 5 from the approved spec (`docs/superpowers/specs/2026-06-29-figma-claude-design-pipeline-design.md`). The Figma reorganization (operational runbook), CURRENT PRODUCTION mirror, ClickUp webhook, and Foundations Code Connect are separate plans. This plan delivers working, testable software on its own.

---

## File Structure

- `lib/design-index/types.ts` — Type definitions for the index (`DesignIndex`, `Feature`, `UserStory`, `UserStoryStatus`). One responsibility: the shape contract.
- `lib/design-index/validate.ts` — Pure validation logic. Exports `validateDesignIndex(index, ctx)` returning `string[]` of human-readable errors. No `fs`, no network — all external facts injected via `ctx`. Reuses `parseFigmaUrl`.
- `scripts/validate-design-index.ts` — CLI entry. Loads the JSON, builds the real `pathExists` checker (filesystem) and optional ClickUp id set, calls the validator, prints errors, exits 0/1.
- `design/figma-index.json` — The index data file itself.
- `__tests__/lib/design-index/validate.test.ts` — Unit tests for the validator (node project; matches `__tests__/**/*.test.ts`).
- `.github/workflows/design-index-validate.yml` — CI: run the validator on every PR.
- `package.json` — add the `validate-design-index` script.

---

## Task 1: Index type definitions

**Files:**
- Create: `lib/design-index/types.ts`

- [ ] **Step 1: Write the types**

```ts
// lib/design-index/types.ts

export type AppKey = 'web' | 'cms' | 'mobile'

export type UserStoryStatus = 'in-design' | 'approved' | 'shipped' | 'archived'

/** A status that counts against the per-file anti-crash page cap. */
export const ACTIVE_STATUSES: ReadonlySet<UserStoryStatus> = new Set([
  'in-design',
  'approved',
])

/** Max ACTIVE user-story pages allowed per feature file (anti-crash rule, spec §5.3). */
export const MAX_ACTIVE_STORIES = 5

export interface UserStory {
  clickupId: string
  title: string
  status: UserStoryStatus
  figmaPageNodeId: string
  sourceOfTruthNodeId: string
  sandboxNodeId: string
  githubIssue?: number
  lastPr?: number
  previewUrl?: string
}

export interface Feature {
  id: string
  app: AppKey
  section: string
  feature: string
  figmaFileKey: string
  figmaFileUrl: string
  codePaths: string[]
  userStories: UserStory[]
}

export interface DesignIndex {
  version: number
  apps: Record<string, { figmaProject: string }>
  features: Feature[]
}

/** Injected facts the pure validator needs from the outside world. */
export interface ValidationContext {
  /** Returns true if a codePaths glob resolves to at least one real path. */
  pathExists: (glob: string) => boolean
  /** Known ClickUp ids; when null the ClickUp join-key check is skipped. */
  knownClickupIds: ReadonlySet<string> | null
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add lib/design-index/types.ts
git commit -m "feat(design-index): add index type definitions"
```

---

## Task 2: Pure validator — structural rules

**Files:**
- Create: `lib/design-index/validate.ts`
- Test: `__tests__/lib/design-index/validate.test.ts`

- [ ] **Step 1: Write the failing test (valid index passes, bad shape fails)**

```ts
// __tests__/lib/design-index/validate.test.ts
import { validateDesignIndex } from '@/lib/design-index/validate'
import type { DesignIndex, ValidationContext } from '@/lib/design-index/types'

const ctx: ValidationContext = { pathExists: () => true, knownClickupIds: null }

function baseIndex(): DesignIndex {
  return {
    version: 1,
    apps: { web: { figmaProject: '▣ WEB APP' } },
    features: [
      {
        id: 'settings-billing',
        app: 'web',
        section: 'Settings',
        feature: 'Billing',
        figmaFileKey: 'abc123',
        figmaFileUrl: 'https://figma.com/design/abc123/Settings-Billing',
        codePaths: ['app/sprint/**'],
        userStories: [
          {
            clickupId: 'US-1234',
            title: 'Default payment method',
            status: 'in-design',
            figmaPageNodeId: '1:234',
            sourceOfTruthNodeId: '1:235',
            sandboxNodeId: '1:236',
          },
        ],
      },
    ],
  }
}

describe('validateDesignIndex — structure', () => {
  it('returns no errors for a valid index', () => {
    expect(validateDesignIndex(baseIndex(), ctx)).toEqual([])
  })

  it('flags a non-numeric version', () => {
    const idx = baseIndex()
    // @ts-expect-error intentional bad value
    idx.version = 'one'
    const errors = validateDesignIndex(idx, ctx)
    expect(errors.some((e) => e.includes('version'))).toBe(true)
  })

  it('flags a feature whose app is not declared in apps', () => {
    const idx = baseIndex()
    idx.features[0].app = 'cms'
    const errors = validateDesignIndex(idx, ctx)
    expect(errors.some((e) => e.includes('cms'))).toBe(true)
  })

  it('flags an invalid user-story status', () => {
    const idx = baseIndex()
    // @ts-expect-error intentional bad value
    idx.features[0].userStories[0].status = 'wip'
    const errors = validateDesignIndex(idx, ctx)
    expect(errors.some((e) => e.includes('status'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/lib/design-index/validate.test.ts`
Expected: FAIL — "Cannot find module '@/lib/design-index/validate'".

- [ ] **Step 3: Write the validator (structural rules)**

```ts
// lib/design-index/validate.ts
import { parseFigmaUrl } from '@/lib/figma/client'
import {
  ACTIVE_STATUSES,
  MAX_ACTIVE_STORIES,
  type DesignIndex,
  type UserStoryStatus,
  type ValidationContext,
} from '@/lib/design-index/types'

const VALID_STATUSES: ReadonlySet<UserStoryStatus> = new Set([
  'in-design',
  'approved',
  'shipped',
  'archived',
])

const VALID_APPS = new Set(['web', 'cms', 'mobile'])

/**
 * Validates a design index. Pure: all external facts arrive via `ctx`.
 * Returns a list of human-readable error strings; empty means valid.
 */
export function validateDesignIndex(index: DesignIndex, ctx: ValidationContext): string[] {
  const errors: string[] = []

  if (typeof index.version !== 'number') {
    errors.push(`version must be a number (got ${typeof index.version})`)
  }
  if (!index.apps || typeof index.apps !== 'object') {
    errors.push('apps must be an object')
  }
  if (!Array.isArray(index.features)) {
    errors.push('features must be an array')
    return errors // nothing further to check
  }

  const declaredApps = new Set(Object.keys(index.apps ?? {}))

  for (const f of index.features) {
    const where = `feature "${f.id ?? '(missing id)'}"`

    if (!f.id) errors.push(`${where}: missing id`)
    if (!VALID_APPS.has(f.app)) errors.push(`${where}: app "${f.app}" is not a known app`)
    if (!declaredApps.has(f.app)) errors.push(`${where}: app "${f.app}" is not declared in apps`)
    if (!f.section) errors.push(`${where}: missing section`)
    if (!f.feature) errors.push(`${where}: missing feature`)

    // Figma URL ↔ fileKey parity (reuses lib/figma/client.ts).
    const parsed = f.figmaFileUrl ? parseFigmaUrl(f.figmaFileUrl) : null
    if (!parsed) {
      errors.push(`${where}: figmaFileUrl is not a parseable Figma URL`)
    } else if (parsed.fileKey !== f.figmaFileKey) {
      errors.push(
        `${where}: figmaFileKey "${f.figmaFileKey}" does not match key in figmaFileUrl "${parsed.fileKey}"`
      )
    }

    if (!Array.isArray(f.userStories)) {
      errors.push(`${where}: userStories must be an array`)
      continue
    }

    for (const s of f.userStories) {
      const sw = `${where} story "${s.clickupId ?? '(missing clickupId)'}"`
      if (!s.clickupId) errors.push(`${sw}: missing clickupId`)
      if (!s.title) errors.push(`${sw}: missing title`)
      if (!VALID_STATUSES.has(s.status)) errors.push(`${sw}: invalid status "${s.status}"`)
      if (!s.figmaPageNodeId) errors.push(`${sw}: missing figmaPageNodeId`)
      if (!s.sourceOfTruthNodeId) errors.push(`${sw}: missing sourceOfTruthNodeId`)
      if (!s.sandboxNodeId) errors.push(`${sw}: missing sandboxNodeId`)
    }
  }

  return errors
}

export { ACTIVE_STATUSES, MAX_ACTIVE_STORIES }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/lib/design-index/validate.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/design-index/validate.ts __tests__/lib/design-index/validate.test.ts
git commit -m "feat(design-index): pure structural validator"
```

---

## Task 3: Validator — anti-crash cap, uniqueness, paths, ClickUp join-key

**Files:**
- Modify: `lib/design-index/validate.ts`
- Test: `__tests__/lib/design-index/validate.test.ts`

- [ ] **Step 1: Add the failing tests**

Append these `describe` blocks to `__tests__/lib/design-index/validate.test.ts`:

```ts
describe('validateDesignIndex — rules', () => {
  it('flags more than MAX_ACTIVE_STORIES active pages in one file', () => {
    const idx = baseIndex()
    idx.features[0].userStories = Array.from({ length: 6 }, (_, i) => ({
      clickupId: `US-${i}`,
      title: `Story ${i}`,
      status: 'in-design' as const,
      figmaPageNodeId: `1:${i}0`,
      sourceOfTruthNodeId: `1:${i}1`,
      sandboxNodeId: `1:${i}2`,
    }))
    const errors = validateDesignIndex(idx, ctx)
    expect(errors.some((e) => e.includes('active'))).toBe(true)
  })

  it('does NOT count shipped/archived stories against the cap', () => {
    const idx = baseIndex()
    idx.features[0].userStories = Array.from({ length: 8 }, (_, i) => ({
      clickupId: `US-${i}`,
      title: `Story ${i}`,
      status: (i < 3 ? 'in-design' : 'shipped') as const,
      figmaPageNodeId: `1:${i}0`,
      sourceOfTruthNodeId: `1:${i}1`,
      sandboxNodeId: `1:${i}2`,
    }))
    expect(validateDesignIndex(idx, ctx)).toEqual([])
  })

  it('flags duplicate clickupId across features (join-key must be unique)', () => {
    const idx = baseIndex()
    idx.features.push({
      ...idx.features[0],
      id: 'settings-account',
      // same clickupId US-1234 reused — illegal
    })
    const errors = validateDesignIndex(idx, ctx)
    expect(errors.some((e) => e.includes('duplicate') && e.includes('US-1234'))).toBe(true)
  })

  it('flags duplicate feature ids', () => {
    const idx = baseIndex()
    idx.features.push({ ...idx.features[0], userStories: [] })
    const errors = validateDesignIndex(idx, ctx)
    expect(errors.some((e) => e.includes('duplicate feature id'))).toBe(true)
  })

  it('flags a codePaths glob that resolves to nothing', () => {
    const idx = baseIndex()
    idx.features[0].codePaths = ['app/does-not-exist/**']
    const errors = validateDesignIndex(idx, { pathExists: () => false, knownClickupIds: null })
    expect(errors.some((e) => e.includes('does-not-exist'))).toBe(true)
  })

  it('flags empty codePaths', () => {
    const idx = baseIndex()
    idx.features[0].codePaths = []
    const errors = validateDesignIndex(idx, ctx)
    expect(errors.some((e) => e.includes('codePaths'))).toBe(true)
  })

  it('flags a clickupId not in the known set when one is provided', () => {
    const idx = baseIndex()
    const errors = validateDesignIndex(idx, {
      pathExists: () => true,
      knownClickupIds: new Set(['US-9999']),
    })
    expect(errors.some((e) => e.includes('US-1234') && e.includes('ClickUp'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx jest __tests__/lib/design-index/validate.test.ts`
Expected: FAIL — the 7 new assertions fail (rules not implemented yet); the 4 from Task 2 still pass.

- [ ] **Step 3: Add the rules to the validator**

In `lib/design-index/validate.ts`, replace the `for (const f of index.features) {` loop body's **closing** and add cross-feature checks. Concretely, (a) add `codePaths` checks inside the per-feature loop, just after the Figma parity block:

```ts
    if (!Array.isArray(f.codePaths) || f.codePaths.length === 0) {
      errors.push(`${where}: codePaths must be a non-empty array`)
    } else {
      for (const glob of f.codePaths) {
        if (!ctx.pathExists(glob)) {
          errors.push(`${where}: codePaths entry "${glob}" resolves to no files`)
        }
      }
    }
```

(b) Add the active-cap check inside the per-feature loop, after the `for (const s of f.userStories)` loop:

```ts
    const activeCount = f.userStories.filter((s) => ACTIVE_STATUSES.has(s.status)).length
    if (activeCount > MAX_ACTIVE_STORIES) {
      errors.push(
        `${where}: ${activeCount} active user-story pages exceed the cap of ${MAX_ACTIVE_STORIES} (anti-crash rule)`
      )
    }
```

(c) Add cross-feature uniqueness + ClickUp checks just before `return errors`:

```ts
  // Cross-feature: unique feature ids and unique clickupIds (the join-key).
  const seenFeatureIds = new Set<string>()
  const seenClickupIds = new Set<string>()
  for (const f of index.features) {
    if (f.id) {
      if (seenFeatureIds.has(f.id)) errors.push(`duplicate feature id "${f.id}"`)
      seenFeatureIds.add(f.id)
    }
    for (const s of f.userStories ?? []) {
      if (!s.clickupId) continue
      if (seenClickupIds.has(s.clickupId)) {
        errors.push(`duplicate clickupId "${s.clickupId}" (join-key must be unique)`)
      }
      seenClickupIds.add(s.clickupId)
      if (ctx.knownClickupIds && !ctx.knownClickupIds.has(s.clickupId)) {
        errors.push(`clickupId "${s.clickupId}" not found in known ClickUp tasks`)
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx jest __tests__/lib/design-index/validate.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/design-index/validate.ts __tests__/lib/design-index/validate.test.ts
git commit -m "feat(design-index): cap, uniqueness, path & clickup-key rules"
```

---

## Task 4: CLI script + npm wiring

**Files:**
- Create: `scripts/validate-design-index.ts`
- Modify: `package.json:10` (scripts block)

- [ ] **Step 1: Write the CLI script**

```ts
// scripts/validate-design-index.ts
import * as fs from 'fs'
import * as path from 'path'
import { validateDesignIndex } from '../lib/design-index/validate'
import type { DesignIndex, ValidationContext } from '../lib/design-index/types'

const REPO_ROOT = path.join(__dirname, '..')
const INDEX_PATH = path.join(REPO_ROOT, 'design', 'figma-index.json')

/**
 * Dependency-free glob existence check. Reduces a glob to its static prefix
 * (everything before the first `*`) and asserts that prefix exists on disk.
 * Catches deleted dirs and typo'd paths — enough for an anti-rot guard.
 */
function pathExists(glob: string): boolean {
  const firstStar = glob.indexOf('*')
  const staticPart = firstStar === -1 ? glob : glob.slice(0, firstStar)
  // Trim a trailing partial segment / slash so "app/foo/**" → "app/foo".
  const cleaned = staticPart.replace(/\/+$/, '')
  if (!cleaned) return true // pattern like "**" — treat as repo root, always exists
  return fs.existsSync(path.join(REPO_ROOT, cleaned))
}

function loadIndex(): DesignIndex {
  const raw = fs.readFileSync(INDEX_PATH, 'utf8')
  return JSON.parse(raw) as DesignIndex
}

function main() {
  let index: DesignIndex
  try {
    index = loadIndex()
  } catch (err) {
    console.error(`✗ Could not read/parse ${INDEX_PATH}:`, (err as Error).message)
    process.exit(1)
  }

  // ClickUp check is opt-in: only enforced when a token-backed id set is present.
  // Kept null here so the guard runs in CI without secrets; the ClickUp webhook
  // subsystem (separate plan) will populate this.
  const ctx: ValidationContext = { pathExists, knownClickupIds: null }

  const errors = validateDesignIndex(index, ctx)
  if (errors.length > 0) {
    console.error(`✗ design/figma-index.json failed validation (${errors.length}):`)
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }

  console.log('✓ design/figma-index.json is valid.')
  process.exit(0)
}

main()
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add to the `"scripts"` block:

```json
    "validate-design-index": "ts-node scripts/validate-design-index.ts"
```

- [ ] **Step 3: Verify it runs and fails cleanly (no data file yet)**

Run: `npm run validate-design-index`
Expected: FAIL with exit 1 and "Could not read/parse .../design/figma-index.json" (the file is created in Task 5).

- [ ] **Step 4: Commit**

```bash
git add scripts/validate-design-index.ts package.json
git commit -m "feat(design-index): validate-design-index CLI + npm script"
```

---

## Task 5: Seed the index data file

**Files:**
- Create: `design/figma-index.json`

> The `figmaFileKey` / `figmaFileUrl` / `*NodeId` values below are internally
> consistent example values so validation passes today. Replace them with real
> values pulled from each Figma file's URL during the Figma migration plan
> (subsystem #2). `codePaths` already point at real directories in this repo.

- [ ] **Step 1: Write the seed index**

```json
{
  "version": 1,
  "apps": {
    "web": { "figmaProject": "▣ WEB APP" },
    "cms": { "figmaProject": "▣ CMS APP" },
    "mobile": { "figmaProject": "▣ MOBILE APP" }
  },
  "features": [
    {
      "id": "web-settings",
      "app": "web",
      "section": "Settings",
      "feature": "Account & Billing",
      "figmaFileKey": "EXMPLsettings01",
      "figmaFileUrl": "https://figma.com/design/EXMPLsettings01/Settings",
      "codePaths": ["app/setup/**", "lib/field-config.ts"],
      "userStories": [
        {
          "clickupId": "US-SETTINGS-001",
          "title": "Account settings landing",
          "status": "in-design",
          "figmaPageNodeId": "1:100",
          "sourceOfTruthNodeId": "1:101",
          "sandboxNodeId": "1:102"
        }
      ]
    },
    {
      "id": "web-performance-hub",
      "app": "web",
      "section": "Performance Hub",
      "feature": "Performance Hub",
      "figmaFileKey": "EXMPLperfhub001",
      "figmaFileUrl": "https://figma.com/design/EXMPLperfhub001/Performance-Hub",
      "codePaths": ["app/sprint/**"],
      "userStories": [
        {
          "clickupId": "US-PERF-001",
          "title": "Performance hub overview",
          "status": "in-design",
          "figmaPageNodeId": "2:200",
          "sourceOfTruthNodeId": "2:201",
          "sandboxNodeId": "2:202"
        }
      ]
    }
  ]
}
```

- [ ] **Step 2: Run the validator against real data**

Run: `npm run validate-design-index`
Expected: PASS — "✓ design/figma-index.json is valid."

- [ ] **Step 3: Run the full unit suite to confirm nothing regressed**

Run: `npx jest __tests__/lib/design-index/`
Expected: PASS (11 tests).

- [ ] **Step 4: Commit**

```bash
git add design/figma-index.json
git commit -m "feat(design-index): seed figma-index.json"
```

---

## Task 6: CI guard

**Files:**
- Create: `.github/workflows/design-index-validate.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: Design Index Validation

on:
  pull_request:
    branches: ['**']

jobs:
  validate-design-index:
    name: Validate design/figma-index.json
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Validate design index
        run: npm run validate-design-index
```

- [ ] **Step 2: Verify the command the CI runs works locally**

Run: `npm run validate-design-index`
Expected: PASS — "✓ design/figma-index.json is valid."

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/design-index-validate.yml
git commit -m "ci(design-index): validate figma-index.json on PRs"
```

---

## Self-Review

**Spec coverage (against the approved spec):**
- §6.2 machine-readable index → Tasks 1, 5 (types + seeded `design/figma-index.json`).
- §6.2 anti-rot CI guard (`npm run validate-design-index`) → Tasks 4, 6.
- §6.2 checks: schema conformance → Task 2; `codePaths` existence → Tasks 3/4; `clickupId` validity → Task 3 (rule) + Task 4 (wiring point, enforced once the ClickUp subsystem supplies ids).
- §5.3 ≤3–5 active pages cap → Task 3 (`MAX_ACTIVE_STORIES`).
- §11.2 centralized `design/figma-index.json` → Task 5.
- §11.3 `clickupId` as unique join-key → Task 3 (duplicate-id rule).
- Reuse of `lib/figma/client.ts` `parseFigmaUrl` → Task 2 (Figma URL parity).

Out of scope here (separate plans, by design): the Playwright mirror (§11.1), the ClickUp "In Progress" webhook that *writes* index entries (§11.3), Figma reorg/migration (§8), Foundations Code Connect (§6.3).

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". The example Figma keys in Task 5 are flagged as real-data-to-replace (external data, not code placeholders) and are internally consistent so validation passes now.

**Type consistency:** `validateDesignIndex(index, ctx)` signature and `ValidationContext` (`pathExists`, `knownClickupIds`) are identical across Tasks 2–4. `MAX_ACTIVE_STORIES`/`ACTIVE_STATUSES` defined once in `types.ts` and imported. `DesignIndex`/`Feature`/`UserStory` field names match between types, tests, validator, CLI, and the JSON seed.

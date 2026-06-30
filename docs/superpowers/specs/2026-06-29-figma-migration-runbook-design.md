# Figma Migration Runbook — Monolith → Zoned Project-per-App

**Date:** 2026-06-29
**Status:** APPROVED (2026-06-29) — ready for implementation planning
**Owner:** Michael Terry (PM)
**Designer/Developer:** Claude
**Parent spec:** `docs/superpowers/specs/2026-06-29-figma-claude-design-pipeline-design.md` (§8)

---

## 1. Context & Problem

The parent pipeline assumes a Figma workspace organized as **Project = App / File =
Feature**, with zones (`⬡ FOUNDATIONS`, `▣ PRODUCT UI`, `◇ FLOWS & PLANNING`,
`▢ ARCHIVE`) and a `clickupId`-keyed `design/figma-index.json` (subsystem #1, built).
The *actual* workspace is the legacy of a departed designer mid-reorg: a bloated,
browser-crashing 42-file `Viscap UI` monolith, a few already-extracted projects
(Creatives, Settings, Performance Hub, Ideation, ActorHub), plus non-UI clutter
(Flowcharts, Data Planning, User Story & Planning, Sales Process, Desktop).

This subsystem is the **tactical runbook + tooling** that moves the real workspace
into the target structure and seeds the index — without losing work, without
crashing files mid-move, and without forcing a demoralizing big-bang rewrite.

## 2. Goals

- Move the workspace to **Project = App / File = Feature** with the four zones.
- Seed `design/figma-index.json` with **reconciled** entries that pass the
  existing strict validator + CI guard.
- Capture every legacy artifact: nothing dropped, nothing deleted.
- Keep Michael's manual Figma work minimal (relocate/rename over re-draw) and
  resumable across sessions.

## 3. Non-Goals

- Automated canvas edits in Figma (out of scope project-wide — see parent spec).
  Phases 2–4 (project creation, file moves, splits) are **manual in the Figma UI**;
  Claude produces checklists, not canvas mutations.
- Migrating Mobile now (kept as-is) or reviving Desktop (archived).
- Building the ClickUp webhook (§11.3 — separate plan) or the CURRENT PRODUCTION
  mirror (§11.1 — separate plan).
- Reconciling every pending entry to real code during migration (Phase 7 is an
  ongoing backlog, not a migration gate).

## 4. Architecture

Same discipline as the validator subsystem: **pure, fixture-tested transform
functions** in `lib/design-migration/`, wrapped by **thin I/O scripts** in
`scripts/`. The Figma REST API is read-only here (inventory + verify only); all
canvas changes are manual. Reuses `parseFigmaUrl` and the Figma client patterns
from `lib/figma/client.ts`, and the index types from `lib/design-index/types.ts`.

### 4.1 The three pure transforms (unit-tested, no live API)

1. `inventoryToManifest(inventory)` → a proposed `MigrationManifest`: assigns
   zone/app/`Section — Feature`, infers `codePaths` + `clickupId`, sets
   `oversized` and `UNASSIGNED` flags.
2. `diffManifestVsInventory(manifest, freshInventory)` → drift report for Phase 5
   (what the manifest expects vs. what Figma now actually contains).
3. `manifestToIndexEntries(manifest)` → `{ reconciled: Feature[], pending: PendingEntry[] }`
   — the split that feeds the two index files.

### 4.2 The thin I/O scripts

- `scripts/figma-inventory.ts` — fetch projects/files/pages via Figma API →
  `design/figma-inventory.json`. Read-only, paginated, rate-limit aware.
- `scripts/build-migration-manifest.ts` — `inventoryToManifest` → `design/migration-manifest.json`.
- `scripts/verify-figma-migration.ts` — re-inventory + `diffManifestVsInventory` →
  drift report; exit non-zero on drift.
- `scripts/seed-index-from-manifest.ts` — `manifestToIndexEntries` →
  `design/figma-index.json` (reconciled) + `design/figma-index.pending.json`
  (pending); runs the existing validator on the reconciled output before writing.

## 5. Data Shapes

```ts
// lib/design-migration/types.ts
export interface FigmaInventoryFile {
  projectName: string
  fileKey: string
  fileName: string
  fileUrl: string
  pages: { nodeId: string; name: string }[]
  frameCount: number          // crash-risk signal
}
export interface FigmaInventory {
  fetchedAt: string
  files: FigmaInventoryFile[]
}

export type Zone = 'foundations' | 'product' | 'flows' | 'archive'

export interface ManifestPage {
  nodeId: string
  name: string
  clickupId: string           // "US-1234" inferred, or "PENDING-<featureId>-<n>"
  inferredFromPageName: boolean
}
export interface ManifestFile {
  sourceFileKey: string
  sourceFileUrl: string
  zone: Zone
  app: 'web' | 'cms' | 'mobile' | null   // null for non-product zones
  targetSection: string | null
  targetFeature: string | null           // → file name "<Section> — <Feature>"
  codePaths: string[]                     // inferred; [] when UNASSIGNED
  unassigned: boolean                     // could not map app/section/feature/code
  oversized: boolean                      // frameCount over split threshold
  pages: ManifestPage[]
}
export interface MigrationManifest {
  version: number
  builtAt: string
  files: ManifestFile[]
}

// Pending-index entry (mirrors Feature but tolerates placeholders).
export interface PendingEntry {
  featureId: string
  reason: ('placeholder-clickup' | 'unassigned-codepaths' | 'unassigned-feature')[]
  partial: Partial<import('../design-index/types').Feature>
}
```

`design/figma-index.pending.json` shape: `{ version, entries: PendingEntry[] }`.

## 6. Inference Rules (the `inventoryToManifest` heart)

- **App:** mapped from source project/file name via a small lookup
  (`Viscap UI`, `ActorHub`, `Performance Hub` … → `web`; CMS files → `cms`;
  `MVP Mobile App` → `mobile`). Unknown → `unassigned`.
- **Section / Feature:** parsed from file/page names (e.g. `Settings`, `Billing`).
  Unknown → `unassigned`.
- **`clickupId`:** if a page name matches `^US-\d+` use it (`inferredFromPageName:
  true`); else emit deterministic unique placeholder `PENDING-<featureId>-<n>`.
- **`codePaths`:** inferred from section/feature via a lookup against real repo
  dirs (e.g. Performance Hub → `app/sprint/**`). Unresolvable → `[]` + `unassigned`.
- **`oversized`:** `frameCount` over threshold (default 40; tunable) → flagged for
  Phase-4 split.
- **Legacy status:** every migrated story is seeded `status: "shipped"` (mirrors
  the live product) so it does **not** count against the ≤3–5 active-page cap
  (parent §5.3). Active caps bind new feature work, not the historical backfill.

## 7. The Reconciled / Pending Split (resolves the validator collision)

The built validator (`lib/design-index/validate.ts`) enforces unique `clickupId`
and existing `codePaths`. Placeholder values would fail both. Therefore
`manifestToIndexEntries` routes each file:

- **Reconciled** (real `clickupId` *and* resolvable `codePaths`, not `unassigned`)
  → `design/figma-index.json`. The seed script runs `validateDesignIndex` on this
  set and **aborts the write if it fails** — the strict index and CI stay green.
- **Pending** (any placeholder `clickupId`, empty `codePaths`, or `unassigned`)
  → `design/figma-index.pending.json`, which is **not** under the CI guard. No
  data is lost; Phase 7 burns this backlog down by supplying real values and
  re-running the seed (promotes entries across the split).

Uniqueness of placeholders (`PENDING-<featureId>-<n>`) is preserved so that
pending entries themselves never collide.

## 8. The Phased Runbook

| Phase | Driver | Output / Action | Reversible? |
|------|--------|-----------------|-------------|
| 0 · Inventory | Claude (auto, read-only) | `design/figma-inventory.json` | n/a |
| 1 · Mapping | Claude proposes → PM edits | `design/migration-manifest.json` (review/adjust assignments, flags) | edit file |
| 2 · Scaffold | PM (manual in Figma) | Create `▣ WEB/CMS/MOBILE`, `⬡ FOUNDATIONS`; zone-prefix-rename projects; create `◇ FLOWS & PLANNING`, `▢ ARCHIVE`. Claude supplies checklist. | yes |
| 3 · Archive originals | PM (manual) | Move `Viscap UI` monolith + `Desktop` into `▢ ARCHIVE` (frozen safety net; never deleted) | yes |
| 4 · Moves & shards | PM (manual, manifest-driven) | Per-file: move/rename to `<Section> — <Feature>`; split `oversized` via duplicate-and-prune. Batched per app, per-file checkoff. | yes (archive intact) |
| 5 · Verify | Claude (auto gate) | `verify-figma-migration.ts`: re-inventory + diff vs manifest; report drift; loop until clean | n/a |
| 6 · Seed index | Claude (auto) | `seed-index-from-manifest.ts` → `figma-index.json` (validated) + `figma-index.pending.json` | re-runnable |
| 7 · Reconciliation backlog | Ongoing | Supply real `clickupId`/`codePaths` to pending entries; re-seed to promote | re-runnable |

**Splitting technique (Phase 4):** to shard an `oversized` file F into F-a/F-b,
*duplicate* F, rename copies, and *delete the non-belonging pages from each copy*
— so a mistake only ever loses a duplicate, and the original still sits in
`▢ ARCHIVE` from Phase 3.

## 9. Safety, Idempotency, Error Handling

- **Read-only analysis.** Phases 0 and 5 only read Figma. Re-runnable any time.
- **One hand-edited artifact.** Only `migration-manifest.json` is edited by humans;
  inventory and index files are generated.
- **Nothing deleted.** Archive-and-verify; originals frozen in `▢ ARCHIVE`.
- **Figma API:** cursor pagination; exponential back-off on HTTP 429; per-file
  403/404 (token scope / deleted) recorded as warnings, not fatal — that file is
  marked `unassigned` and routed to pending.
- **Seeding gate:** reconciled set must pass `validateDesignIndex` or the script
  exits non-zero and writes nothing (no partial/ corrupt index).
- **`UNASSIGNED` isolation:** an unmapped file blocks seeding *only for itself*
  (it goes to pending); the rest of the index still seeds.

## 10. Testing

- **Pure transforms** (`inventoryToManifest`, `diffManifestVsInventory`,
  `manifestToIndexEntries`) — unit-tested with inventory/manifest fixtures
  capturing: clean map, `US-####` inference, placeholder generation + uniqueness,
  `oversized` flagging, `unassigned` routing, reconciled/pending split, drift
  detection. No live Figma API in tests (same rule as the validator suite).
- **Reuse** the existing `validateDesignIndex` to assert seeded reconciled output
  is valid within the seed-script test (via injected `pathExists`).
- Scripts themselves are thin enough to be smoke-checked manually against the real
  workspace during Phases 0/5/6.

## 11. Success Criteria

- No Figma file crashes the browser post-migration (all under the frame threshold
  or split).
- `design/figma-index.json` seeded and **passing `npm run validate-design-index`**.
- Every legacy file accounted for: present in a target zone **or** frozen in
  `▢ ARCHIVE`, and represented in either the index or the pending backlog.
- Phase 5 verify reports zero drift between manifest and the migrated workspace.
- Michael's manual effort is relocate/rename + a bounded set of `oversized` splits,
  resumable across sessions via per-file checkoff.

## 12. Open Questions (for implementation planning)

- Exact `frameCount` split threshold (default 40) — tune against the real
  inventory once Phase 0 runs.
- The app/section→`codePaths` lookup table contents (seeded from the current repo
  route map; refined during Phase 1 review).
- Whether `figma-inventory.ts` authenticates via the existing per-user Figma OAuth
  tokens (`oauth_tokens` table) or a dedicated migration PAT in env.

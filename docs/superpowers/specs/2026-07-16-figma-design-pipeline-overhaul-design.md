# Figma Design-Pipeline Overhaul — Design (Optimized)

**Date:** 2026-07-16
**Status:** Draft for review

## Problem

The Figma "Publish Stitch" flow produces layouts that (a) use a **generic nav in every screen**,
(b) **don't match the prototype**, and (c) create **files too heavy to load**. Root causes
(investigated 2026-07-16, not prompt issues):

1. The resolver ([lib/features/figma-layout.ts](../../../lib/features/figma-layout.ts)) only knows the
   generic **antd** catalog ([scripts/build-figma-catalog.ts](../../../scripts/build-figma-catalog.ts));
   the real Viscap design system (Figma file `L2WtMQ5D7np7KDJ2vm3Ly0` "Components": **Navbar** +
   `Menu Item / *` + 82 components) is **not imported**.
2. `reuse_refs` are **text hints only** ([lib/features/reuse-refs.ts](../../../lib/features/reuse-refs.ts)),
   never instantiated as components.
3. Prototype and figma-layout are **independent pipelines** that diverge.
4. Files bloat: components emitted as **copies** (not library instances), **too many workflows**
   per file, and the plugin **rename-archives** old pages in place so every republish grows the file.

## Core mechanics & workflow

- **The Sandbox File:** each ClickUp task gets its own dedicated Figma file.
  - *Constraint:* a Figma plugin **cannot create or duplicate files**. The sandbox file is created
    by duplicating a **template file** (pre-seeded with empty "Components Inspo" + "New Components"
    pages). The plugin only builds pages inside the already-open file.
- **The Component Inspo Page (sacred):** recycled, approved components pulled from other areas of
  the app. The plugin **never writes to or deletes from this page**.
- **The New Components Page:** a collector page in the task file. Brand-new UI elements created
  during the run land here and are **never overwritten**; after approval they graduate (manually /
  semi-automatically) into the master Viscap Team Library.
- **Double-library sourcing:** the resolver references two sources — **Viscap Media** (unique/custom
  elements) and **Ant Design** (standard utility UI).

## Principles

- **pm-app carries the weight; the plugin stays a thin builder.** Resolver, catalogs, Inspo
  indexing, workflow selection, and context assembly live in pm-app. The plugin only builds a
  resolved spec into the open file (plus the protected-page rules). The plugin engine work is
  **Phase 2** — after pm-app supports the new flow.
- **Instances, not copies.** Generated workflows reference the shared libraries; nothing is a copy.
- **Publish in file-sized chunks.** Distributing workflows across task files is a PM action (open
  the target file); the pipeline makes content lightweight and lets the PM publish one scoped
  workflow at a time.

## Workstreams

### A. Dual-library cataloging & page navigation *(pm-app)*

- **Dual sources, strict priority:**
  1. **Viscap Media Library** — high priority for custom elements (master Navigation Menu,
     specialized media players/cards).
  2. **Antd Team Library** — fallback for standard UI (inputs, modals, buttons).
  - Catalog script extended to a second source (the Components file, pulled **by file key** —
    verified: `/v1/files/L2WtMQ…/component_sets` is reachable with the existing token). Resolver
    prompt prefers Viscap where both exist.
- **Navigation anchoring:** the master `Navbar` is a **protected top-level constraint**. The
  **PM selects the active page** in the Design→Figma panel at payload generation; the selection is
  encoded in the payload, and the resolver **force-applies the matching "Active" state variant** to
  the Navbar / `Menu Item / *` instance (those sets already expose `active`/`collapsed`/`hover`).
- **Component-Inspo indexing:** during payload generation, pm-app **indexes the target file's
  "Components Inspo" page** and maps incoming canvas requirements against both remote catalogs
  **and** this local Inspo index, preserving relationships to already-recycled elements.
  - *Resolved:* the target file key is **derived from the ClickUp `figma_link` custom field**
    (or an existing `figma` reuse_ref) — no new input. pm-app parses the file key from that URL and
    reads its "Components Inspo" page via the Figma API before returning the payload.

### B. Plugin engine: replace-in-place & protected canvas *(Phase 2, plugin — kept mechanical)*

- **Replace-in-place** (promoted from deferred to a Phase-2 priority to kill memory bloat): on
  republish, **delete old workflow page frames**, with two strict exceptions:
  - **"Components Inspo"** — read-only for the plugin.
  - **"New Components"** — accumulator; never overwritten.
  - Protection is by **page name** against a hardcoded protected set.
- **Preserve CSS & code labels:** developers rely on the file for exact specs. The plugin outputs
  clean **Auto-Layout** structures with **preserved layer naming** (e.g. `[Antd: Button]`,
  `[Viscap: MediaCard]`) so class mappings don't drift into generic CSS. The resolver emits the
  label; the plugin applies it as the node name.
- **New-Components routing:** an element that maps to **neither** catalog is routed to the
  "New Components" page (instead of an inline placeholder) so net-new UI is preserved for graduation.
- The plugin gains **no new intelligence** — only build behavior + the protected-page rules.

### C. GitHub repository cross-referencing *(pm-app)*

- **Context assembly:** when the layout endpoint runs, pm-app queries the codebase's local schemas,
  design JSONs, and routing structures (it already reads repos via the GitHub token —
  [readRepoFile](../../../lib/github/design-index-pr.ts)).
- **Deduction (best-effort):** cross-reference the file link + ClickUp task against the app's UI
  directories to *suggest* where the layout hooks into the React/Next structure. This is LLM
  inference surfaced as context/hints, **not** deterministic mapping.

### D. Workflow-scoped payload & stateless generation *(pm-app)*

- **No Postgres `figma_layout` column, no manual migration.** Generate the payload **on-demand**.
- **Cache only if needed:** the resolve is a Gemini call and typically exceeds 10s, so back it with
  a short-TTL **Upstash Redis** cache keyed by `(featureId + stitch hash + reuse_refs hash)`; TTL
  expiry replaces explicit invalidation. (Redis/Upstash already in the stack.)
- **Scope selector:** the plugin interface lets the PM select a specific **workflow payload**,
  drafting only that scoped workflow to the active canvas. Selection is encoded in the payload;
  the endpoint returns only that workflow's pages.

## Revised sequencing

1. **Phase 1 — Dual catalog & Inspo indexing (pm-app):** connect Viscap Media + antd catalogs;
   write the indexing that parses the target file's "Components Inspo" page; Navbar active-state
   anchoring; workflow-scoped + stateless payload (Redis TTL if latency demands).
2. **Phase 2 — Protected plugin engine:** replace-in-place with hardcoded protection for
   "Components Inspo" and "New Components"; preserved CSS/layer-label output; New-Components routing.
3. **Phase 3 — Workspace scoping & task mapping:** connect the ClickUp task payload generator to
   the repo context so pm-app assembles code structure and outputs scoped workflow files.

## Decisions

- **File-key-up-front — RESOLVED:** derive the target file key from the ClickUp `figma_link` field
  (or an existing `figma` reuse_ref). No new input.
- **Navbar active-state source — RESOLVED:** the PM selects the active page in the Design→Figma
  panel at publish; encoded in the payload.

Still open (their phases, not Phase 1):
1. **Template file** for the sandbox: confirm task files are created by duplicating a template
   pre-seeded with the two sacred pages (plugin can't create files). Who owns the template?
2. **New-Components detection:** confirm "maps to neither catalog → New Components page" (vs. a
   confidence threshold / explicit PM tagging).

## Non-goals

- Plugin creating/switching Figma files (Figma API can't).
- A single merged prototype+Figma generator (possible later).
- Deterministic code-to-layout mapping (Workstream C is best-effort context, not a guarantee).

## Open questions

1. Does the plugin's Figma account have the Viscap Components + antd libraries **enabled** (required
   for `importComponentSetByKeyAsync` on real keys)?
2. Workflow-selector granularity: per-workflow only, or also per-screen/state?
3. Master-library **graduation**: how automated is "New Components → Viscap Team Library" (manual,
   or a later assisted flow)?

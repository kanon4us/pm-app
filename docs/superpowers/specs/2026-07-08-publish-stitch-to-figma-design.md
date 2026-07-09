# Publish Stitch → Figma (plugin + LLM layout resolver)

**Date:** 2026-07-08
**Status:** Design — pending approval
**Spec #2 of the Figma-as-design-substrate program** (Spec #1 = objectives→JSON + Gemini stitch, shipped in PR #36)

## Program context

The agreed end-state: Figma **Project = Application**, **File = Feature/Sub-feature**,
**Page = a Workflow or the Component Library**; a round-trip where Gemini/pm-app drafts
structural design into Figma, humans refine, Claude reads it back. Definition of done for
the whole program: **pm-app can read the master project's current state and design new
features in alignment with it.**

Spec #1 produces `features.ux_stitch` — a per-workflow structural plan (component
hierarchy, data-flow, mid-fi wireframe, no code). **Spec #2 gets that stitch onto the Figma
canvas as mid/high-fidelity frames built from the team's real Ant Design component
library** — this is the "Gemini/pm-app drafts into Figma" half of the round-trip.

### What research settled (verified, not assumed)

- **Fully-automated headless `pm-app → Figma` is not achievable.** Figma plugins cannot run
  in the background ("not possible to build plugins that run in the background"), and the
  Figma MCP's `use_figma` writes by executing Plugin-API JavaScript — which also needs a
  Plugin-API runtime. The write is inherently client-side/assisted.
- **The team library is the full antd-5 system, published** (REST `/v1/teams/{team}/component_sets`):
  100+ variant sets (Button, Input, Form, Select, DatePicker, Layout, Menu, Drawer, Steps,
  Card, Table-family, …) in library file `DpIOFPBpzpVVmZyZvzPJS4`. Matches the app's antd-5
  idiom.
- **The core mechanic is validated.** A throwaway dev plugin confirmed
  `importComponentSetByKeyAsync(<team-library key>)` → `.defaultVariant.createInstance()` →
  auto-layout produces **real library instances**. The plugin-as-renderer plan is sound.
- Michael is **owner + Full seat** (a Full seat is required to write to Figma with agents).

### Chosen architecture: plugin as a dumb renderer, judgment upstream

```
ux_stitch + reuse_refs + antd library catalog
      │  pm-app RESOLVER (LLM — the design judgment lives here)
      ▼
  Figma layout spec  =  component KEYS + auto-layout tree  ──►  GET /api/features/[id]/figma-layout
      │                                                             ▲ fetch (token auth)
      ▼                                                             │
  Figma PLUGIN (deterministic)  ── importComponentSetByKeyAsync → instantiate → auto-layout
      │  builds: "Components" page + one "Workflow: <name>" page each
      ▼
  designer refines → plugin POSTs figma.fileKey back → features.figma_file_key  (→ Spec #3)
```

The LLM does the "pick the right component" judgment **once, upstream**, and emits a fully
resolved layout spec; the plugin executes that spec deterministically. This keeps the AI
work where pm-app already has the infra, the library catalog, and the reuse references, and
keeps the plugin small, testable, and reproducible.

## Goal

Given an approved feature with a `ux_stitch`, let the PM (1) curate which existing
components to recycle, and (2) run a one-click Figma plugin that renders the workflows as
mid/high-fidelity frames composed from **real antd library instances**, into the feature's
Figma file, and links that file back to pm-app.

## Non-goals (Spec #2)

- No headless/automated push (established impossible; the plugin is human-triggered).
- No org-published plugin — v1 is a **local dev plugin** for the single publisher (Michael).
  Org publish is deferred until other designers need it.
- No generation of the **master component library from the repo** — that is its own later
  sub-spec (the canonical reuse source + the components-half of the master mirror). Spec #2
  reuses whatever is already in the team library, and *records gaps*.
- No read-back (that is Spec #3); Spec #2 only establishes the `figma_file_key` linkage it
  will need.

## Data model & migration

**Migration `037_feature_figma_publish.sql`** (manual prod apply per convention; additive):

```sql
alter table features add column if not exists reuse_refs     jsonb;   -- PM-curated reuse list
alter table features add column if not exists figma_file_key text;    -- linkage for Spec #3
```

- `reuse_refs`: `{ refs: [{ kind: 'figma'|'code'|'screenshot', value, note }] }`
  (`value` = a Figma node URL, a repo path, or a stored screenshot reference).
- Update `lib/supabase/types.ts` for both columns.

## Component A — antd library catalog

**Location:** `lib/figma/component-catalog.ts` + a generated `design/figma-antd-catalog.json`.

Only the **resolver** needs the name→key map (the plugin receives already-resolved keys in
the layout spec, so it never touches the catalog). Generate it once (and refresh on demand)
from the Figma REST API already in use:

- A script `scripts/build-figma-catalog.ts` pages `/v1/teams/{FIGMA_TEAM_ID}/component_sets`
  (and `/components`) for names + keys, **and reads each component set's real variant
  property definitions** — from the set node's `componentPropertyDefinitions` (type
  `VARIANT` → `variantOptions`) via `/v1/files/{libraryFileKey}/nodes?ids=…` — so the
  catalog records the *exact* Figma variant strings, not guessed ones. Output
  `design/figma-antd-catalog.json`:
  `{ generatedAt, libraryFileKey, components: [{ name, key, type: 'set'|'component', variants?: { <propName>: [<option>, …] } }] }`.
- `getComponentCatalog()` loads that JSON (bundled via `outputFileTracingIncludes`, like the
  DESIGN.md contracts).
- (The antd Figma library is confirmed ~1:1 with the codebase props, so variant *names*
  will read familiarly to the LLM — but the resolver is still bound to the catalog's exact
  strings below, never to convention.)
- Committed to the repo so builds are deterministic; re-run the script when the library
  changes. (Icons are excluded/flagged — the antd icon set is ~hundreds of entries and not
  useful to the resolver.)

## Component B — reuse references

**UI:** a "Reuse references" panel in the Feature Editor where the PM adds entries — a Figma
link, a repo path, or a pasted screenshot — each with a one-line note. Persisted to
`features.reuse_refs`. This is a durable, feature-scoped list (curate once, feeds every
resolve/regenerate). Alongside it, a **"Copy Publish Payload"** button copies
`{ featureId, token, baseUrl }` to the clipboard for pasting into the Figma plugin — closing
the web→Figma gap without the PM hand-copying an id.

**Resolution:** `lib/features/reuse-refs.ts` `resolveReuseRefs(feature)` turns each ref into
a compact representation for the LLM, using pipelines pm-app already has:
- `figma` → node name + screenshot URL + key styles (via the existing `view_figma` /
  `get_figma_styles` read path).
- `code` → the component source (via `readRepoFile` against the app's repo).
- `screenshot` → the stored image reference.

Resolved reuse context feeds **both** `generateUxStitch` (so the stitch marks components as
`reuseOf`) and the layout resolver (so the plugin instantiates the recycled component).

> Note: reusing a bespoke component that lives in another *unpublished* Figma file can't be
> instantiated by key. Until the master component library exists, such a ref resolves as
> "recreate faithfully from screenshot/styles, and flag it as a gap to publish." Reuse of a
> **published library** component resolves to a real instance.

## Component C — the layout resolver (LLM)

**Location:** `lib/features/figma-layout.ts` `resolveFigmaLayout(featureId): Promise<FigmaLayoutSpec | null>`.

Inputs: `ux_stitch`, resolved `reuse_refs`, and the antd catalog (name→key).
Output: a **fully resolved, deterministic layout spec** — no abstract names, only real
component keys and concrete auto-layout.

Model: **Gemini 2.5 Pro**, JSON mode with a `Type`-built `responseSchema` (same pattern as
`generateUxStitch`; the large catalog fits Gemini's context). Reuses the isolation and
**write-only-on-success / never-throw** discipline from Spec #1's `ux-architect.ts`.

**Layout spec schema (resolver output = plugin input):**

```jsonc
{
  "pages": [
    {
      "name": "Components",                    // the feature's component library page
      "nodes": [ /* one entry per component the resolver chose, with its key + a label */ ]
    },
    {
      "name": "Workflow: <workflow name>",     // one page per stitch workflow
      "nodes": [ /* the screen frames for this workflow */ ]
    }
  ]
}
```

A `node` is one of a small, closed set the plugin knows how to build:

```jsonc
// a real library instance
{ "type": "instance", "componentKey": "7747670f…", "name": "Primary action", "variant": { "Type": "primary" } }
// an auto-layout container
{ "type": "frame", "name": "Filter bar", "layout": "HORIZONTAL", "spacing": 8,
  "padding": 12, "children": [ /* nodes */ ] }
// literal text (labels, headings, mock copy)
{ "type": "text", "characters": "Candidates", "style": "heading" }
// a reuse target that isn't a published key yet — plugin renders a labeled placeholder
{ "type": "placeholder", "name": "TalentCard (recreate — not in library)", "note": "reuseOf code: components/Admin/Talent/TalentCard.tsx" }
```

The resolver's system prompt: *given the stitch and the catalog, choose the closest real
antd component for each region; compose them with auto-layout to match the stitch's screen
structure; prefer a `reuseOf` component when the stitch marks one; emit `placeholder` only
when nothing in the catalog fits and no key is available; use only keys present in the
catalog, and set `variant` only using the exact property names/options listed for that key;
apply a **baseline spacing scale** to every auto-layout frame so the mid-fi output breathes
out of the box — padding 16–24, gaps 8/16/24, consistent with the DESIGN contract's tokens —
rather than tight, hand-detangle-required spacing.*

**Post-generation validation (deterministic, in code — never trust the LLM's strings):**
- Every `componentKey` must exist in the catalog → unknown keys downgraded to `placeholder`.
- Every `variant` entry must match the catalog's `variants` for that key **exactly** (prop
  name + option value) → unknown/misspelled variant props or options are **stripped** (the
  plugin then instantiates the default variant) rather than passed through to fail silently
  in `setProperties`.

This keeps variant selection from being a source of silent fallbacks — the risk being that
Figma variant properties are strict typed strings and a near-miss (`Type=Primary` vs
`type=primary`) resolves to the default with no error.

## Component D — the endpoint

`GET /api/features/[id]/figma-layout` → runs/returns `resolveFigmaLayout` as the layout spec
JSON. `POST /api/features/[id]/figma-file` → stores `figma_file_key` (called by the plugin
after it publishes).

**Auth (the plugin is external, no session cookie):** both routes accept a bearer
`FIGMA_PLUGIN_TOKEN` (env, mirrors the existing `CRON_SECRET`/`FEEDBACK_TOKEN_SECRET`
pattern). The token reaches the plugin via the pasted publish payload (Component E), not
persistent storage. These routes are added to `proxy.ts` PUBLIC_PATHS (token-gated, not
session-gated — same care as the cron routes).

## Component E — the plugin

**Location:** `figma-plugin/` in the pm-app repo (its own `manifest.json` + `tsconfig` +
esbuild; imported into Figma as a **development** plugin — not org-published in v1).

Behavior:
1. Small UI: a **single textarea** to paste a **publish payload** — `{ featureId, token,
   baseUrl }` — copied from the Feature Editor's "Copy Publish Payload" button (Component B).
   No persistent `clientStorage` token management for v1: paste-per-run keeps auth state
   trivial. A **Publish** button.
2. On Publish: `fetch` `GET {baseUrl}/api/features/{featureId}/figma-layout` with the token.
3. Walk the layout spec deterministically:
   - `instance` → `importComponentSetByKeyAsync(key)` (cache imports per key), apply only
     catalog-valid `variant` props via `setProperties` (already validated upstream), else
     the default variant; `createInstance()`.
   - `frame` → `figma.createFrame()` with auto-layout props, recurse children.
   - `text` → `figma.createText()`; **load the font in a try/catch and fall back to a
     guaranteed-available font (`Inter`) if `loadFontAsync` throws** — the app font
     (Montserrat) may not be present in every designer's Figma environment, and an
     unavailable font otherwise throws a *fatal* error that halts the whole publish. The
     fallback keeps the layout building; the summary notes any font substitution.
   - `placeholder` → a labeled dashed frame so gaps are visible.
   - **Non-destructive pages:** for each spec page, if a page of that name already exists,
     **rename it `<name> (Archived <timestamp>)`** and build the new content on a *fresh*
     page — never `remove()` existing content, so a designer's manual refinement is never
     silently destroyed. If existing target pages are found, the plugin first shows a
     confirm: *"N page(s) will be archived and rebuilt. Continue?"*
   - **Yield to the UI thread** every ~20 nodes (`await new Promise(r => setTimeout(r, 0))`)
     so large workflow trees build progressively instead of freezing/crashing Figma.
4. `POST {baseUrl}/api/features/{featureId}/figma-file` with `figma.fileKey` to store the
   linkage.
5. `figma.notify` a summary (pages built, instances placed, placeholders/gaps, pages archived).

`manifest.json` declares `networkAccess.allowedDomains` = the pm-app origin.

**Manual step (by design):** the PM creates/opens the feature's Figma file in the correct
Application *project* first (sidesteps `create_new_file`'s drafts-only limitation); the
plugin only builds pages *into the open file*.

## Idempotency & error handling

- **Resolver:** write-only-on-success; Gemini failure / invalid JSON / unknown-key overflow
  → the endpoint returns a clear error, no partial spec. Never throws into the route.
- **Plugin re-publish is non-destructive:** an existing target page is **archived**
  (renamed `… (Archived <ts>)`), never wiped — designer refinements are preserved, and the
  plugin confirms before archiving. A failed import of one key degrades that node to a
  placeholder and continues (one bad component never aborts the whole publish); the summary
  lists failures and archived pages.
- **Endpoint auth:** missing/lower `FIGMA_PLUGIN_TOKEN` → 401.

## Testing

- **Catalog (unit):** `getComponentCatalog()` parses the generated JSON; name→key lookups
  resolve; icons excluded.
- **Reuse resolution (unit):** each `kind` resolves via the right pipeline; mocked read
  tools; malformed refs skipped, not thrown.
- **Layout resolver (unit):** mock Gemini; assert the prompt includes the stitch + catalog +
  reuse context; assert every `componentKey` in the output exists in the catalog (unknown →
  `placeholder`); assert **variant validation** — a `variant` whose prop/option isn't in the
  catalog for that key is stripped (falls back to default), a valid one is kept; assert
  write-only-on-success (invalid JSON → error, no partial return).
- **Endpoint (route):** token auth (200 with token, 401 without); `POST figma-file` persists
  the key.
- **Plugin:** the layout-spec-walker is factored into a pure module tested outside Figma with
  a fake Figma API — assert it calls `importComponentSetByKeyAsync` for each `instance`,
  builds frames/auto-layout, renders `placeholder` for gaps, **archives (renames) an
  existing same-named page instead of removing content**, and **yields** (the fake records
  interleaved yields on large trees). The thin Figma-API shell is validated manually (the
  throwaway plugin already proved the core mechanic).
- Full pm-app `jest` green before PR.

## Ops / deploy

1. Apply migration `037` to prod **before** deploying code that reads/writes the columns.
2. Set `FIGMA_PLUGIN_TOKEN` in Vercel Production. **Treat it as a rotatable secret:** it
   rides in a copy-pasteable publish payload, so it can leak (pasted into Slack/Jira/a repo).
   Blast radius is limited — it only grants the two `/api/features/[id]/figma-*` routes — and
   rotation is a one-liner: change the env var + redeploy (same as `CRON_SECRET`). Don't log
   the payload.
3. Generate + commit `design/figma-antd-catalog.json`.
4. `GEMINI_API_KEY` already set (Spec #1).
5. The plugin is imported into Figma as a dev plugin (Plugins → Development → Import from
   manifest) — no store submission in v1.

## Build sequence (the spec splits cleanly into two plans)

**Plan 1 — pm-app side (testable with fixtures, no Figma needed):** migration 037; catalog
generator + loader; reuse-refs storage + UI + resolution; the layout resolver; the two
endpoints + token auth + PUBLIC_PATHS. Ships a working `GET /figma-layout` you can curl.

**Plan 2 — the plugin (consumes the real endpoint):** `figma-plugin/` scaffold; the
pure layout-spec walker + tests; the Figma-API shell; publish + writeback; manual end-to-end
with a real feature.

Doing Plan 1 first means the plugin is built against a real, inspectable layout spec instead
of a guessed one — the same validate-cheap-first discipline that has paid off throughout.

## Deferred to later specs

- **Master component library from the repo** → published to the team library (the canonical
  reuse source; components-half of the master mirror). Makes bespoke reuse resolve to real
  instances instead of placeholders.
- **Spec #3:** Claude reads the per-feature file back (via `figma_file_key`) for the polish
  step.
- **Spec #4:** master per-app page-for-page mirror.
- Org-publishing the plugin (when other designers need one-click publish).
- **Catalog pre-filtering** before the resolver call — v1 passes the whole ~100-set catalog
  (small against Gemini's window, and pre-filtering risks stripping a component the design
  needs). If adherence proves weak, a stitch-driven relevance filter is the documented v2
  lever.

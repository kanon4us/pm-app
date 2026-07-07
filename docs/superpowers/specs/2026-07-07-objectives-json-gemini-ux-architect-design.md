# Objectives → Strict JSON + Gemini "UX Architect" Stitch

**Date:** 2026-07-07
**Status:** Design — approved for planning
**Spec #1 of the Figma-as-design-substrate program** (see "Program context" below)

## Program context

This is the first sub-project of a larger reorganization of how Claude acts as UI/UX
designer, built around a restructured Figma. The agreed end-state Figma hierarchy is:

| Figma level | Meaning | pm-app concept |
|---|---|---|
| **Project** | an Application | `AppSlug` / `APP_REGISTRY` (web, cms, mobile, desktop) |
| **File** | a Feature or Sub-feature | a `features` row |
| **Page (canvas)** | a unique **Workflow**, or the **Component Library** | user-stories→scenarios→steps + the feature's components |
| *(special)* | **Master project** = page-for-page mirror of the live app | north-star read-reference |

The chosen data-flow is a **round-trip**: Gemini drafts structural flows, humans refine
them in Figma, Claude reads them back to polish. **Definition of done for the whole
program:** pm-app can read the master project's current state and design new features in
alignment with it.

The program decomposes into four sequenced specs; this doc is **Spec #1 only**:

1. **Objectives → strict JSON + Gemini "UX Architect" stitch** ← *this spec* (no Figma write path; delivers value today)
2. Publish stitch → Figma (MCP OAuth write path; establishes `features.figma_file_key`)
3. Claude reads the per-feature Figma file back for the polish step
4. Master per-app mirror generated from the repo screen-map + `DESIGN.md` (north-star)

Spec #1 is deliberately **Figma-independent**. Its output (the structural stitch) is the
exact object Spec #2 will later publish to Figma, so nothing here is throwaway.

## Goal

Two problems, one spec:

1. **`features.objectives` is null in practice.** The old `extractObjectives` reads a
   ClickUp field named `Objectives` expecting a string, but that field is a `labels`
   (multi-select) type whose value is an array of option-ids — so it always bails, then
   the description-scrape fallback finds nothing. The real objective data lives in the
   `Obj #1…#7` / `Obj #N Notes` fields. Rework extraction to map those into a strict JSON
   schema.

2. **Claude prototypes from prose, not structure.** Inject a Gemini pre-processing step
   ("UX Architect") that turns the objectives JSON + the planning tree into a structural
   **stitch** — component hierarchy, data-flow, and a mid-fi wireframe *per workflow*, with
   **no code** — which is then fed into Claude's prototyping context so the "Polisher"
   renders from an explicit plan.

## Non-goals (Spec #1)

- No writing to Figma (that is Spec #2). The stitch lands in `features.ux_stitch` and is
  injected into the prompt only.
- No change to the FVI/prioritization pipeline. Scores, `ObjTotal`, `Approved`, `FVI`,
  `Cost`, `Effort-M`, `Risk-M` are prioritization signal and are **dropped** from what
  feeds the UX step.
- No change to how the master mirror or per-feature Figma files are created.

## The ClickUp objective data model (verified against 200 live tasks)

Every task in the workspace carries an FVI objective block:

- **`Obj #1`…`Obj #7`** `[number]` — the feature's score against each of 7 fixed
  strategic objectives. Scores can be **negative or decimal** (e.g. `-3`, `1.4`).
- **`Obj #1…#7 Notes`** `[text]` — free-text rationale for each score. **This is the
  design-relevant content** — it states *how* the feature serves (or fights) each objective.
- **`Obj #1…#7 Approved`** `[checkbox]`, **`ObjTotal`** `[formula]` (= sum of the seven) —
  prioritization only; dropped.
- **`Objectives`** `[labels]` — a multi-select whose 7 options *define the objective names
  and their order* (`orderindex` 0–6). **Empty/undefined on real tasks** — nobody selects
  in it; its only role is naming.

**Verified mapping:** `Obj #N` corresponds positionally to the `Objectives` label at
`orderindex N-1`. Reading three populated tasks, the notes line up name-for-name:

| Field | Notes are always about | Label (orderindex) |
|---|---|---|
| Obj #1 | data hygiene, "source of truth", analytics | Data Backed Decisions (0) |
| Obj #2 | "invisible modularity", full automation | Modular Content Creation… (1) |
| Obj #3 | "workflow-breaking / workflow revolution" | User Success (2) |
| Obj #4 | "first 5 minutes", new-user UX | Optimized Onboarding (3) |
| Obj #5 | third-party / Premiere / Gen-AI tools | Third Party Integrations (4) |
| Obj #6 | "silent failure", "stability debt", testing | Quality Control (5) |
| Obj #7 | scoping, "proven profit", roadmap | Planning (6) |

The objective **names are read from the field's `type_config.options` by `orderindex`**
(not hardcoded), so a label rename in ClickUp tracks automatically. The positional
mapping is the contract; if the workspace ever starts *populating* the `Objectives`
multi-select to drive a non-positional mapping, that is a future change, out of scope here.

## Module A — Objectives → strict JSON

**Location:** `lib/features/gatekeeper-extract.ts` (pure, side-effect-free, unit-tested —
consistent with the rest of that file).

**When:** at gatekeeper/extract time (`activateFeatureFromTask`), where the ClickUp custom
fields are already in hand. No new ClickUp calls.

**New function** replacing the current `extractObjectives`:

```ts
export interface FeatureObjective {
  index: number      // 1..7
  name: string       // from Objectives label at orderindex (index-1); '' if unavailable
  notes: string      // Obj #N Notes, trimmed
}
export interface ObjectivesJson {
  objectives: FeatureObjective[]   // only entries with non-empty notes
}

export function extractObjectivesJson(
  fields: ClickUpCustomField[] | undefined
): ObjectivesJson | null
```

Rules:

- Build a `orderindex → label` map from the `Objectives` field's `type_config.options`.
  (Extend `ClickUpCustomField` to carry optional `type` / `type_config`.)
- For `N` in 1..7: read `Obj #N Notes`; if non-empty, emit `{ index: N, name: labels[N-1] ?? '', notes }`.
  **Scores are ignored** (per non-goals).
- Return `null` if no objective has notes (so the column stays null rather than `{objectives: []}`).
- The old signature took `(fields, description)`; the description-scrape fallback is
  **removed** — it never produced usable data and added ambiguity.

**Caller change** (`lib/features/gatekeeper.ts`): populate the new `objectives_json`
column from `extractObjectivesJson(fields)`. The legacy `objectives text` column is left
in place but no longer written by the gatekeeper (see Data model).

## Module B — Gemini "UX Architect" stitch

**Location:** new `lib/features/ux-architect.ts` — the only file that talks to Gemini,
keeping the dependency isolated and mockable.

**Inputs** (assembled server-side):

1. `objectives_json` (Module A output) — objective names + notes.
2. The **planning tree** — user stories → scenarios → steps, from the existing
   `buildFeatureContext` machinery (this is why Module B runs *after* planning; see
   Orchestration). "The workflows must be represented," so the tree is a first-class input.
3. The app's design contract — `getDesignContract(feature.app)` (`DESIGN-<slug>.md`).

**Output — the structural stitch (JSON, no code), organized by workflow:**

```jsonc
{
  "summary": "one-paragraph UX intent tying objectives to the flows",
  "components": [                         // the feature's component library
    { "name": "…", "purpose": "…", "props": ["…"] }
  ],
  "workflows": [                          // one entry per UNIQUE workflow
    {
      "name": "…",
      "userStories": ["…"],              // which stories this workflow satisfies
      "screens": [                        // the mid-fi wireframe, structural only
        { "name": "…", "layout": "…", "regions": [ { "role": "…", "components": ["…"], "data": "…" } ] }
      ],
      "dataFlow": [ { "trigger": "…", "reads": ["…"], "writes": ["…"], "result": "…" } ]
    }
  ]
}
```

The stitch is **structure, not pixels**: layout intent, component composition, and data
movement per workflow — deliberately shaped to become Figma **workflow pages** +
**component library page** in Spec #2.

**Gemini wiring:**

- Direct `@google/genai` SDK (matches our "call the provider SDK directly" pattern — we
  use the Anthropic SDK directly, not the AI SDK).
- `GEMINI_API_KEY` env (add to Vercel Production).
- Model: **Gemini 2.5 Pro** in JSON mode with a strict `responseSchema`. **The JSON block
  above is the illustrative *output shape*, not the schema literal** — `@google/genai`
  does not accept a raw JSON-Schema object; the schema must be constructed with the SDK's
  own `Type`/`Schema` types (an OpenAPI-3.0 subset) to guarantee JSON-mode enforcement,
  e.g. `{ type: Type.OBJECT, properties: { summary: { type: Type.STRING }, … } }`. Confirm
  the current model id / SDK entry-point at implementation.
- Config: pass **`responseMimeType: "application/json"`** alongside the `responseSchema`
  to enforce JSON at the API level, and set **`maxOutputTokens`** explicitly.
- **Output-ceiling guard:** Gemini's input window easily holds the planning tree +
  `DESIGN.md`, but the *output* is capped; an exceptionally large feature (many complex
  workflows) can truncate the JSON mid-stream → invalid parse. Mitigate by instructing the
  model to keep structural descriptions **concise** (structure, not prose), and rely on the
  no-write-on-failure rule (Error handling) so a truncated response degrades safely rather
  than persisting garbage. Respect the model revision's output-token ceiling; don't assume
  a fixed number.
- System prompt casts Gemini as a **UX Architect**: produce a mid-fi structural plan that
  advances the objectives via the given workflows; **never emit code**; represent every
  workflow; respect the design contract's information architecture; keep descriptions terse.

## Data model & migration

**Migration `036_feature_ux_architecture.sql`** (next sequential; **manual prod apply per
convention**, before any code that reads *or writes* the columns is deployed — the
gatekeeper writes `objectives_json`):

```sql
alter table features add column objectives_json jsonb;   -- Module A structured output
alter table features add column ux_stitch       jsonb;   -- Module B stitch
```

- We **add** columns rather than mutate `objectives text` — 200 live rows carry data and
  other code paths read it; a type change is riskier than an additive one.
- `buildFeatureContext` renders the **objectives block from `objectives_json`** when
  present (name + notes per objective), falling back to the legacy `objectives text` only
  if `objectives_json` is null. It renders a compact **"UX Structural Plan"** block from
  `ux_stitch` when present.
- Update `lib/supabase/types.ts` for both columns.

## Orchestration & flow

Module B fires **eagerly when the PM approves the spec** — the natural human gate, one
Gemini call, a deterministic and inspectable artifact.

```
ClickUp task flagged
      │  (existing gatekeeper)
      ▼
activateFeatureFromTask ──► objectives_json  [Module A, extract time]
      │
      ▼  PM runs planning (existing chat loop): user stories → scenarios → steps
      │
      ▼  PM clicks "Approve spec"
PATCH /api/features/[id]  planning_phase: planning → approved
      │  on THIS transition only:
      ▼
generateUxStitch(featureId) ──► ux_stitch     [Module B, Gemini]
      │
      ▼  prototyping chat loop
buildFeatureContext injects objectives_json + ux_stitch
      ▼
Claude "Polisher" renders the HTML prototype from an explicit structural plan
```

**Hook point:** in `PATCH app/api/features/[id]/route.ts`, fire only on the real
`planning → approved` edge. The handler today goes straight to `updateFeature` without
reading the prior value, so the plan must **fetch the current `planning_phase` before the
update** and compare, otherwise a no-op re-PATCH of an already-`approved` feature would
regenerate needlessly.

**Background execution — the serverless freeze trap.** Gemini is a multi-second call; you
**cannot** fire-and-forget a floating promise and return the response, because Vercel
freezes the function the instant the HTTP response is sent and the pending work is killed
mid-flight. Use the framework-native **`after()` from `next/server`** — already the
established pattern in this repo (`app/api/webhooks/slack/route.ts`) — to run
`generateUxStitch(featureId)` after the response is sent while keeping the lambda warm (on
Vercel `after()` is backed by `waitUntil`). Two consequences to bake into the plan:

- `after()` work counts against the route's `maxDuration`; set `export const maxDuration`
  (~120s) on this route so a slow Gemini call isn't truncated.
- The phase-transition write commits and returns **before** generation runs; generation
  failures are logged (`[ux-architect] …`), never thrown — the transition succeeds
  regardless.

*Chosen for Spec #1: `after()`.* This fires on a human gate (not a hot path), and the
degrade-to-null path already covers Gemini failure. **QStash is the documented upgrade**
if Gemini timeout-retries become painful: publish to a `feature-ux-stitch` topic and let a
dedicated consumer route write `ux_stitch` (note: its at-least-once delivery would need
the same in-flight guard as below). Spec #2's Figma publish may adopt QStash regardless.

- **Idempotency / re-run:** on a successful run `generateUxStitch` overwrites `ux_stitch`;
  re-approving regenerates. Because a failed run never writes (Error handling), retries and
  out-of-order completions can't clobber a landed stitch, so **no DB lock is needed in
  Spec #1**.
- **No live stitch UI in Spec #1 — hence no poller.** `ux_stitch` is a *server-side context
  artifact*, not a rendered surface: the only trigger is the existing **Approve Spec**
  button, and nothing on screen blocks on generation. On approve, show a **fire-and-forget
  toast** — *"Structural plan generating in the background — it'll inform the next prototype
  build."* No client polling, no `isGeneratingStitch` lock, no "Regenerate" button in this
  spec. Those (a stitch-viewing panel + its poller/lock) belong to Spec #2/#3, once the
  stitch gains a Figma-backed visual surface worth waiting on.
- **Scope guard:** `generateUxStitch` no-ops with a clear log if `planning_phase ===
  'planning'` (no planning tree yet) or if `objectives_json` is null.

## Error handling / graceful degradation

The pipeline must **never break** on the new step:

- **Write only on success.** `generateUxStitch` issues the `UPDATE ux_stitch` **only after
  it has a successfully parsed, schema-valid object**. Missing `GEMINI_API_KEY`, a Gemini
  error/timeout, or a truncated/invalid response → log `[ux-architect] …` and **return
  without writing**. It must **never write `null`** — so a failed (or slow, out-of-order)
  run can't clobber a stitch that already landed, and the column simply retains its prior
  value (which is `null` by default on a first, never-succeeded run).
- With no stitch present, the prototyping loop runs exactly as it does today (objectives +
  planning tree text only) — a graceful degrade, including the edge where a PM starts
  prototyping before the background stitch lands; the next render picks it up.
- Module A returning `null` (no objective notes) is normal, not an error.
- `buildFeatureContext` treats both new columns as optional throughout.

## Testing

- **Module A (unit):** the strong-value fixtures already captured from live tasks —
  positional name mapping via `type_config.options`; notes-only entries emitted;
  score/approved/total ignored; empty `Objectives` options handled; all-null → `null`;
  negative/decimal scores don't leak. Pure function, no mocks.
- **Module B (unit):** mock the Gemini client. Assert the assembled prompt includes
  objectives + every workflow + the design contract; assert schema-invalid Gemini output
  degrades to `null` (not a throw); assert the scope guard no-ops appropriately.
- **Orchestration (unit/route):** generation is scheduled (via `after()`) exactly once on
  the `planning→approved` edge; other transitions (`approved→prototyping`, a no-op PATCH of
  an already-`approved` feature) do not schedule it; a thrown Gemini error inside the
  `after()` callback does not fail the PATCH response.
- **No-write-on-failure (unit):** a Gemini error / timeout / truncated-invalid JSON
  results in **zero `UPDATE`** — `ux_stitch` retains its prior value; only a parsed,
  schema-valid object triggers a write.
- **Context (unit):** `buildFeatureContext` prefers `objectives_json`, falls back to
  legacy text, and includes the `ux_stitch` block when present.
- Full `jest` suite green before PR (currently 581/581).

## Ops checklist (deploy)

1. Apply migration `036` to prod **before** deploying any code that reads or writes the columns.
2. Set `GEMINI_API_KEY` in Vercel Production.
3. Deploy. Backfill of `objectives_json` happens naturally on the next gatekeeper
   enrichment per task; existing features re-enrich when their task next fires
   `taskUpdated`, or can be re-run manually.

## Deferred to later specs

- **Spec #2:** publish `ux_stitch` → Figma per-feature file (workflow pages + component
  library) via the MCP write path; add `features.figma_file_key`.
- **Spec #3:** resolve `view_figma`/`get_figma_styles` to the feature's own file for read-back.
- **Spec #4:** master per-app mirror from the repo screen-map + `DESIGN.md`.
- Sub-feature → `features` row modeling (parent/child) is deferred until Spec #2 needs the
  file-per-sub-feature structure.

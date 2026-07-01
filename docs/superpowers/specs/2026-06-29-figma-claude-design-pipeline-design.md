# Claude-as-Designer: ClickUp → Figma → GitHub Pipeline

**Date:** 2026-06-29
**Status:** APPROVED (2026-06-29) — ready for implementation planning
**Owner:** Michael Terry (PM)
**Designer/Developer:** Claude

---

## 1. Context & Problem

The UI/UX designer has left. Claude takes over UI/UX design **and** front-end
implementation; Michael acts as PM. The existing Figma team (Viscap Media,
Professional plan) is the legacy of a human designer mid-migration: a bloated
42-file `Viscap UI` monolith was being broken into per-section projects, and the
team is polluted with non-UI artifacts (Flowcharts ~45 files, Data Planning,
User Story & Planning, Ideation, Sales Process, Archive).

Two hard constraints shape everything:

1. **Performance / anti-crash.** Large Figma files crash the browser. The new
   structure must aggressively shard files and cap active content per file.
2. **Claude cannot reliably draw on a Figma canvas.** Claude is excellent at
   *reading* Figma (REST API — already used in `lib/figma/client.ts`) and at
   *producing UI as code* (React/Tailwind/shadcn — already used by the prototype
   generator). Authoring vector designs directly in Figma is the fragile corner
   of the ecosystem and is explicitly out of scope.

The chosen direction (Path A): **Claude designs in code; Figma is a visual index
that mirrors the code.** GitHub `main` is the ultimate source of truth.

## 2. Goals

- Reorganize Figma so Claude can navigate by **map, not crawl**, and read only
  relevant, current UI.
- Keep every Figma file small enough to never crash the browser.
- Establish a deterministic **ClickUp → Figma → GitHub** loop where Claude
  reads context, mocks via live code previews, gets PM approval, ships a PR, and
  the Figma mirror updates automatically.
- Guarantee **design-to-code parity** via Figma Code Connect + cross-referencing
  the live codebase.

## 3. Non-Goals

- Claude hand-drawing or editing vector frames on a Figma canvas.
- Figma being authoritative over code for any decision.
- Migrating mobile/desktop now (mobile is kept as-is; desktop is parked/archived).
- Real-time bidirectional Figma↔code sync. Sync is one-directional: code → mirror.

## 4. Roles & Source-of-Truth Hierarchy

| Role | Owner |
|------|-------|
| Product/priorities, approvals | Michael (PM) |
| UI/UX design + front-end code | Claude |

**Source-of-truth ranking (highest wins on any conflict):**

1. **GitHub `main`** (React/Tailwind/shadcn) — the real product. Ultimate SoT.
2. **⬡ Foundations** library — tokens/components, kept in parity with code via
   Code Connect.
3. **Figma 🟢 CURRENT PRODUCTION pages** — an automated *visual mirror* of shipped
   code. Never authoritative; regenerated from code.
4. **Figma 🔒 SOURCE OF TRUTH zones** — last approved design intent per user story.

If Figma and code disagree, **code wins** and the Figma mirror is regenerated.

## 5. Figma Organization

### 5.1 Zones (top-level separation by purpose)

Figma Professional has no nested folders, so zones are expressed as a **project
name prefix**. Zones keep Claude's design-reference set clean.

| Zone | Prefix | Claude access | Contents |
|------|--------|---------------|----------|
| Foundations | `⬡ FOUNDATIONS` | 🔒 read-only (95%) | global tokens + atomic components, Code-Connected |
| Product UI | `▣` | read SoT, write Sandbox (via export) | the design index, project-per-app |
| Flows & Planning | `◇` | read on demand | flowcharts, data planning, user stories, ideation |
| Archive | `▢` | ignore | Desktop app, old `Viscap UI` monolith |

### 5.2 Hierarchy — Project = App

```
▣ WEB APP        (Figma project)
  └─ Settings — Billing            (file = feature, sharded)
       ├─ 📋 INDEX                  (file cover: contents, links, status)
       ├─ US-1234 · Default payment method   (page = active user story)
       │    ├─ 🔒 SOURCE OF TRUTH   (frame group, read-only)
       │    └─ 🤖 CLAUDE SANDBOX    (frame group, Claude iterations)
       ├─ US-1235 · Invoice history
       ├─ US-1236 · Plan upgrade
       └─ 🟢 CURRENT PRODUCTION     (auto visual mirror of shipped code)
  └─ Settings — Account
  └─ Media Library — Upload
  └─ ...
▣ CMS APP
▣ MOBILE APP      (kept as-is for now; conform opportunistically)
```

### 5.3 Anti-crash sharding rules

- **File = one feature.** e.g. `Settings — Billing`, not `Settings`.
- **≤ 3–5 active user-story pages per file.** When a 6th is needed, either the
  feature is too broad (split the file) or a shipped story should be retired.
- **Retirement is event-triggered, not review-triggered.** A page is retired at
  the **exact moment its PR merges to `main` and the automated screenshot lands**
  on `🟢 CURRENT PRODUCTION` — not at sprint review. On that event the story's
  design pages move to a per-feature `… — Archive` file (zone `▢`), and the index
  `status` flips to `shipped`. The active file keeps only in-flight work +
  `🟢 CURRENT PRODUCTION` + `📋 INDEX`. This keeps the active workspace
  continuously clean and the page cap self-enforcing.
- No file should hold more than the cap of frames Claude reads at once
  (`lib/figma/client.ts` caps frame export at 25; keep well under).

### 5.4 Page anatomy — the Claude Sandbox contract

Every **active** user-story page is split into two zones:

- **🔒 SOURCE OF TRUTH** — the last PM-approved/shipped frames. Claude is
  **read-only** here. Never modified by Claude.
- **🤖 CLAUDE SANDBOX** — where Claude's iterations land for PM review. Because
  Claude does not draw in Figma, the Sandbox holds **exported PNGs of live code
  previews** (Vercel) and/or Figma Make output, labeled `Option A/B/C`.

`🟢 CURRENT PRODUCTION` is a page-level **automated mirror** — screenshots of the
shipped UI captured from the running app, not hand-drawn frames.

### 5.5 Naming contract

| Level | Convention | Example |
|-------|-----------|---------|
| Project | `<ZONE PREFIX> <APP>` | `▣ WEB APP`, `⬡ FOUNDATIONS — Web` |
| File | `<Section> — <Feature>` | `Settings — Billing` |
| Page (active) | `US-<id> · <short title>` | `US-1234 · Default payment method` |
| Page (special) | reserved names | `📋 INDEX`, `🟢 CURRENT PRODUCTION` |
| Sandbox frame | `Option <X> — <variant>` | `Option B — compact` |
| State frame | `<Screen> / <State>` | `Billing / Error`, `Billing / Empty` |

States vocabulary: `Default`, `Empty`, `Loading`, `Error` (extend per need).
`US-<id>` is the **ClickUp ID** — the join key across the whole pipeline.

### 5.6 Foundations rules

- ⬡ Foundations holds **global tokens** (color, type, spacing, radius, elevation)
  and **atomic components**, each **mapped 1:1 to React/Tailwind/shadcn** via
  Figma **Code Connect**.
- Claude is **read-only** on Foundations for ~95% of tasks: it *composes layouts
  from* these blocks; it does not edit the blocks.
- **Promotion path (the 5%):** introducing/altering an atomic component requires a
  task that explicitly approves promotion. Promotion = build the component in code
  first (GitHub PR), then update the Foundations Code Connect mapping. Tokens flow
  code → Foundations, never the reverse.

## 6. The "Claude Layer"

What makes the structure *machine-optimized*, not merely tidy.

### 6.1 GitHub `main` as live design context

On every task Claude cross-references the **live codebase** alongside Foundations
to guarantee design-to-code parity (existing components, tokens, patterns, routes).

### 6.2 Machine-readable index (lives in this repo)

A registry — proposed path `design/figma-index.json` — keyed by **ClickUp ID**,
the single map Claude reads before fetching any frames. It connects PM, Figma, and
code, and reuses the URL/node parsing already in `lib/figma/client.ts`.

```jsonc
{
  "version": 1,
  "apps": {
    "web": { "figmaProject": "▣ WEB APP" },
    "cms": { "figmaProject": "▣ CMS APP" },
    "mobile": { "figmaProject": "▣ MOBILE APP" }
  },
  "features": [
    {
      "id": "settings-billing",
      "app": "web",
      "section": "Settings",
      "feature": "Billing",
      "figmaFileKey": "abc123",
      "figmaFileUrl": "https://figma.com/design/abc123/Settings-Billing",
      "codePaths": ["app/settings/billing/**", "components/billing/**"],
      "userStories": [
        {
          "clickupId": "US-1234",
          "title": "Default payment method",
          "status": "in-design",        // in-design | approved | shipped | archived
          "figmaPageNodeId": "1:234",
          "sourceOfTruthNodeId": "1:235",
          "sandboxNodeId": "1:236",
          "githubIssue": 812,
          "lastPr": 845,
          "previewUrl": "https://pm-app-git-...vercel.app/settings/billing"
        }
      ]
    }
  ]
}
```

The index is updated as part of each task. It is the authority on *where things
live*; code remains the authority on *what is true*.

**Anti-rot CI guard.** A script wired into CI keeps the index honest — the build
fails on a deleted file, a typo'd path, or a dangling ticket:

```bash
npm run validate-design-index
```

It parses `figma-index.json` and asserts: (1) every `clickupId` maps to an active
or recently-closed ClickUp task; (2) every `codePaths` glob resolves to real files
in the repo; (3) the JSON conforms to the schema. Runs on every PR.

### 6.3 Tooling integration

- **Figma Code Connect** on ⬡ Foundations → exact React/Tailwind component paths
  surfaced in Dev Mode and consumable by Claude.
- **Official Figma GitHub plugin (Dev Mode)** → links active user-story pages to
  GitHub **Issues and PRs**, so a Figma page and its implementation PR are bound.
- **Figma Make bindings** → back up / sync early AI visual prototyping to GitHub
  when used for exploration.

### 6.4 Long-Lived Branch Resync Protocol

Feature branches that stay open across multiple sprints drift behind `main`.
Because Claude reads the live codebase as design context (§6.1) and edits
`design/figma-index.json`, a stale branch makes Claude design against outdated
components, write broken `codePaths`, and trip the anti-rot CI guard. To prevent
this, the following is **mandated before any active iteration phase** on an open
branch. Claude's *first* action when resuming work on a branch is to check
freshness against `main`.

1. **Upstream alignment (rebase, not merge).** `git fetch origin` then
   `git rebase origin/main`. Rebase keeps history linear so Claude's
   code-reading context isn't polluted by `Merge branch 'main'...` commits.
2. **Conflict resolution rule.** On conflicts in `design/figma-index.json`,
   prioritize the **schema/structural updates from `main`**, then re-append the
   branch's local active user-story objects on top.
3. **Local gate validation (must pass before pushing):**
   - `npm run typecheck` — zero TypeScript regressions (`tsc --noEmit`).
   - `npm run validate-design-index` — paths + ClickUp IDs match the rebased repo.
4. **Force-safe push.** Only after both gates pass:
   `git push origin <branch> --force-with-lease` (never bare `--force`).

This mirrors the CI guard (§6.2) locally so drift is caught before the push, not
after. The same two gates are what the `design-index-validate` workflow enforces
on the resulting PR.

## 7. End-to-End Workflow Loop

For each user story (driven by a ClickUp ticket):

1. **Read context** — Claude loads the `figma-index.json` entry, the live code at
   `codePaths`, and Foundations (via Code Connect). Reads 🔒 Source of Truth +
   🟢 Current Production frames for the current visual baseline.
2. **Mock** — Claude builds iterations as **live code previews** (Vercel preview
   deploy) and/or Figma Make; exports labeled `Option A/B/C` PNGs into the
   🤖 Claude Sandbox.
3. **PM review** — Michael reviews previews/Sandbox, picks a direction or requests
   changes (loop on step 2).
4. **Build** — Claude implements the approved design in React/Tailwind/shadcn,
   opens a **GitHub PR linked via the Dev Mode plugin** to the Figma page + Issue.
   Updates the index entry (`status`, `lastPr`, `previewUrl`).
5. **Sync** — on merge to `main`, an **automated visual mirror** captures the
   shipped UI and updates 🟢 CURRENT PRODUCTION; the story's design pages are
   retired to the feature Archive; index `status` → `shipped`.

GitHub `main` remains the ultimate source of truth at every step.

## 8. Migration Plan (from current state)

Phased; no big-bang. Order matters because the index + naming contract unblock
everything else.

1. **Foundation paperwork** — write the naming contract + zone definitions; create
   empty `▣ WEB APP` / `▣ CMS APP` projects and `⬡ FOUNDATIONS — Web` (+ Mobile).
2. **Index bootstrap** — create `design/figma-index.json` (+ JSON schema + CI
   validation). Seed with already-migrated features (Creatives, Settings,
   Performance Hub, Ideation, ActorHub).
3. **Zone the team** — prefix-rename existing projects into zones; move Flowcharts,
   Data Planning, User Story & Planning, Ideation under `◇`; move Desktop + the
   old `Viscap UI` monolith under `▢ ARCHIVE`.
4. **Shard the monolith** — split `Viscap UI` (42 files) into per-feature files
   under the app projects, applying the ≤3–5 active-page cap and two-zone page
   anatomy. Highest-traffic sections first (Media Library, Settings, Phase &
   Sprint, Brand Intranet, Login/Onboarding).
5. **Wire tooling** — Code Connect on Foundations; install the Figma GitHub plugin;
   set up the automated CURRENT PRODUCTION mirror job.
6. **Run one loop end-to-end** on a single user story to validate, then scale.

## 9. Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Figma mirror drifts from code | Automated, code-driven mirror; code always wins |
| Index goes stale | CI schema validation; updating index is a step in every task |
| Sandbox PNGs mistaken for "real" Figma designs | Clear `🤖 CLAUDE SANDBOX` labeling; SoT is read-only |
| Foundations edited ad hoc | Promotion gate; tokens flow code → Foundations only |
| Files crash again over time | ≤3–5 active-page cap + retirement to Archive enforced |
| Code Connect mappings rot | Treated as part of component PRs (update mapping on change) |

## 10. Success Criteria

- No Figma file crashes the browser; every active file ≤ 3–5 user-story pages.
- Claude can resolve any ClickUp ID → exact Figma frames + code paths from the
  index in one hop, without crawling.
- A full loop (ClickUp ticket → approved preview → merged PR → updated mirror)
  completes with Michael only doing PM review and approval.
- Foundations components are Code-Connected; design-to-code parity is verifiable.

## 11. Resolved Implementation Decisions

These were open questions during review; resolved 2026-06-29.

### 11.1 Automated `🟢 CURRENT PRODUCTION` mirror — Playwright in a GitHub Action

On every successful merge to `main`:

1. A GitHub Action spins up headless Playwright, authenticates, and navigates to
   the route(s) for the merged story (derived from the index's `codePaths` /
   `previewUrl`, against a dedicated staging environment).
2. Playwright captures full-page and/or component-level screenshots.
3. The screenshots are pushed onto the `🟢 CURRENT PRODUCTION` page.

   **Technical note:** the Figma **REST API is read-only for canvas content** — it
   cannot place or replace a layer on a page (`POST /v1/files/:key/images` only
   registers an image *fill* hash; it does not author canvas). So the canvas
   update goes through the **plugin bridge** (a small Figma plugin the Action
   drives) or Figma's own Make/GitHub sync. Capturing and storing the screenshot
   is the robust part; the plugin-bridge placement is the one known-fragile step
   and is isolated to this job so its flakiness can't affect the design loop. If
   the bridge update fails, the screenshot artifact is still committed and the
   mirror can be reconciled on the next run.

### 11.2 Index location — centralized `design/figma-index.json`

Single centralized file, **not** per-feature front-matter. Decentralized
front-matter would force Claude to crawl the whole repo file-tree to locate a
story; a centralized, schema'd JSON lets Claude read one structured map in a single
token read before making any Figma API call.

### 11.3 ClickUp ID reconciliation — `clickupId` is the universal join-key

`clickupId` is the unique join-key across ClickUp ↔ Figma ↔ code ↔ the FVI/vault
pipeline. ClickUp automation is configured so that when a ticket moves to **In
Progress**, a webhook **auto-generates a boilerplate entry** in `figma-index.json`
with its structural parameters — so Claude starts each story with its map slot
already scaffolded.

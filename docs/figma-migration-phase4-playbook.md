# Figma Migration — Phase 4 Move/Shard Playbook

Generated from the post-scaffold re-inventory (`design/figma-inventory.json`, 16 projects) + canonical-source decisions. Manual operations in the Viscap Media Figma team. Web-scoped.

## Decisions locked (2026-06-30)
- **Dedicated file/project wins**; `VisCap 2.0` is the legacy master → **archived** (2yr old, unmaintained). Do not resurrect its pages.
- **Ant Design System** → `⬡ FOUNDATIONS` as a reference; **then update it to latest** (code is on **antd v6**; the Figma kit is **5.11** — update for design-to-code parity).
- **Education** stays in WEB (CMS authors content; the Education page is the user-facing access point).

## The contract
- **Live single-area projects** (`ActorHub`, `Creatives`, `Ideation`, `Perfomance Hub`, `Settings`) are canonical → **MOVE** their files into `▣ WEB APP`. Delete the emptied project afterward.
- **Frozen `▢ Viscap UI`** keepers → **DUPLICATE** out into the destination (never edit the frozen original). The frozen project stays intact as the complete archive (incl. `VisCap 2.0`).
- **Prune on arrival:** after move/duplicate, delete these housekeeping pages from the WEB APP copy:
  `Playground`, `Tour`, `Cover`, `Archive`, `Proto`, `Tech`, and divider pages (`---`, `----`, `_____`). Keep only real feature pages.
- **Naming:** file = `<Section> — <Feature>`; whole-section files just use the section name. Legacy stories are seeded `shipped`, so the ≤3–5 active-page cap does **not** force splits — only split when a file still holds genuinely distinct features after pruning.

---

## A. `▣ WEB APP` — MOVE from live single-area projects (then prune)

**Settings** (section → one file per feature):
- [ ] `Account Settings` → **`Settings — Account`** (keep `Your Account`; drop Proto/Playground/Archive/Cover)
- [ ] `Billing & Usage\Settings` → **`Settings — Billing & Usage`**
- [ ] `Brand\Settings` → **`Settings — Brand`**
- [ ] `Position\Settings` → **`Settings — Position`**
- [ ] `People\Settings` → **`Settings — People`**
- [ ] `Workflow` → **`Settings — Workflow`**

**Creatives**:
- [ ] `Creatives` → **`Creatives`** (keep `Creatives`, `↳ In-App Editing`, `↳ Shotlists`; drop Playground/Tour/Archive/Cover)
- [ ] `Storyboard` → **`Creatives — Storyboard`**
- [ ] `Storyboard Sidepanel` → **`Creatives — Storyboard Side Panel`**
- [ ] `Script` → **`Creatives — Script`**

**Actor Hub**:
- [ ] `Actor Hub` → **`Actor Hub`** (prune to feature pages)
- [ ] `Casting` → **`Actor Hub — Casting`**

**Ideation**:
- [ ] `Ideation` → **`Ideation`** (keep `Design`; drop scratch)
- [ ] near-empty stubs (`Concept/ Ideation` 0f, `Idea, BDoc Sidepanel` 0f, `Kanban View for BD` 0f, `Brainstorm Doc` 1f, `Inspiration Bank` 1f) → **`▢ ARCHIVE`** unless they hold real content

**Performance Hub**:
- [ ] `Performance Hub` → **`Performance Hub`**
- [ ] `Filter&Setting/Perfomance Hub` → **`Performance Hub — Filters & Settings`**

## B. `▣ WEB APP` — DUPLICATE from frozen `▢ Viscap UI` (then prune)

- [ ] `Mission Control` (114f) → **`Mission Control`** (keep `V1 (Developed)` as current; `V2/V3` optional; drop Tour/Cover/Archive)
- [ ] `Talent Management` (69f) → **`Talent Management`** (pages `Talent Approval`, `Talent Application Review`, `Gallery`; split into `Talent — …` files only if any page is itself oversized)
- [ ] `Brand Intranet` (61f) → **`Brand Intranet`** (`Feature Planning`, `Creative Brief`)
- [ ] `Log In / Sign Up` (31f) → **`Login — Sign In / Sign Up`**
- [ ] `Reports` (30f) → **`Reports`**
- [ ] `Media Library` (28f) → **`Media Library`**
- [ ] `Conversations` (28f) → **`Conversations`**
- [ ] `Idea Bank` (28f) → **`Ideation — Idea Bank`**
- [ ] `Help & Resources` (22f) → **`Help & Resources`**
- [ ] `Education` (13f) → **`Education`**
- [ ] `New Creative Page` (36f) → **`Creatives — New Creative`**
- [ ] `Permissions UI` (8f) → **`Permissions`**
- [ ] `Errors` (7f) → **`Errors / States`**
- [ ] `Creative Details` (5f) → **`Creatives — Creative Details`**
- [ ] `Talent Profile` (2f) → **`Talent Management — Profile`**

## C. `⬡ FOUNDATIONS` — DUPLICATE from frozen

- [ ] `Components` (17f), `Element Library UI` (10f), `Frameworks` (18f), `Variables` (1f) → Foundations
- [ ] `Ant Design System for Figma 5.11` (142f) → Foundations **reference**, then **update to latest Ant Design (v6) kit**

## D. `▢ ARCHIVE` / leave frozen

- `VisCap 2.0` (422f) — stays in frozen project = archived. Do not extract.
- `Webflow viscap.ai` (132f, marketing), `VisCap.ai 2.0 - Header` (marketing) → archive
- `Custom Naming Convention Field` (0f), `Draft` (0f) → archive/leave
- Near-empty Ideation stubs (per A) → archive

## E. Design-fresh candidates (no current source)
`Pricing`, `Tech` lived only inside the stale `VisCap 2.0`. If still needed, Claude designs them fresh rather than reviving 2-yr-old frames.

---

## Recommended execution order
1. **Pilot: `Settings`** end-to-end (6 clean files, obvious feature split) — validates the move→rename→prune loop + a WEB APP index seed.
2. Then `Creatives`, `Actor Hub`, `Performance Hub`, `Ideation` (live moves).
3. Then the frozen duplicates (Group B), biggest first (`Mission Control`, `Talent Management`, `Brand Intranet`).
4. `⬡ FOUNDATIONS` (Group C) + Ant Design update.
5. Re-run `figma:inventory` against `▣ WEB APP` → rebuild manifest → `figma:seed` (reconciled + pending).

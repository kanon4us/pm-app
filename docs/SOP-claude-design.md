# SOP: Having Claude Do UI/UX Design Work

**Purpose:** A repeatable procedure for turning a design need into shipped UI, with Claude as designer/developer and the PM steering. Reflects the Claude-as-designer pipeline (spec: `docs/superpowers/specs/2026-06-29-figma-claude-design-pipeline-design.md`).

**Roles:**
- **PM (you):** decides *what* and *why*, reviews, approves, merges.
- **Claude:** designs *in code*, reads Figma/context, opens PRs.

---

## Golden rules (why this works)

1. **Code is the source of truth. Figma mirrors code.** The running app *is* the design. Figma is a read-only reference + archive.
2. **Claude does not draw in Figma.** It reads Figma; it produces UI as React/Tailwind/shadcn. "Sandbox" = live Vercel previews + screenshots, never hand-drawn frames.
3. **Every design task is anchored to a ClickUp ticket.** The ClickUp ID is the join key across ClickUp ↔ Figma ↔ code ↔ the design index.
4. **One feature = one Figma file = one code area = one index entry.** Keep it small.

---

## The procedure

### 1. Create/prepare the ticket (PM)
- Create or pick a ClickUp ticket in the **Planning** list.
- Put the Figma design/reference link in the **"Figma"** field.
- Move the ticket's status to **`ui/ux`** (or `ready for ui/ux review`).
- → This auto-scaffolds a design-index entry (webhook → `design-index-sync` PR). No action needed; it just means the ticket is now "on the map."

### 2. Brief Claude (PM)
Give Claude the ticket ID and the intent. A good brief includes:
- **What** the feature/screen is and **who** it's for.
- **Success criteria** (what "good" looks like) and any hard constraints.
- Whether it's **net-new** or a **change to an existing screen** (name it).
- Anything Figma shows that Claude should honor or deliberately depart from.

> Claude will pull the rest itself: the index entry, the linked Figma frames, the live code at the feature's `codePaths`, and the Foundations/component patterns.

### 3. Claude gathers context (Claude)
Before designing, Claude:
- Reads the design-index entry for the ticket (Figma file/nodes + code paths).
- Reads the current Figma frames (read pipeline) as reference.
- Reads the **live code** at the feature's paths + existing components (so new UI matches what's shipped).

### 4. Claude proposes (Claude → PM)
- Claude builds the UI as real code on a branch and opens a **Vercel preview**.
- For options/exploration, Claude shows 2–3 directions as live previews or screenshots — not Figma mockups.
- **PM reviews the preview** (not Figma) and picks a direction / requests changes. Iterate here.

### 5. Ship (Claude → PM)
- On approval, Claude finalizes the code, opens a **PR**, and links it to the ClickUp ticket + Figma page (Dev Mode plugin, when wired).
- **PM reviews the PR and merges.** The merged app is now the canonical design.

### 6. Sync (automatic / roadmap)
- The design-index entry updates with the real ClickUp ID + code paths; it moves from *pending* → *reconciled* once its code paths exist.
- *(Roadmap)* An automated screenshot updates the Figma `🟢 CURRENT PRODUCTION` mirror so Figma reviewers see shipped state.

---

## Definition of done
- [ ] Feature works in the app (the design *is* the running UI).
- [ ] PR merged to `main`.
- [ ] Design-index entry carries the real ClickUp ID and resolvable `codePaths` (reconciled, not pending).
- [ ] CI green (`design-index-validate` + tests).

---

## Guardrails — what Claude must NOT do
- Do **not** modify Figma canvases or the `🔒 SOURCE OF TRUTH` zones. Figma is read-only reference.
- Do **not** invent a component when one exists — reuse Foundations / existing components first.
- Do **not** promote a new shared/atomic component without explicit PM approval (build it in code first, then map it into Foundations).
- Do **not** claim "done" without a working preview/PR the PM can see.

---

## When things go wrong
- **Ticket moved to `ui/ux` but no index entry appeared** → check the ticket has a **Figma** field value, and that its list is the Planning list. The scaffold only fires on the configured design statuses (`CLICKUP_DESIGN_INDEX_STATUSES`).
- **Entry stuck in `pending`** → its `codePaths` don't exist yet (feature not built) or it has no real ClickUp ID. It auto-promotes to the live index once the code lands.
- **Figma link is stale/points at the wrong frame** → fix the ticket's Figma field; re-fire the status so a fresh scaffold runs.
- **Need to see queued scaffolds** → the rolling `design-index-sync` PR on GitHub.

---

## Quick reference
| Thing | Where |
|---|---|
| Trigger | ClickUp status → `ui/ux` (Planning list) |
| Figma link | ClickUp "Figma" field |
| The map | `design/figma-index.json` (+ `figma-index.pending.json`) |
| Design surface | `▣ WEB APP` project (one file per feature) |
| Reference only | `⬡ FOUNDATIONS`, `🔒 SOURCE OF TRUTH` zones |
| Review | Vercel preview, then the PR — **not** Figma |
| Source of truth | GitHub `main` |

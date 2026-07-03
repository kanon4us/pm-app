# Prototype Canvas — Design (architecture pivot)

**Date:** 2026-07-03
**Status:** Approved by PM. SUPERSEDES the PR-handoff half of `2026-07-02-prototyping-phase-design.md`.
**Decision:** The app.viscap.ai PR flow is DEAD. Prototypes are viewed inside pm-app. Nothing writes to the product repo.

## Why

Live e2e showed the PR→deploy→Vercel-preview loop is too heavy for design iteration, and the PM's goal is a canvas: test the prototype in pm-app while chatting with Claude beside it.

## What stays / what goes

**Stays:** read-only research tools (`list_directory`, `read_file` on `CODE_REPO@develop` — inspiration and design-language fidelity only), `view_figma`, the planning phase, spec approval gate, streamed 32K-token generations (PR #21). GitHub helpers remain for the design-index cron. `features.prototype_branch`/`prototype_pr_url` columns stay but go unused (no migration needed).

**Goes:** `submit_prototype` (branch/PR executor deleted from the chat tool set), the Prototype PR button/toast, the "PRs off develop" framing in prompts.

## New pieces

### `render_prototype` tool (`lib/claude/tools/prototyping.ts`)

Input: `{ title: string, html: string, notes?: string }`. Executor:
1. Validates `html` is non-empty, self-contained (starts with `<!DOCTYPE` or `<html`), and under ~1.5MB.
2. Flips `is_current = false` on the feature's existing `feature_prototypes` rows (feature-level: `scenario_id null`), inserts the new row (`html_content`, `is_current: true`, `generated_by: 'claude-chat'`). Reuses the legacy table — no migration.
3. Sets `planning_phase = 'prototyping'`.
4. Sets `applied.prototypeUpdated = true` (replaces `prototypePrUrl`); marker `[Prototype updated — open the Prototype tab]`.

No vault push (the legacy route's vault mirror is not carried over).

### Prompt rewrite (`lib/claude/prompts/prototyping.ts`)

- The prototype is ONE self-contained HTML file: Tailwind via CDN `<script>`, inline mock data, inline JS for interactions (tabs, drawers), no external imports, no build step. It must be able to render inside a sandboxed iframe with scripts enabled.
- Fidelity comes from research: read app.viscap.ai components for the design language and view_figma for the design; replicate look and interaction patterns, do not import code.
- Iterate by re-rendering: each render_prototype call fully replaces the current prototype (prior HTML is not in context — re-render complete files).
- Announcements-are-not-actions rule stays. Two-repo framing rewritten: the product repo is read-only reference.

### Viewer (frontend)

- `GET /api/features/[id]/prototype` (added to the existing route file): returns the current feature-level prototype `{ id, html_content, created_at }` or 404.
- `app/features/[id]/page.tsx`: center panel gets a Segmented toggle **Scenarios | Prototype**. Prototype view = new `PrototypePanel` component: sandboxed iframe (`srcdoc`, `sandbox="allow-scripts"`), refresh button, "generated at" timestamp, empty state ("No prototype yet — ask Claude to render one"). The right-hand Claude chat stays usable beside it (PM's note #5).
- `ClaudePanel`: `prototypePrUrl` prop removed; on `applied.prototypeUpdated`, toast "Prototype updated — open the Prototype tab" and `onApplied()`; approved-phase empty-state hint reworded.

## Error handling

- `render_prototype` validation failures → `is_error` tool results (Claude fixes and retries in-loop).
- Iframe renders whatever HTML it gets — sandbox (`allow-scripts`, NO `allow-same-origin`) confines it; Tailwind CDN works under that sandbox.

## Testing

`tsc` + `next build`; live: approved feature → "render the prototype" → toggle to Prototype tab, iframe shows panel; revision request → re-render replaces it in place.

## Out of scope

Version history browsing (table already keeps rows), comments-on-prototype for team demos (next design), scenario-scoped prototypes, deleting the parked PR-handoff code paths beyond the tool set.

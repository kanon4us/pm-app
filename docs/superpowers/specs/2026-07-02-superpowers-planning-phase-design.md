# Superpowers Planning Phase in the Feature Editor — Design

**Date:** 2026-07-02
**Status:** Approved by PM (Michael), implementation in progress
**Scope:** Planning loop only. Prototyping (GitHub branch off `develop`, PR, Vercel preview) is the next iteration.

## Context

pm-app is the internal tooling/orchestrator; `Viscap-Media/app.viscap.ai` is the product repo (canonical design = code, React/Tailwind, integration branch **`develop`** — verified: the repo has `develop` and `main`, no `dev`). A ClickUp ticket entering `ui/ux` scaffolds a feature; the PM then plans it with Claude in the Feature Editor (`app/features/[id]/page.tsx`) via `ClaudePanel.tsx`.

Today the chat backend (`lib/features/conversation.ts` → `sendFeatureMessage`) makes a single Anthropic call with a 10-line system prompt and communicates structure back through a fragile `**[SUGGESTED STEP]**` regex that can only append to the first scenario.

## Goal

Claude acts as an obra/Superpowers-style planner inside ClaudePanel: brainstorms one question at a time, proposes approaches, populates the scenarios panel via native tool calls, and produces a spec the PM approves — the approval being the gate to the (future) prototyping phase.

## Decisions (made with PM)

1. **Prompt source:** vendor + adapt. Superpowers brainstorming/spec methodology is adapted into a prompt module in this repo; Claude-Code-isms (Skill tool, TodoWrite, worktrees, git) stripped; outputs rewired to tools.
2. **Structured output:** Anthropic tool use, not text markers. Tools execute directly against Supabase; the frontend reloads. The human gate is **spec approval**, not per-proposal confirmation.
3. **Spec artifact:** `features.spec_content` (markdown) + `features.planning_phase` (`planning` → `approved` → `prototyping`). Migration 031.
4. **Backend shape:** single-pass tools with one continuation call (Approach A). No agentic loop, no streaming, no Agent SDK. Evolve later if prototyping needs it.

## Architecture

### New files

- `lib/claude/prompts/planning.ts` — `PLANNING_SYSTEM`. Keeps from Superpowers: understand before designing; one question per message, multiple-choice preferred; propose 2–3 approaches with trade-offs; YAGNI; present design in sections and validate incrementally; hard gate — no prototype until the PM approves the spec. States the two-repo reality (`app.viscap.ai` off `develop`, React/Tailwind, code is canonical). Instructs: read the Current Feature State block; use `propose_plan` / `add_steps` / `write_spec`; at most one plan-mutation per turn.
- `lib/claude/tools/planning.ts` — tool definitions (Anthropic JSON schemas) + executors:
  - `propose_plan` — `{ rationale, user_stories: [{ title?, as_a, i_want, so_that, scenarios: [{ title, description?, steps: [{ title, description? }] }] }] }`. **Append-only**: creates new stories (linked via `feature_user_stories`), scenarios, steps. Never mutates or deletes existing rows — edits to existing items stay manual.
  - `add_steps` — `{ scenario_id, steps: [{ title, description? }] }`. Appends steps to an existing scenario (`display_order` continues from max).
  - `write_spec` — `{ spec_markdown, summary_of_changes }`. Full replacement of `features.spec_content`. Drafts are freely overwritable; approval is the gate.

### Changed files

- `lib/features/conversation.ts` — `sendFeatureMessage` gains `tools`, `max_tokens: 4096`. If `stop_reason === 'tool_use'`: execute tools, send one continuation with `tool_result`s ("Applied — N stories / M steps created", "Spec draft saved"), take its text. One continuation only; tool calls in the continuation are executed but not continued again. Persisted history stays **text-only**: assistant messages get inline markers like `[Applied plan: 2 stories]` / `[Updated spec]` so replay needs no tool_use reconstruction. Returns `{ content, applied: { stories, scenarios, steps, specUpdated } | null }`. `parseSuggestedStep` and the regex contract are deleted.
- `lib/features/context.ts` — `buildFeatureContext` includes `planning_phase`, whether a spec exists, and **scenario ids** (`(id: …)`) so `add_steps` can target them.
- `app/api/features/[id]/conversation/message/route.ts` — passthrough of the new response shape (no structural change).
- `app/api/features/[id]/route.ts` — PATCH accepts `planning_phase` (validated against the three values); GET already returns full feature row so `spec_content`/`planning_phase` flow to the client.
- `lib/supabase/types.ts` — hand-maintained; add the two columns to `features` Row/Insert/Update.
- `supabase/migrations/031_feature_planning_phase.sql` — `ALTER TABLE features ADD COLUMN planning_phase TEXT NOT NULL DEFAULT 'planning' CHECK (planning_phase IN ('planning','approved','prototyping')), ADD COLUMN spec_content TEXT`. **Ops note:** migrations are applied to prod manually — apply 031 before or with this deploy (Sprint-Planner-outage lesson).
- `app/features/[id]/components/ClaudePanel.tsx` —
  - Props become `{ featureId, planningPhase, hasSpec, onApplied }` (`onApplied` = page `reload`). `onSyncStep` and the regex button are removed.
  - After a reply with `applied`, show a small tag on the message ("Plan applied", "Spec updated") and call `onApplied()`.
  - Header: phase badge (`planning` / `approved` / `prototyping`) + "Spec" button opening an antd Drawer that fetches `spec_content`, renders it (pre-wrap text, v1), and shows **Approve spec** (enabled when phase is `planning` and a spec exists) → `PATCH { planning_phase: 'approved' }` → reload. Approving is what the next iteration's "generate prototype" will check.
- `app/features/[id]/page.tsx` — `Feature` interface gains `planning_phase`, `spec_content`; ClaudePanel wiring swaps `onSyncStep` for `onApplied={reload}` (the old first-scenario `/api/steps` POST goes away).

### Data flow

1. PM sends message → route → `sendFeatureMessage`.
2. Claude (Superpowers prompt + feature context) either asks its next brainstorming question (plain text) or calls a tool.
3. Tool executors write to Supabase; continuation call lets Claude narrate what it did.
4. Response `{ content, applied }` → ClaudePanel appends message, fires `onApplied()` → page `reload()` refreshes stories/scenarios/steps and phase.
5. When the PM is satisfied, Claude writes/updates the spec via `write_spec`; PM reads it in the Spec drawer and clicks **Approve spec** → `planning_phase = 'approved'`. Prototyping (next iteration) requires `approved`.

## Error handling

- Tool executor failures: caught per-tool; the `tool_result` carries `is_error` with the message so Claude can tell the PM what failed; the route still returns 200 with the assistant text.
- `add_steps` with an unknown `scenario_id`: executor returns an error result (no throw).
- Anthropic errors keep current behavior (route 500, panel toast, optimistic message rolled back).
- Phase PATCH validates the enum; unknown values → 400.

## Testing

- Repo has no test harness for these libs today; verification is `tsc`/`next build` + manual: brainstorm a feature end-to-end locally (question flow → propose_plan populates panel → write_spec → approve flips phase).

## Out of scope (next iterations)

- Prototyping route: branch off `develop` in app.viscap.ai, write React/Tailwind, open PR, return Vercel preview link into the chat.
- Editing/deleting existing stories/steps via tools; spec markdown rendering; streaming.

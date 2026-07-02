# Prototyping Phase — Design

**Date:** 2026-07-02
**Status:** Decisions locked with PM; spec awaiting PM review
**Depends on:** Superpowers planning phase (PR #15 — still open at time of writing; this branch is based on it)

## Goal

Once a feature's spec is approved (`planning_phase = 'approved'`), the PM triggers prototyping in the ClaudePanel chat. Claude inspects the real code in `Viscap-Media/app.viscap.ai`, writes React/Tailwind for the approved spec, opens a PR against **`develop`** (never `main`), and returns the PR link in chat. Vercel's bot posts the preview URL on the PR.

## Decisions (locked with PM)

1. **Code reading:** agentic read-only tools (`list_directory`, `read_file`) wrapping the GitHub REST API against `develop` — NOT backend auto-injection of codePaths files (codePaths data is incomplete, they're directories, and shared components/utilities outside the mapping always come up). The feature's `code_paths` are injected into the system prompt as **Suggested Starting Points**, with the instruction to inspect them first and to check for existing shared components before writing new ones.
2. **Commit handoff:** one `submit_prototype` tool. Branch name computed **server-side** (`feature/uiux-<clickup_task_id>`), base `develop`, PR opened **without auto-merge** — the PR stays open for PM review and the Vercel preview. (Literal reuse of `ensurePrWithAutoMerge` was rejected: it hardcodes base `main` and would auto-squash-merge prototype code into the product on green CI.)
3. **Preview link (v1):** the tool returns the GitHub PR URL; Claude relays it in chat and ClaudePanel shows a "Prototype PR ↗" button from the stored URL. No webhook, no poller. (v2 option noted: pull-based `GET .../prototype/status` reading GitHub deployment statuses for the Vercel `environment_url`.)
4. **Execution shape:** the existing chat message route, gated on `planning_phase === 'approved'`, gains the repo tools + `submit_prototype` and a bounded agentic tool loop. No new trigger UI.

## Architecture

### New/changed environment

- **`CODE_REPO`** = `Viscap-Media/app.viscap.ai` (new). `GITHUB_REPO` stays `kanon4us/pm-app` for design-index PRs. `GITHUB_TOKEN` (org-wide repo scope) already covers both.

### Migration 032 (`features` table)

- `code_paths text[] not null default '{}'` — suggested starting directories in app.viscap.ai (set by PM or, later, the ClickUp webhook).
- `prototype_branch text` — server-computed branch name once a prototype is submitted.
- `prototype_pr_url text` — PR URL for the chat button and re-submissions.

Manual prod apply, before or with the code deploy (standing rule).

### GitHub helpers (`lib/github/`)

- Generalize `forceUpdateBranch(token, repo, branch, files, message, base = 'main')` — resolve the base ref from `base` instead of hardcoded `main`. Design-index callers unchanged.
- Generalize `ensurePrWithAutoMerge` → `ensurePr(token, repo, branch, { base, title, body, autoMerge })`. Design-index passes `{ base: 'main', autoMerge: true }` (behavior unchanged); prototypes pass `{ base: 'develop', autoMerge: false }`.
- Add `listRepoDir(token, repo, path, ref)` — GitHub Contents API on a directory; returns `[{ name, path, type }]`.
- `readRepoFile` already exists with a `ref` param — reuse against `develop`.

### Prototyping tools (`lib/claude/tools/prototyping.ts`)

Read-only exploration (no side effects, results go back into the tool loop):

- `list_directory` — `{ path: string }` → entries of that directory on `CODE_REPO@develop`. Root = `''`.
- `read_file` — `{ path: string }` → raw file text on `CODE_REPO@develop`. Errors (404, >200KB) return `is_error` tool results, not throws.

Submission (side-effecting, once per turn):

- `submit_prototype` — `{ commit_message, pr_title, pr_body, files: [{ path, content }] }`. Full file contents, create-or-replace; no deletions in v1. Executor:
  1. Computes branch: `feature/uiux-<clickup_task_id>` via `feature_tasks` → `tasks.clickup_task_id` (first linked task); fallback `feature/uiux-<first 8 chars of feature id>`.
  2. `forceUpdateBranch(…, base: 'develop')` — a re-submission re-snapshots the branch as one clean commit off `develop` (idempotent revisions).
  3. `ensurePr(…, { base: 'develop', autoMerge: false })`, body = `pr_body` + spec reference footer.
  4. Updates `features`: `prototype_branch`, `prototype_pr_url`, `planning_phase = 'prototyping'`.
  5. Returns the PR URL in the tool result.

### Prompt (`lib/claude/prompts/prototyping.ts`)

`PROTOTYPING_SYSTEM`, appended to `PLANNING_SYSTEM`'s replacement when phase ≥ `approved`. Core instructions:

- You are implementing an APPROVED spec (included in context). Scope discipline: build exactly the spec, YAGNI.
- First step is always inspection: `list_directory`/`read_file` starting from the Suggested Starting Points (`code_paths`), and check for existing shared components/utilities before writing new ones.
- Follow the repo's existing conventions (app.viscap.ai is Next.js pages-router; React + Tailwind; match local patterns you observe, don't import App-Router idioms).
- Submit once per turn via `submit_prototype`; report the PR link to the PM; never claim a merge happened; revisions = read feedback, re-submit (branch is force-updated).

### Message route / conversation loop (`lib/features/conversation.ts`)

- The planning implementation's "single pass + one continuation" generalizes into one bounded tool loop: execute tool_use blocks, append `tool_result`s, call again until `end_turn` or the iteration cap. Cap: **3** iterations in planning phase (preserves current behavior), **25** when prototyping tools are active.
- Tool set selection per request: planning tools always; when `feature.planning_phase !== 'planning'`, add `list_directory`, `read_file`, `submit_prototype`.
- History stays text-only; new markers: `[Inspected N files]`, `[Opened prototype PR: <url>]` (or `[Updated prototype PR]`).
- Route gains `export const maxDuration = 300`. Response shape unchanged (`{ content, applied }`); `applied` gains `prototypePrUrl: string | null`.

### Frontend (`ClaudePanel.tsx`, `page.tsx`)

- `Feature`/props gain `prototype_pr_url`; header shows a "Prototype PR ↗" link button when set.
- On `applied.prototypePrUrl`, call `onApplied()` (existing reload) and show a success toast with the link.
- Empty-state hint mentions the prototyping trigger once the phase is `approved`.

## Error handling

- Read tools: 404/oversize/API errors → `is_error` tool results; Claude adjusts course in-loop.
- `submit_prototype`: any GitHub step failing → `is_error` result with the failing step; no partial DB update (features row updated only after the PR exists).
- Missing `CODE_REPO`/`GITHUB_TOKEN` env → tools respond with a configuration error result so the PM sees a clear message in chat.
- Loop cap reached → the turn ends with whatever text Claude produced plus a `[Tool budget reached]` marker.
- Timeout risk: `maxDuration = 300`; prompt-side scope discipline; dedicated async route is the v2 escape hatch.

## Testing

- `tsc` + `next build`.
- Manual e2e (post-merge, migration 032 applied, `CODE_REPO` set): approve a small feature spec → "generate the prototype" in chat → verify branch `feature/uiux-<ticket>` off `develop` in app.viscap.ai, PR without auto-merge, PR link in chat + header button, phase flips to `prototyping`; then request a revision and verify the branch force-updates the same PR.

## Out of scope (v2 candidates)

- Vercel preview URL surfaced directly in pm-app (deployment-status endpoint or webhook).
- File deletions/renames in `submit_prototype`; multi-PR features; async/background generation; auto-populating `code_paths` from the design index.

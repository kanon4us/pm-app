# Assessment → Workflow Registry Sync

**Date:** 2026-07-05
**Status:** Approved (design)

## Problem

The `/workflows` page reads exclusively from the `workflows_registry` table. Assessments
identify affected workflows (the "AFFECTED WORKFLOWS" / `WORKFLOWS ✦` lists), but those are
persisted only as JSONB on `assessment_conversations.affected_workflows`. Nothing copies them
into `workflows_registry`, so workflows surfaced by an assessment never appear on `/workflows`.

### Root cause

Migration `025_workflows_registry.sql` performed a **one-time backfill**: it extracted workflows
from every existing `assessment_conversations.affected_workflows` row into `workflows_registry`
and linked them via the `assessment_workflows` junction table. There is no ongoing sync — every
assessment created *after* migration 025 (e.g. "Actor Avatar") leaves its workflows stranded in
JSONB.

## Solution

Add a per-workflow **Add / Update** control to the assessment UI so the PM can push a workflow
into `workflows_registry` on demand, reflecting real registry state (Add when absent, Update when
present).

### Backend

New endpoint: `POST /api/sprint/tasks/[id]/assess/[conversationId]/workflows`

Request body (a single workflow):

```json
{ "name": "Assign Actor Avatar to Idea", "sopImpacted": true, "educationImpacted": false, "scribehowImpacted": false }
```

Behavior:

1. Auth guard (session email required), consistent with sibling assess routes.
2. Validate `name` is a non-empty string.
3. Case-insensitively match `name` against `workflows_registry` (compare on `lower(trim(name))`;
   do **not** use `ilike`, whose `%`/`_` are wildcards).
4. **Not found** → insert `{ name, sop_impacted, education_impacted, scribehow_impacted }`.
   - On `23505` (unique-violation on `name`) — a concurrent create or an exact dup the
     case-insensitive lookup missed — re-select the row by name and fall through to the update
     path. This makes create race-safe using the existing `unique(name)` constraint, without a
     new `lower(name)` index or migration.
   - Otherwise → `action: "created"`.
5. **Found (or fell through from step 4)** → update that row's three impact flags using
   **OR-merge (union)** semantics: `sop_impacted = existing.sop_impacted || incoming.sopImpacted`
   (same for education/scribehow). Computed in JS from the already-fetched row — no RPC. An
   assessment can *set* an impact flag but never *clear* one another assessment set; clearing a
   flag remains the job of the manual `/workflows` editor. → `action: "updated"`.
6. Best-effort junction link: insert into `assessment_workflows`
   `(assessment_id = conversationId, workflow_id)`, ignoring `23505` on the pair. If this insert
   fails, log it but still return success — the `workflows_registry` row (the user's actual goal,
   and what `/workflows` reads) has already landed; the junction only powers the delete-guard.
7. Respond `{ workflow: { id, name, sop_impacted, education_impacted, scribehow_impacted }, action }`.

Idempotent: clicking twice on an absent workflow creates once then OR-merges; the junction link is
inserted at most once. No database migration required — `workflows_registry` and
`assessment_workflows` already exist (migration 025), and no true multi-statement transaction is
used (Supabase's JS client would require an RPC/function for that; the registry-first,
best-effort-junction ordering makes it unnecessary here).

### Frontend (`app/sprint/page.tsx`)

Two render sites list affected workflows; both get the control:

- Expanded run-history recap — the `WORKFLOWS` section (~line 1272).
- Live `scoring_review` panel — the `AFFECTED WORKFLOWS` section (~line 1633).

On load, fetch `/api/workflows?summary=true` once and build a case-insensitive set of registry
names (lower-cased, trimmed). The payload is `id, name` only for a small registry (dozens to low
hundreds of rows) — a few KB fetched once per page load. Per workflow row:

- Name **not** in the set → `[+ Add]` button.
- Name **in** the set → `[Update]` button plus a subtle "in registry" cue (distinct from the
  ✦/`proposed` tag, which is Claude's guess rather than ground truth).

On click, call the new endpoint with an **optimistic update**: immediately flip the row to the
post-action ("in registry" / Update) state and mark the name in-flight to block double-submits.
On success:

- `created` → keep the name in the local set; toast "Added to registry".
- `updated` → toast "Impact flags updated".

On error → revert the optimistic state (remove the name from the set if this click added it) and
surface via `message.error`. State is local to the sprint page: a `Set<string>` of registry names
plus a per-name in-flight flag. No new global/shared state.

## Testing

Endpoint unit tests (mirroring `__tests__/api/...` layout):

- Create path: absent name → inserts row, returns `action: "created"`.
- Update path: existing name → OR-merges impact flags, returns `action: "updated"`.
- OR-merge semantics: existing row `sop_impacted: true`, incoming `sopImpacted: false` → row stays
  `true` (union never clears a flag).
- Case-insensitive match: `"idea creation"` matches existing `"Idea Creation"` (updates, no dup row).
- Create race fallback: insert returns `23505` → re-selects by name and updates instead of erroring.
- Junction-link idempotency: second call for the same `(assessment, workflow)` pair does not error.
- Junction-link failure is non-fatal: a failing `assessment_workflows` insert still returns success
  with the workflow row.
- Auth guard: unauthenticated request → 401.
- Validation: missing/blank `name` → 400.

## Out of scope

- Bulk "add all" action (per-workflow only, by decision).
- Automatic sync on FVI confirm or bundle (explicit button, by decision).
- Backfilling assessments created between migration 025 and this change (the button handles them
  on demand).

## Deferred follow-ups

- **Server-side `inRegistry` annotation.** The frontend currently determines Add-vs-Update by
  fetching `/api/workflows?summary=true` and matching names client-side. If the registry grows
  large enough that this payload matters, move the check server-side: have the assess init/resume/
  history routes annotate each affected workflow with `inRegistry: boolean` (a join against
  `workflows_registry`), eliminating the client fetch and case-folding. Not worth the added
  route-coupling at current scale.

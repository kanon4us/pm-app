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
3. Case-insensitively match `name` against `workflows_registry` (trimmed).
4. **Not found** → insert `{ name, sop_impacted, education_impacted, scribehow_impacted }` →
   `action: "created"`.
5. **Found** → update that row's three impact flags → `action: "updated"`.
6. Ensure an `assessment_workflows` link exists for `(assessment_id = conversationId,
   workflow_id)`, idempotently (ignore unique-violation on the pair).
7. Respond `{ workflow: { id, name, sop_impacted, education_impacted, scribehow_impacted }, action }`.

Idempotent: clicking twice on an absent workflow creates once then updates; the junction link is
inserted at most once. No database migration required — `workflows_registry` and
`assessment_workflows` already exist (migration 025).

### Frontend (`app/sprint/page.tsx`)

Two render sites list affected workflows; both get the control:

- Expanded run-history recap — the `WORKFLOWS` section (~line 1272).
- Live `scoring_review` panel — the `AFFECTED WORKFLOWS` section (~line 1633).

On load, fetch `/api/workflows?summary=true` once and build a case-insensitive set of registry
names. Per workflow row:

- Name **not** in the set → `[+ Add]` button.
- Name **in** the set → `[Update]` button plus a subtle "in registry" cue (distinct from the
  ✦/`proposed` tag, which is Claude's guess rather than ground truth).

On click, call the new endpoint (per-workflow in-flight flag keyed by name). On success:

- `created` → add the name to the local set (row flips to Update state); toast "Added to registry".
- `updated` → toast "Impact flags updated".

Errors surface via `message.error`. State is local to the sprint page: a `Set<string>` of
registry names plus a per-name in-flight flag. No new global/shared state.

## Testing

Endpoint unit tests (mirroring `__tests__/api/...` layout):

- Create path: absent name → inserts row, returns `action: "created"`.
- Update path: existing name → updates impact flags, returns `action: "updated"`.
- Case-insensitive match: `"idea creation"` matches existing `"Idea Creation"` (updates, no dup row).
- Junction-link idempotency: second call for the same `(assessment, workflow)` pair does not error.
- Auth guard: unauthenticated request → 401.
- Validation: missing/blank `name` → 400.

## Out of scope

- Bulk "add all" action (per-workflow only, by decision).
- Automatic sync on FVI confirm or bundle (explicit button, by decision).
- Backfilling assessments created between migration 025 and this change (the button handles them
  on demand).

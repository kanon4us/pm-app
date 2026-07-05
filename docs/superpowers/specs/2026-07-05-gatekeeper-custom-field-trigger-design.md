# Prototype Gatekeeper — Custom-Field Trigger

**Date:** 2026-07-05
**Status:** Approved (design), pending implementation plan
**Supersedes:** the status/tag trigger from `2026-07-03-clickup-gatekeeper-design.md`

## Problem

The prototyping gatekeeper (`lib/features/gatekeeper.ts` → `activateFeatureFromTask`)
scaffolds/enriches a feature and routes its app when a ClickUp task is flagged
"ready to prototype". The v1 trigger fired on `CLICKUP_PROTOTYPE_STATUSES` (a
ClickUp *status*) or the `proto-ready` *tag*.

Live-testing against **DEV-13024** (2026-07-05) showed this doesn't match how the
PM actually flags work:

- The PM signals prototype-readiness via **custom fields**, not status/tag:
  `Design states = "In progress"` **and** a `Figma` link present.
- The task sat at status `ui/ux` with no tags, so the gatekeeper never fired
  (verified: zero `[gatekeeper]` log lines in prod; the core enrich logic itself
  works — invoking `activateFeatureFromTask` directly enriched the feature with
  `fvi_score` + `clickup_details`).
- The live prod webhook is subscribed to `taskStatusUpdated` **only**, so even the
  tag path was dead.
- App routing fell back to the `web` default because the list has no
  `repo_registry_id` link and the task had no tag — but the task *does* carry a
  `Relevant App` label field we can route from.

## Goal

Replace the status/tag trigger with a **custom-field trigger**, subscribe to the
event that carries custom-field edits, and route the app from the `Relevant App`
field. No schema migration required.

## The duplicate-field trap (correctness-critical)

DEV-13024 carries **two** `Design states` drop_down fields with *different* option
orderings:

| Field id | orderindex ordering |
|---|---|
| `257f5e07-…` (populated, value `2`) | Approved=0, Done=1, **In progress=2**, Took it=3, Waiting=4 |
| `22a512ed-…` (empty) | Took it=0, **In progress=1**, Done=2, Waiting=3 |

The raw value `2` means "In progress" in the first field but "Done" in the second.
**Never compare the raw numeric value.** Resolve each field's value to its option
*label* via that field's own `type_config.options`, then compare labels. The
trigger is satisfied when **any** field named `Design states` resolves to the
label `In progress` (case-insensitive).

ClickUp drop_down `value` is the option `orderindex`, but resolution must also
accept an option `id` match (be liberal): `options.find(o => o.orderindex === value || o.id === value)`.

## Trigger model (replaces status + tag)

The gatekeeper fires on a ClickUp **`taskUpdated`** event when the re-fetched task
satisfies BOTH:

1. Some `Design states` field resolves to label `In progress` (case-insensitive), AND
2. The `Figma` field is non-empty and its value contains `figma.com`.

Retire the status path (`CLICKUP_PROTOTYPE_STATUSES`, `isPrototypeStatus`) and the
tag path (`CLICKUP_PROTOTYPE_TAG`, `hasPrototypeTag`) from the webhook route.
Those helpers may be deleted or left unused; the route no longer calls them.

New pure predicate in `lib/features/gatekeeper-extract.ts`:

```ts
// true when task is prototype-ready by custom fields
export function isPrototypeReady(fields: ClickUpCustomField[]): boolean
```

- `Design states` check: any field named "design states" whose resolved option
  label === "in progress".
- `Figma` check: a field named "figma" whose string value includes "figma.com".

## Event subscription

Add `taskUpdated` to the event set in `lib/clickup/client.ts` `createWebhook`
(currently `['taskStatusUpdated','taskMoved','taskTagUpdated']`). Custom-field
edits arrive via `taskUpdated`.

**Ops:** the live prod webhook predates this and only has `taskStatusUpdated`.
One `POST /api/lists/resubscribe` pass (per team) is required after deploy so the
webhook re-registers with the expanded event set. (This is the same resubscribe
the tag path always needed.)

## Handler wiring + noise filter

`taskUpdated` fires on *every* task edit. Fetching the task on each one would hit
the ClickUp API for unrelated changes. Pre-filter on the event payload before
fetching:

1. `parseWebhookEvent` handles `taskUpdated`: return
   `{ taskId, type: 'taskUpdated', toStatus: '', changedFieldNames: string[] }`
   where `changedFieldNames` is collected from **all** `history_items`
   (ClickUp batches updates — use `.some()`/`.flatMap()` across the whole array,
   never index 0) reading each item's `field === 'custom_field'` →
   `custom_field.name`.
2. Route: on `taskUpdated`, proceed only if `changedFieldNames` intersects
   `['Design states','Figma']` (case-insensitive). Then `getTask`, evaluate
   `isPrototypeReady(fields)`, and call `activateFeatureFromTask` if true.
3. `taskUpdated` carries no status — it must **early-return** after the gatekeeper
   block (like `taskTagUpdated` already does), so it never falls through into the
   `taskStatusUpdated`-specific handling below.

This makes the gatekeeper fire (roughly) on *transition into* the ready state
rather than on every edit, while staying idempotent.

Scope note: v1 triggers on `taskUpdated` only. A task *created* already-ready is a
rare edge case (the PM edits fields on an existing task) and is deferred.

## App routing via `Relevant App`

`resolveAppIdentity` gains a first-priority source: the `Relevant App` labels
field. Its value is an array of option ids; resolve id → option label → app slug:

| Relevant App label | app slug |
|---|---|
| Web | `web` |
| iOS | `mobile` |
| Android | `mobile` |
| Mac | `desktop` *(slated for retirement — web + mobile are the near-term apps)* |
| Win | `desktop` *(slated for retirement)* |

Take the first resolvable label (single-select in practice). Precedence:

```
Relevant App field  →  tag  →  list repo_registry  →  web (default)
```

The existing guard stays: only (re)route while `planning_phase === 'planning'`,
so a PM's manual app choice after planning is never clobbered.

## Idempotency / re-fire

No new state. `activateFeatureFromTask` already dedupes via `feature_tasks`,
overwrites enrichment fields with the same values, and guards app re-routing to
the planning phase. Repeated qualifying `taskUpdated` events simply keep the
feature's enrichment fresh — safe.

## Testing (pure unit tests)

- `isPrototypeReady`:
  - In progress + figma.com link → true
  - In progress + no Figma → false
  - Figma present but non-figma URL → false
  - Other design state (Done/Waiting) + figma → false
  - **Duplicate `Design states` fields, only the first resolving to "In progress" → true**
  - value matched by `orderindex` and by option `id`
- `resolveAppIdentity` with `Relevant App`: Web→web, iOS→mobile, Android→mobile,
  Mac→desktop; Relevant App wins over tag and list; unresolvable label → falls
  through to existing precedence.
- Figma URL detection helper: figma.com present/absent, empty/undefined.
- `parseWebhookEvent`: `taskUpdated` collects changed custom-field names across
  multiple `history_items` (batched-update case).

## Out of scope (separate follow-ups)

- **Objectives extraction** — `objectives` came back null because the real data
  lives in `Obj #1…#7` + `Obj #N Notes` + `ObjTotal` fields, not an "Objectives"
  field. Rework `extractObjectives` in its own spec.
- **design-index-sync cron 405** — unrelated regression found during
  investigation (route exports `POST`, Vercel Cron sends `GET`). Handled in a
  separate PR/session; this rework must not touch that route.

## Ops checklist

1. Merge + deploy (no migration).
2. `POST /api/lists/resubscribe` once per team (re-registers webhook with
   `taskUpdated`).
3. Live-test: set a ticket's `Design states` → "In progress" with a Figma link;
   confirm the feature appears enriched and app-routed from `Relevant App`.

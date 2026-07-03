# ClickUp Prototyping Gatekeeper — Design

**Date:** 2026-07-03
**Status:** Spec'd by PM (detailed requirements provided), implemented same-day
**Depends on:** Multi-app router (PR #26, `features.app` + `APP_REGISTRY`)

## Goal

Move from indiscriminate task sync to a **gatekeeper**: a ClickUp task flagged "Ready for Prototyping" automatically becomes (or enriches) a pm-app feature — deep metadata pulled from ClickUp, app identity routed per PR #26 — so the PM opens the Feature Editor to a pre-briefed planning session with zero manual configuration.

## Trigger (gatekeeper)

- **Primary — status:** `taskStatusUpdated` where the new status ∈ `CLICKUP_PROTOTYPE_STATUSES` (env, comma-separated, case-insensitive; e.g. `ready for prototype`). Same proven pattern as `CLICKUP_DESIGN_INDEX_STATUSES`.
- **Secondary — tag:** `taskTagUpdated` where the task's tags include `CLICKUP_PROTOTYPE_TAG` (default `proto-ready`).
- **Webhook registration:** `createWebhook` events extended to `['taskStatusUpdated','taskMoved','taskTagUpdated']`. Status triggering works with already-registered webhooks; **tag triggering requires one pass of the existing lists resubscribe route** to re-register. Signature verification (HMAC, `CLICKUP_WEBHOOK_SECRET`) and the trigger_configs/design-index/Slack-handoff paths are untouched; the gatekeeper runs independently and its failures are logged, never thrown.

## Enrichment (one getTask call)

| Feature column | Source (layered) |
|---|---|
| `clickup_details` | Full task description markdown |
| `objectives` | `Objectives`/`Goals` custom field → else the section under an Objectives/Goals heading in the description (md `#` headings, `**bold**` pseudo-headings, or `Objectives:` lines, up to the next heading) |
| `fvi_score` | `FVI*` custom field (number or numeric string) → else the assessment pipeline's `tasks.fvi_score` |
| `description` | First paragraph of the ClickUp description (≤500 chars) — the human-readable summary in lists |
| `app` | See routing below |

Injected into `buildFeatureContext` (`FVI score:`, `--- Objectives ---`, `--- ClickUp Task Details ---` truncated at 6K chars) so planning starts pre-briefed.

## App-identity routing

Layered resolution (`resolveAppIdentity`):
1. **Tag** — `app:<slug>`, bare slug, or alias (`mobile-app`→mobile, `education-cms`/`cms`→cms, `desktop-app`→desktop, `web-app`→web)
2. **List's repo** — `lists.repo_registry_id` → `repo_registry.github_repo_full_name` matched against `APP_REGISTRY[].repo`
3. **Default** `web`

Guardrail: re-triggers update `app` only while `planning_phase === 'planning'` — auto-routing never clobbers a manual choice after planning is underway.

## Idempotency / dedup

- Feature identity = `feature_tasks` link. Re-trigger (ClickUp retries, repeated transitions) → find-and-enrich, never duplicate.
- Missing local task rows are auto-imported (same behavior as the existing webhook paths); missing list rows degrade to feature-without-task-link (enrichment still lands).
- `feature_tasks` unique violation (23505) tolerated.

## Files

- `supabase/migrations/034_enrich_feature_metadata.sql` — `fvi_score` (double precision), `objectives`, `clickup_details` on `features`. **Manual prod apply before/with merge.**
- `lib/features/gatekeeper-extract.ts` — pure parsing/mapping utils (unit-tested: 14 cases in `__tests__/lib/gatekeeper-extract.test.ts`).
- `lib/features/gatekeeper.ts` — `activateFeatureFromTask`: getTask → enrich → find-or-scaffold → route.
- `app/api/webhooks/clickup/route.ts` — gatekeeper block after the design-index hook; early return for tag events.
- `lib/clickup/webhook.ts` — `taskTagUpdated` parsing. `lib/clickup/client.ts` — `tags` on ClickUpTask, expanded webhook events.
- `lib/features/context.ts` — enrichment block in the prompt context.

## Ops checklist

1. Apply migration 034 (manual, before/with merge).
2. Set `CLICKUP_PROTOTYPE_STATUSES` (e.g. `ready for prototype`) — and optionally `CLICKUP_PROTOTYPE_TAG` — in Vercel prod.
3. For tag triggering: run the lists resubscribe flow once so webhooks include `taskTagUpdated`.
4. Optional but recommended: set `lists.repo_registry_id` on app-specific lists (or use tags) so routing beats the `web` default.

## Out of scope

Posting the Feature Editor link back to the ClickUp task (comment/custom field); seeding `code_paths` from ClickUp; Slack notification on activation; UI surface for the enrichment fields beyond the prompt context.

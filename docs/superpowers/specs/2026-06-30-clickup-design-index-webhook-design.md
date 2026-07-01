# ClickUp → Design-Index Webhook (Auto-Scaffold Subsystem)

**Date:** 2026-06-30
**Status:** Design (pending spec review)
**Owner:** Michael Terry (PM)
**Designer/Developer:** Claude
**Parent spec:** `docs/superpowers/specs/2026-06-29-figma-claude-design-pipeline-design.md` (§11.3)

---

## 1. Context & Problem

The Figma→GitHub migration (subsystem #2) left every design-index entry in
`design/figma-index.pending.json` (41 entries) because no Figma page carried a
real ClickUp ID — the previous designer never used them. `figma-index.json` (the
live, CI-guarded index) is therefore empty of features. Nothing populates it until
features acquire real ClickUp IDs.

This subsystem closes that gap: **when a ClickUp ticket enters an "in progress"
status, a webhook scaffolds/promotes the matching design-index entry with the
ticket's real `clickupId`**, draining the pending backlog automatically as work
starts. It extends the existing ClickUp webhook (`app/api/webhooks/clickup/`),
ClickUp client, and Supabase infrastructure rather than introducing new patterns.

**Hard constraint:** the webhook is a serverless Vercel function with no git
checkout, and the architecture mandates **GitHub `main` as the ultimate source of
truth** for the index (a git-tracked file). So the webhook cannot write the JSON
directly; the write path must round-trip through git.

## 2. Goals

- Turn an "in progress" ClickUp transition into a real `clickupId` on the correct
  design-index entry, with no manual step.
- Keep git as the source of truth; the DB is a transient inbox, never a parallel index.
- Drain the 41-entry backlog by matching tickets to existing pending entries.
- Decouple ticket assignment from code-path availability (a ticket can promote an
  entry's `clickupId` even before its `codePaths` exist).
- Reuse existing webhook, ClickUp client, Figma-field detection, GitHub, and CI infra.

## 3. Non-Goals

- Authoring Figma canvas (out of scope project-wide).
- Building a ClickUp-side automation UI (ClickUp's native webhook config is used).
- Assigning `codePaths` automatically (devs do that; entries pend until paths exist).
- Replacing the migration seed tooling (`figma:seed`); this is the incremental,
  event-driven complement.

## 4. Architecture & Data Flow

Three units, each with one responsibility:

1. **Webhook extension** (thin) — in the existing `taskStatusUpdated` branch of
   `app/api/webhooks/clickup/route.ts`. When `toStatus` ∈
   `CLICKUP_DESIGN_INDEX_STATUSES`, extract the ticket's Figma URL via the existing
   FVI Figma-field detection and **upsert one `design_index_inbox` row**
   (`clickup_task_id` unique). Returns 200 immediately — no GitHub work in the
   request path.
2. **Cron processor** (thin I/O shell) — `app/api/cron/design-index-sync/route.ts`,
   added to `vercel.json` crons. Reads unprocessed inbox rows, reads the current
   `figma-index.json` + `figma-index.pending.json` from GitHub, runs the pure core,
   force-updates a single rolling branch `design-index-sync`, ensures one open PR
   with **auto-merge** enabled, and marks rows processed.
3. **Pure core** — `lib/design-index/inbox.ts`,
   `applyInboxToIndex(index, pending, inboxRows, ctx) → { index, pending, results }`.
   No I/O; all external facts (`pathExists`) injected. Fully fixture-tested.

```
ClickUp "in progress" status
  │  taskStatusUpdated webhook (signature-verified)
  ▼
design_index_inbox   ← upsert by clickup_task_id  → 200 OK (fast)
  │
  ▼  Vercel cron (batched)
applyInboxToIndex(index, pending, rows, {pathExists})   ← pure, tested
  │
  ▼
GitHub: force-update branch `design-index-sync` → one open PR
  │  design-index CI guard (validate-design-index)
  ▼  auto-merge on green
figma-index.json / figma-index.pending.json on main
```

**Reused as-is:** `verifyClickUpSignature`, `parseWebhookEvent`,
`buildClickUpClient`, FVI Figma-field detection, `parseFigmaUrl`, the design-index
types + `validateDesignIndex`, `lib/github/{repos,vault}.ts`, the existing
cron-secret gate, and the `design-index-validate` CI workflow.

## 5. Matching & Promotion Model (`applyInboxToIndex`)

**Granularity:** a ticket is a **user story** (one `clickupId`); a pending entry is
a **feature-file** (keyed by `figmaFileKey`). Tickets match files; the ticket
supplies the real `clickupId` and, if the Figma link is deep, a page `nodeId`.

**Match key:** `parseFigmaUrl(figma_url) → { fileKey, nodeId? }`, compared against
`pending[].partial.figmaFileKey` and `index.features[].figmaFileKey`.

**Dual-gate progression** — a feature reaches the live index only when **both**
gates pass: (G1) a real `clickupId` is assigned, and (G2) all `codePaths` exist on
disk (`ctx.pathExists`). The two gates are independent, which is what decouples
ticket assignment from directory availability.

**Three outcomes per inbox row:**

1. **Match → promote to reconciled** (G1 ✓ via ticket, G2 ✓): build a full
   `Feature` with user story `{ clickupId, title, status: 'in-design',
   figmaPageNodeId: nodeId ?? existing, sourceOfTruthNodeId, sandboxNodeId }`
   (node fields default to `nodeId` when only one is known, matching the seed
   convention), move into `figma-index.json`, remove from pending.
2. **Match → promote but still pending** (G1 ✓, G2 ✗): record `assignedClickupId`
   + `title` + `figmaNodeId` on the pending entry and **clear the
   `placeholder-clickup` reason**; it now pends only on `unassigned-codepaths`.
3. **No match → new stub** (no `fileKey` match, or no Figma link): create a pending
   entry `featureId: 'ticket-<clickupId>'`, `partial` with any Figma refs +
   `codePaths: []`, reasons `['unassigned-codepaths']` (+ `'unassigned-figma'` if
   no link), `assignedClickupId`/`title` recorded.

**Built-in re-evaluation:** every run also re-checks **existing** pending entries
that already have an `assignedClickupId` against current `codePaths` (G2). Entries
auto-promote to reconciled (outcome 1) as devs build the features — no new ticket
required. This is the mechanism by which case-2 entries eventually go live.

**Data-model enrichment:** `PendingEntry` (in `lib/design-migration/types.ts`)
gains optional `assignedClickupId?: string`, `title?: string`,
`figmaNodeId?: string` so a recorded-but-not-yet-reconciled promotion is durable.
`PendingReason` gains `'unassigned-figma'`.

**Idempotency:** if a `clickupId` is already present on any feature (reconciled) or
recorded on any pending entry, the row is a no-op. Re-firing a ticket, or re-running
the cron over the same inbox, converges to identical output.

## 6. Schema & Environment

**Migration `030_design_index_inbox.sql`:**

```sql
create table design_index_inbox (
  id              uuid primary key default gen_random_uuid(),
  clickup_task_id text not null unique,        -- upsert key (dedup on re-fire)
  title           text not null,
  figma_url       text,                         -- null → new-stub path
  trigger_status  text not null,                -- the toStatus that fired it
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  processed_at    timestamptz,                  -- null = unprocessed
  last_error      text                          -- retry visibility
);
create index design_index_inbox_unprocessed
  on design_index_inbox (created_at) where processed_at is null;
alter table design_index_inbox enable row level security;
-- no policies → service-role only (webhook + cron use the service client)
```

⚠️ **Deploy ordering (manual prod migrations, per `project_migration_deploy_ordering`):**
apply `030` to prod **before** deploying the webhook code that writes to it, or
In-Progress events 500 on a missing table. Regenerate Supabase types after applying.

**Environment status parsing:**
- `CLICKUP_DESIGN_INDEX_STATUSES` — comma-separated status names, lowercased and
  trimmed at load (e.g. `"in progress,in design"`). The webhook fires the scaffold
  when `event.toStatus.toLowerCase().trim()` is in the parsed set. Empty/unset →
  subsystem inert (no inbox writes), so it ships dark until configured.
- Reused: GitHub token/repo + `CRON_SECRET` (already present for the vault crons).

## 7. Error Handling & Idempotency (edge cases)

| Case | Behavior |
|------|----------|
| No Figma field / unparseable URL | inbox row with `figma_url=null` → new-stub path; webhook still 200 |
| Invalid webhook signature | 401 (existing `verifyClickUpSignature`) |
| Status not in env set | no-op; no inbox write |
| Ticket re-fires same status | upsert by `clickup_task_id` updates the row, never duplicates |
| Cron: GitHub read/PR failure | rows stay `processed_at=null`, `last_error` set → retried next run |
| Cron: empty unprocessed set | no-op, no PR opened |
| Cron crash mid-run | rolling branch force-updated to deterministic state; re-run converges (idempotent core) |
| Concurrent cron runs | single rolling branch + cron-secret gate; deterministic force-update is conflict-free |
| CI red on the PR | auto-merge holds; PR stays open for human triage; rows already marked processed (captured in PR) |
| `clickupId` already assigned | core no-op |

## 8. Testing

**`applyInboxToIndex` — the pure core (primary coverage), injected `pathExists`:**
- promote → reconciled (match + paths exist)
- promote → still pending (match + paths missing): `assignedClickupId` recorded,
  `placeholder-clickup` cleared, `unassigned-codepaths` retained
- new stub, no match (with Figma link)
- new stub, no Figma link → `unassigned-figma` reason
- **re-evaluation**: pending entry with `assignedClickupId` whose `codePaths` now
  exist → promoted with no new inbox row
- idempotent re-apply (same rows twice → identical output)
- duplicate `clickupId` already in index → no-op
- reuse `validateDesignIndex` to assert every promoted reconciled entry is schema-valid

**Webhook handler:** In-Progress status + Figma field → exactly one inbox upsert
(mocked Supabase); non-matching status → no upsert; missing Figma field → row with
`figma_url=null`.

**Status parsing / Figma-field extraction:** unit-tested against sample ClickUp
`taskStatusUpdated` payloads (status casing/whitespace; custom-field shapes).

**Cron route:** thin shell — smoke test orchestration with mocked GitHub +
Supabase; all branching logic lives in the tested core.

## 9. Success Criteria

- Moving a ticket to "in progress" results, within one cron cycle, in its real
  `clickupId` recorded on the matching design-index entry (promoted or stub).
- Backlog entries with existing `codePaths` reach `figma-index.json` automatically;
  those without stay in pending with the placeholder reason cleared.
- The CI guard stays green; the live index never contains an entry lacking a real
  `clickupId` or existing `codePaths`.
- No duplicate entries across re-fires or cron re-runs.
- Subsystem is inert until `CLICKUP_DESIGN_INDEX_STATUSES` is set (safe dark ship).

## 10. Open Questions (for implementation planning)

- Exact ClickUp custom-field key/id for the Figma link (confirm against the FVI
  detection already in the codebase; whether it arrives in the webhook payload or
  needs a `getTask` fetch).
- Cron cadence (e.g. every 10–15 min vs hourly) — tune against ClickUp activity.
- Whether promoted `index` features should also write back the real `clickupId`
  into the Figma page name (`US-#### · …`) via a later plugin-bridge step, or remain
  code-side only (likely a separate subsystem).

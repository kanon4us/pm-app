# Reporter Ticket History on New Tickets

**Date:** 2026-06-19
**Status:** Approved design — ready for implementation plan

## Goal

When a team member opens a new support ticket, the bot recalls that person's
previous tickets and uses them in three ways:

1. **Show in the thread** — surface the reporter's open + recently-closed tickets
   as context for whoever picks up the new ticket.
2. **Feed dedup/triage** — give the triage step the reporter's recently *closed*
   tickets so a re-report of an already-resolved issue can be matched (the
   existing list-based search cannot see closed tickets).
3. **Set `is_repeat_issue`** — deterministically flag the new ticket as a repeat
   when triage matches it to one of the reporter's own prior tickets.

Identity is keyed on the Slack `reporter_id` (stable user id).

## Background / current state

- Tickets are persisted in `slack_issues`, one row per Slack thread, with
  `reporter_id`, `ticket_data` (includes `issue_summary`, `is_repeat_issue`),
  `clickup_task_id`, and `updated_at`.
- ClickUp task lifecycle status is **not** in `slack_issues.status` (that field
  tracks intake state: `gathering`/`confirming`/`triaging`/`complete`/...).
  The ClickUp status is mirrored in the local `tasks` table
  (`clickup_task_id`, `status`, `is_archived`, `synced_at`), kept in sync by the
  ClickUp webhook on `taskStatusUpdated`.
- **Closed** = ClickUp status `DONE`, `DEPLOYED`, or `ARCHIVE`. All other
  statuses are active/open.
- `detectDuplicate()` (`lib/issue-triage/duplicate-detection.ts`) already searches
  the **New Tickets, Known Issues, Needs Tutorial, and Planning** lists. The
  reporter's open tickets normally live in those lists, so they are already in
  the dedup candidate set. Closed tickets are not in any of those lists — that is
  the gap this feature closes.

## Scope

- "All open + recently closed" per reporter. **Open**: keep all. **Closed**: only
  those closed within the last 30 days. The `slack_issues` fetch is bounded by
  `FETCH_LIMIT` as a safety valve.
- Thread display reserves slots (up to 5 open + 3 closed) so resolutions aren't
  buried, with a per-group "+N open, +M closed not shown" trailer; the triage
  prompt feed is uncapped (closed-only, expected to be small).

## Architecture

### New module: `lib/issue-triage/reporter-history.ts`

Single responsibility: given a `reporter_id`, return their open + recently-closed
tickets, plus formatters. Mirrors the factoring of `duplicate-detection.ts` and
`stale-nudge.ts`. Independently unit-testable.

```ts
export interface ReporterTicket {
  threadTs: string
  clickupTaskId: string
  summary: string          // ticket_data.issue_summary
  state: 'open' | 'closed'
  clickupStatus: string    // raw status from tasks table; '' if unknown
  closedAt: string | null  // tasks.synced_at, for closed tickets only
  clickupUrl: string       // https://app.clickup.com/t/<clickupTaskId>
}

const CLOSED_STATUSES = new Set(['DONE', 'DEPLOYED', 'ARCHIVE'])
const CLOSED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const FETCH_LIMIT = 100         // safety valve against noisy service accounts
const THREAD_OPEN_SLOTS = 5     // display budget split (5 open + 3 closed = 8)
const THREAD_CLOSED_SLOTS = 3

// Pulls all OPEN + CLOSED-within-30-days tickets for this reporter.
export async function fetchReporterHistory(
  supabase: SupabaseServiceClient,
  reporterId: string,
  excludeThreadTs: string,
): Promise<ReporterTicket[]>

// Slack mrkdwn for the thread reply. null if there is nothing to show.
// Reserves slots (THREAD_OPEN_SLOTS open + THREAD_CLOSED_SLOTS closed) so recent
// resolutions are never buried under a wall of open tickets. Escapes summaries
// for mrkdwn. Trailer reports per-group hidden counts.
export function formatHistoryForThread(tickets: ReporterTicket[]): string | null

// Compact prompt text of the reporter's CLOSED tickets only (the gap the
// list-based dedup search misses). Returns '' when there are no closed tickets.
export function formatHistoryForTriage(tickets: ReporterTicket[]): string
```

### Open/closed classification (`fetchReporterHistory`)

Two queries with an in-memory join (deliberately not a single PostgREST embedded
join — see "Query approach" below):

1. Query `slack_issues` for `reporter_id = X`, `thread_ts != excludeThreadTs`,
   `clickup_task_id not null`. Select `thread_ts, clickup_task_id, ticket_data,
   updated_at`. `.order('updated_at', { ascending: false }).limit(FETCH_LIMIT)`.
2. Query `tasks` for `clickup_task_id in (...)` → `status, is_archived, synced_at`.
3. Join in memory. A ticket is **closed** when
   `is_archived === true` OR `status.toUpperCase()` ∈ `CLOSED_STATUSES`.
   Otherwise **open** — *including task ids absent from `tasks`* (a never-moved
   ticket is still active).
4. Keep all open tickets. Keep closed tickets only where
   `synced_at >= now - CLOSED_WINDOW_MS`.
5. Order: open first (by `slack_issues.updated_at` desc), then recent closed
   (by `synced_at` desc).

#### Query approach: why two queries, not an embedded join

A single PostgREST `tasks!inner(...)` embedded join would drop reporter tickets
that have **no** `tasks` row — but those must be classified *open* (a freshly
bot-created ticket has no `tasks` row until it first moves or changes status; see
the ClickUp webhook). A left embed avoids the drop but makes the
"open (non-closed status *or* no task row) OR closed-within-30-days" predicate
fragile to express as one declarative filter. Two queries are correct and
readable; realistic per-reporter volume is tens of rows, and `FETCH_LIMIT` caps
the pathological tail.

#### Indexing

- Add `CREATE INDEX idx_slack_issues_reporter_id ON slack_issues(reporter_id);`
  (new migration). The primary lookup is `WHERE reporter_id = X`; `slack_issues`
  currently indexes only `status` and `updated_at`.
- `tasks.clickup_task_id` is already `UNIQUE NOT NULL` (migration 001), so the
  `IN (...)` lookup is already index-backed — no migration needed.
- Per repo convention, the new index migration is applied to prod **manually**,
  separate from the code deploy. It is non-breaking (the feature works without it,
  just with a seq scan), so deploy ordering is low-risk.

### Wiring into `handleNewIssue` (`app/api/webhooks/slack/route.ts`)

Fetch history once, by `event.user`, after the new `slack_issues` row is inserted
(so the current thread already exists and is excluded by `thread_ts`).

**Execution order.** `fetchReporterHistory` must complete *before* triage, because
triage consumes the closed subset. It does **not** need to block on the
reporter-profile / media work, so run it concurrently with those:

| Step | Action | Notes |
| --- | --- | --- |
| 1 | Insert new `slack_issues` row | Establishes current `thread_ts` (excluded from history). |
| 2 | `Promise.all`: `fetchReporterHistory` ‖ reporter-profile ‖ media processing | History fetch is a fast DB read; parallel with the other enrichment, **not** with triage. |
| 3 | Run `detectDuplicate(ticketData, excludeTaskId, closedHistory)` | Inject the closed subset (step 2 output) into the triage prompt. |
| 4 | Run intake turn; persist `updated_schema` with `is_repeat_issue` override | Override applied last so the intake model cannot clobber it. |
| 5 | Post Slack reply with `formatHistoryForThread` block appended | Both `devAlreadyReplied` and normal branches. |

- **Show in thread** — if `formatHistoryForThread(history)` is non-null, append a
  section block to the bot's reply in *both* the `devAlreadyReplied` and normal
  branches:

  > 📋 *Earlier from <@reporter>:*
  > • Active — _summary_ (link)
  > • ✅ DONE 3d ago — _summary_ (link)
  > _+2 open, +1 closed not shown_

- **Feed dedup/triage** — extend `detectDuplicate(ticketData, excludeTaskId,
  reporterClosedHistory?)`. When closed history is present, append the block below
  to the triage user-turn so a re-report of a closed ticket can be matched. Open
  tickets are intentionally not fed — they are already in the searched lists.

  ```
  This reporter has these RECENTLY RESOLVED tickets (already closed; NOT in the
  active list above). If the new ticket is the same underlying issue as one of
  these, treat it as a duplicate and return that ClickUp id — a resolved bug
  resurfacing is a high-signal duplicate.
  [<clickupTaskId>] (DONE 3d ago) <summary>
  [<clickupTaskId>] (DEPLOYED 12d ago) <summary>
  ```

  The existing duplicate-confidence thresholds still gate the decision; this block
  only widens the candidate set, it does not lower the bar.

- **Set `is_repeat_issue`** — after triage, if `triageResult.duplicate_task_id`
  equals one of the reporter's own history `clickupTaskId`s (open *or* closed), set
  `ticket_data.is_repeat_issue = true`. Apply as a final override when persisting
  the intake's `updated_schema`, so the intake model cannot clobber it.

## Error handling

- No history → omit the thread section, pass nothing to triage, leave
  `is_repeat_issue` untouched.
- `fetchReporterHistory` / `tasks` query failure → `console.warn` and continue.
  History is enrichment, never fatal to ticket creation (matches existing
  media/triage/intake error handling in `handleNewIssue`).
- Missing `tasks` rows are treated as open, **silently** — no warning/metric. A
  missing row is the *normal* state for a recently created ticket that has not yet
  moved or changed status (the `tasks` mirror is written only by the ClickUp
  webhook on `taskMoved`/`taskStatusUpdated`, or by list (re)subscribe). Warning on
  it would fire on most recent tickets and bury real signal.

## Testing

`__tests__/lib/issue-triage/reporter-history.test.ts`, mocked Supabase client:

- Classification: each of `DONE` / `DEPLOYED` / `ARCHIVE`, `is_archived === true`,
  and case-insensitivity (`done`, `Deployed`).
- 30-day closed boundary (closed 29d ago kept; 31d ago dropped).
- Task id absent from `tasks` → classified open.
- Current thread excluded.
- Ordering: open-before-closed, recency within each group.
- `FETCH_LIMIT` cap is requested on the `slack_issues` query.
- `formatHistoryForThread`: empty → null; slot reservation (≥6 open + ≥4 closed →
  5 open + 3 closed shown with `+N open, +M closed not shown` trailer); mrkdwn
  escaping (`<`/`>`/`&` in a summary).
- `formatHistoryForTriage`: closed-only, empty closed → ''.

## Out of scope (YAGNI)

- On-request ("what have I submitted?") and button-triggered recall — auto-on-new
  only.
- Cross-identity matching (affected_user_email, multiple Slack accounts).
- Backfilling `tasks` status for tickets that predate webhook sync.

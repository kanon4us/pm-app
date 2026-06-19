# Reporter Ticket History on New Tickets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a team member opens a new support ticket, the bot recalls their open + recently-closed tickets to (1) show context in the thread, (2) feed recently-closed tickets into dedup/triage, and (3) deterministically flag `is_repeat_issue`.

**Architecture:** A new pure-ish module `lib/issue-triage/reporter-history.ts` reads `slack_issues` (by `reporter_id`) joined in memory with the local `tasks` status mirror to classify open vs closed. `handleNewIssue` calls it once (in parallel with the reporter-profile/media work), then routes the result to three consumers. `detectDuplicate` gains an optional closed-history string injected into the triage prompt.

**Tech Stack:** Next.js (App Router) route handler, Supabase (PostgREST) service client, Anthropic SDK (existing triage call), Jest + ts-jest.

**Spec:** `docs/superpowers/specs/2026-06-19-reporter-ticket-history-design.md`

---

## File Structure

- **Create** `supabase/migrations/029_slack_issues_reporter_id_index.sql` — index for the `reporter_id` lookup.
- **Create** `lib/issue-triage/reporter-history.ts` — `ReporterTicket`, `fetchReporterHistory`, `formatHistoryForThread`, `formatHistoryForTriage`, and private helpers.
- **Create** `__tests__/lib/issue-triage/reporter-history.test.ts` — unit tests (fake supabase + pure formatters).
- **Modify** `lib/issue-triage/duplicate-detection.ts:41` — add optional `reporterClosedHistory` param.
- **Modify** `app/api/webhooks/slack/route.ts` — wire history into `handleNewIssue` (imports, parallel fetch, triage feed, `is_repeat_issue` override, thread display in both reply branches).

---

## Task 1: Migration — index `slack_issues(reporter_id)`

**Files:**
- Create: `supabase/migrations/029_slack_issues_reporter_id_index.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 029_slack_issues_reporter_id_index.sql
-- Reporter ticket history looks up slack_issues by reporter_id. The table
-- previously indexed only status and updated_at (see 010_slack_issues.sql).
-- Non-breaking; apply to prod manually per repo convention.
CREATE INDEX IF NOT EXISTS idx_slack_issues_reporter_id
  ON slack_issues (reporter_id);
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/029_slack_issues_reporter_id_index.sql
git commit -m "feat(support-bot): index slack_issues.reporter_id for ticket history"
```

> **Prod note:** This migration is applied to prod manually, separate from the code deploy. It is non-breaking (the feature works without it, just slower), so it can land before or after the code.

---

## Task 2: `reporter-history.ts` — types + `fetchReporterHistory`

**Files:**
- Create: `lib/issue-triage/reporter-history.ts`
- Test: `__tests__/lib/issue-triage/reporter-history.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/lib/issue-triage/reporter-history.test.ts`:

```ts
import { fetchReporterHistory } from '@/lib/issue-triage/reporter-history'

// Minimal chainable fake of the Supabase query builder. Each `.from(table)`
// returns a builder whose terminal `await` resolves to { data } for that table.
function makeSupabase(tables: Record<string, unknown[]>) {
  return {
    from(table: string) {
      const result = { data: tables[table] ?? [], error: null }
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        neq: () => builder,
        not: () => builder,
        in: () => builder,
        order: () => builder,
        limit: () => Promise.resolve(result),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
      }
      return builder
    },
  } as any
}

const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()

function issue(over: Partial<Record<string, unknown>>) {
  return {
    thread_ts: '111.1',
    clickup_task_id: 'T1',
    ticket_data: { issue_summary: 'login broken' },
    updated_at: recent,
    ...over,
  }
}

describe('fetchReporterHistory', () => {
  it('classifies DONE/DEPLOYED/ARCHIVE and is_archived as closed, case-insensitively', async () => {
    const supabase = makeSupabase({
      slack_issues: [
        issue({ thread_ts: '1', clickup_task_id: 'A' }),
        issue({ thread_ts: '2', clickup_task_id: 'B' }),
        issue({ thread_ts: '3', clickup_task_id: 'C' }),
        issue({ thread_ts: '4', clickup_task_id: 'D' }),
        issue({ thread_ts: '5', clickup_task_id: 'E' }),
      ],
      tasks: [
        { clickup_task_id: 'A', status: 'DONE', is_archived: false, synced_at: recent },
        { clickup_task_id: 'B', status: 'deployed', is_archived: false, synced_at: recent },
        { clickup_task_id: 'C', status: 'Archive', is_archived: false, synced_at: recent },
        { clickup_task_id: 'D', status: 'IN PROGRESS', is_archived: true, synced_at: recent },
        { clickup_task_id: 'E', status: 'IN PROGRESS', is_archived: false, synced_at: recent },
      ],
    })
    const out = await fetchReporterHistory(supabase, 'U1', 'current')
    const closed = out.filter((t) => t.state === 'closed').map((t) => t.clickupTaskId).sort()
    const open = out.filter((t) => t.state === 'open').map((t) => t.clickupTaskId)
    expect(closed).toEqual(['A', 'B', 'C', 'D'])
    expect(open).toEqual(['E'])
  })

  it('drops closed tickets older than 30 days but keeps recent closed', async () => {
    const supabase = makeSupabase({
      slack_issues: [
        issue({ thread_ts: '1', clickup_task_id: 'OLD' }),
        issue({ thread_ts: '2', clickup_task_id: 'NEW' }),
      ],
      tasks: [
        { clickup_task_id: 'OLD', status: 'DONE', is_archived: false, synced_at: old },
        { clickup_task_id: 'NEW', status: 'DONE', is_archived: false, synced_at: recent },
      ],
    })
    const out = await fetchReporterHistory(supabase, 'U1', 'current')
    expect(out.map((t) => t.clickupTaskId)).toEqual(['NEW'])
  })

  it('treats a ticket with no matching tasks row as open', async () => {
    const supabase = makeSupabase({
      slack_issues: [issue({ thread_ts: '1', clickup_task_id: 'ORPHAN' })],
      tasks: [],
    })
    const out = await fetchReporterHistory(supabase, 'U1', 'current')
    expect(out).toHaveLength(1)
    expect(out[0].state).toBe('open')
    expect(out[0].clickupUrl).toBe('https://app.clickup.com/t/ORPHAN')
  })

  it('orders open before closed, recency within each group', async () => {
    const older = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    const supabase = makeSupabase({
      slack_issues: [
        // query returns updated_at desc; emulate that order here
        issue({ thread_ts: '1', clickup_task_id: 'OPEN_NEW', updated_at: recent }),
        issue({ thread_ts: '2', clickup_task_id: 'OPEN_OLD', updated_at: older }),
        issue({ thread_ts: '3', clickup_task_id: 'CLOSED_NEW' }),
        issue({ thread_ts: '4', clickup_task_id: 'CLOSED_OLD' }),
      ],
      tasks: [
        { clickup_task_id: 'OPEN_NEW', status: 'IN PROGRESS', is_archived: false, synced_at: recent },
        { clickup_task_id: 'OPEN_OLD', status: 'IN PROGRESS', is_archived: false, synced_at: older },
        { clickup_task_id: 'CLOSED_NEW', status: 'DONE', is_archived: false, synced_at: recent },
        { clickup_task_id: 'CLOSED_OLD', status: 'DONE', is_archived: false, synced_at: older },
      ],
    })
    const out = await fetchReporterHistory(supabase, 'U1', 'current')
    expect(out.map((t) => t.clickupTaskId)).toEqual(['OPEN_NEW', 'OPEN_OLD', 'CLOSED_NEW', 'CLOSED_OLD'])
  })

  it('returns [] when the reporter has no prior tickets', async () => {
    const supabase = makeSupabase({ slack_issues: [], tasks: [] })
    expect(await fetchReporterHistory(supabase, 'U1', 'current')).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest reporter-history -t fetchReporterHistory`
Expected: FAIL — `Cannot find module '@/lib/issue-triage/reporter-history'`.

- [ ] **Step 3: Write the module (types + fetch)**

Create `lib/issue-triage/reporter-history.ts`:

```ts
// lib/issue-triage/reporter-history.ts
import type { getSupabaseServiceClient } from '@/lib/supabase/server'
import type { TicketData } from './types'

type SupabaseServiceClient = Awaited<ReturnType<typeof getSupabaseServiceClient>>

export interface ReporterTicket {
  threadTs: string
  clickupTaskId: string
  summary: string
  state: 'open' | 'closed'
  clickupStatus: string     // raw status from tasks; '' if unknown
  closedAt: string | null   // tasks.synced_at, closed only
  clickupUrl: string
}

const CLOSED_STATUSES = new Set(['DONE', 'DEPLOYED', 'ARCHIVE'])
const CLOSED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const FETCH_LIMIT = 100

interface IssueRow {
  thread_ts: string
  clickup_task_id: string
  ticket_data: TicketData | null
  updated_at: string
}
interface TaskRow {
  clickup_task_id: string
  status: string | null
  is_archived: boolean | null
  synced_at: string | null
}

/** Reporter's OPEN + CLOSED-within-30-days tickets, open first then recent closed. */
export async function fetchReporterHistory(
  supabase: SupabaseServiceClient,
  reporterId: string,
  excludeThreadTs: string,
): Promise<ReporterTicket[]> {
  if (!reporterId) return []

  const { data: issueData } = await supabase
    .from('slack_issues')
    .select('thread_ts, clickup_task_id, ticket_data, updated_at')
    .eq('reporter_id', reporterId)
    .neq('thread_ts', excludeThreadTs)
    .not('clickup_task_id', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(FETCH_LIMIT)

  const rows = (issueData ?? []) as unknown as IssueRow[]
  if (rows.length === 0) return []

  const taskIds = rows.map((r) => r.clickup_task_id)
  const { data: taskData } = await supabase
    .from('tasks')
    .select('clickup_task_id, status, is_archived, synced_at')
    .in('clickup_task_id', taskIds)

  const taskById = new Map<string, TaskRow>(
    ((taskData ?? []) as unknown as TaskRow[]).map((t) => [t.clickup_task_id, t]),
  )

  const cutoff = Date.now() - CLOSED_WINDOW_MS
  const open: ReporterTicket[] = []
  const closed: ReporterTicket[] = []

  for (const r of rows) {
    const task = taskById.get(r.clickup_task_id)
    const status = task?.status ?? ''
    const isClosed = task?.is_archived === true || CLOSED_STATUSES.has(status.toUpperCase())
    const ticket: ReporterTicket = {
      threadTs: r.thread_ts,
      clickupTaskId: r.clickup_task_id,
      summary: r.ticket_data?.issue_summary ?? '',
      state: isClosed ? 'closed' : 'open',
      clickupStatus: status,
      closedAt: isClosed ? task?.synced_at ?? null : null,
      clickupUrl: `https://app.clickup.com/t/${r.clickup_task_id}`,
    }
    if (!isClosed) {
      open.push(ticket)
    } else if (task?.synced_at && new Date(task.synced_at).getTime() >= cutoff) {
      // Closed without a synced_at timestamp can't be recency-checked → dropped.
      closed.push(ticket)
    }
  }

  // `open` preserves the query's updated_at-desc order. Sort closed by recency.
  closed.sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
  return [...open, ...closed]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest reporter-history -t fetchReporterHistory`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/issue-triage/reporter-history.ts __tests__/lib/issue-triage/reporter-history.test.ts
git commit -m "feat(support-bot): fetchReporterHistory — open + recent-closed by reporter"
```

---

## Task 3: `formatHistoryForThread` (slot reservation, truncate-then-escape)

**Files:**
- Modify: `lib/issue-triage/reporter-history.ts`
- Test: `__tests__/lib/issue-triage/reporter-history.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/lib/issue-triage/reporter-history.test.ts`:

```ts
import { formatHistoryForThread } from '@/lib/issue-triage/reporter-history'
import type { ReporterTicket } from '@/lib/issue-triage/reporter-history'

function ticket(over: Partial<ReporterTicket>): ReporterTicket {
  return {
    threadTs: 't', clickupTaskId: 'X', summary: 's', state: 'open',
    clickupStatus: '', closedAt: null, clickupUrl: 'https://app.clickup.com/t/X',
    ...over,
  }
}

describe('formatHistoryForThread', () => {
  it('returns null for empty history', () => {
    expect(formatHistoryForThread([])).toBeNull()
  })

  it('shows up to 5 open + 3 closed with a per-group hidden trailer', () => {
    const tickets = [
      ...Array.from({ length: 7 }, (_, i) => ticket({ clickupTaskId: `O${i}`, state: 'open' })),
      ...Array.from({ length: 4 }, (_, i) =>
        ticket({ clickupTaskId: `C${i}`, state: 'closed', clickupStatus: 'DONE', closedAt: new Date().toISOString() })),
    ]
    const out = formatHistoryForThread(tickets)!
    // 5 open + 3 closed = 8 bullet lines
    expect(out.match(/•/g)).toHaveLength(8)
    expect(out).toContain('+2 open')
    expect(out).toContain('+1 closed')
    expect(out).toContain('not shown')
  })

  it('escapes mrkdwn AFTER truncation so a boundary entity is never split', () => {
    // 79 spaces then "&&&" — the truncation boundary (80 chars) lands on a raw '&'.
    const summary = ' '.repeat(79) + '&&&'
    const out = formatHistoryForThread([ticket({ summary })])!
    expect(out).not.toContain('&am') // no half-written entity
    expect(out).toContain('&amp;')   // escaped after truncation
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest reporter-history -t formatHistoryForThread`
Expected: FAIL — `formatHistoryForThread is not a function` / not exported.

- [ ] **Step 3: Add the formatter + helpers**

Append to `lib/issue-triage/reporter-history.ts`:

```ts
const THREAD_OPEN_SLOTS = 5
const THREAD_CLOSED_SLOTS = 3
const SUMMARY_MAX = 80

function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Truncate the RAW summary first, then escape (see spec: escaping expands one
// char into a multi-char entity, so truncating an escaped string can split it).
function truncateThenEscape(s: string): string {
  const raw = s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX - 1).trimEnd() + '…' : s
  return escapeMrkdwn(raw || '(no summary)')
}

function relativeAge(iso: string | null): string {
  if (!iso) return ''
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000))
  if (days <= 0) return 'today'
  return days === 1 ? '1d ago' : `${days}d ago`
}

function threadLine(t: ReporterTicket): string {
  const summary = truncateThenEscape(t.summary)
  if (t.state === 'open') {
    return `• Active — _${summary}_ (<${t.clickupUrl}|view>)`
  }
  const status = escapeMrkdwn(t.clickupStatus || 'Closed')
  const age = relativeAge(t.closedAt)
  return `• ✅ ${status}${age ? ` ${age}` : ''} — _${summary}_ (<${t.clickupUrl}|view>)`
}

export function formatHistoryForThread(tickets: ReporterTicket[]): string | null {
  if (tickets.length === 0) return null
  const open = tickets.filter((t) => t.state === 'open')
  const closed = tickets.filter((t) => t.state === 'closed')
  const shownOpen = open.slice(0, THREAD_OPEN_SLOTS)
  const shownClosed = closed.slice(0, THREAD_CLOSED_SLOTS)
  if (shownOpen.length === 0 && shownClosed.length === 0) return null

  const lines = [...shownOpen, ...shownClosed].map(threadLine)

  const trailerParts: string[] = []
  const hiddenOpen = open.length - shownOpen.length
  const hiddenClosed = closed.length - shownClosed.length
  if (hiddenOpen > 0) trailerParts.push(`+${hiddenOpen} open`)
  if (hiddenClosed > 0) trailerParts.push(`+${hiddenClosed} closed`)
  const trailer = trailerParts.length ? `\n_${trailerParts.join(', ')} not shown_` : ''

  return `📋 *Earlier tickets from this reporter:*\n${lines.join('\n')}${trailer}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest reporter-history -t formatHistoryForThread`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/issue-triage/reporter-history.ts __tests__/lib/issue-triage/reporter-history.test.ts
git commit -m "feat(support-bot): thread-history formatter (slot-reserved, truncate-then-escape)"
```

---

## Task 4: `formatHistoryForTriage` (closed-only prompt block)

**Files:**
- Modify: `lib/issue-triage/reporter-history.ts`
- Test: `__tests__/lib/issue-triage/reporter-history.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the test file:

```ts
import { formatHistoryForTriage } from '@/lib/issue-triage/reporter-history'

describe('formatHistoryForTriage', () => {
  it('returns empty string when there are no closed tickets', () => {
    expect(formatHistoryForTriage([ticket({ state: 'open' })])).toBe('')
  })

  it('lists only closed tickets with id, status, age and summary', () => {
    const out = formatHistoryForTriage([
      ticket({ clickupTaskId: 'OPEN1', state: 'open', summary: 'ignored' }),
      ticket({ clickupTaskId: 'C1', state: 'closed', clickupStatus: 'DONE',
        closedAt: new Date(Date.now() - 3 * 86400000).toISOString(), summary: 'pdf export fails' }),
    ])
    expect(out).toContain('RECENTLY RESOLVED')
    expect(out).toContain('[C1]')
    expect(out).toContain('DONE')
    expect(out).toContain('pdf export fails')
    expect(out).not.toContain('OPEN1')
    expect(out).not.toContain('ignored')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest reporter-history -t formatHistoryForTriage`
Expected: FAIL — not exported.

- [ ] **Step 3: Add the formatter**

Append to `lib/issue-triage/reporter-history.ts`:

```ts
/** Compact prompt block of the reporter's CLOSED tickets only. '' when none. */
export function formatHistoryForTriage(tickets: ReporterTicket[]): string {
  const closed = tickets.filter((t) => t.state === 'closed')
  if (closed.length === 0) return ''
  const lines = closed.map((t) => {
    const age = relativeAge(t.closedAt)
    const status = t.clickupStatus || 'CLOSED'
    return `[${t.clickupTaskId}] (${status}${age ? ` ${age}` : ''}) ${t.summary || '(no summary)'}`
  })
  return [
    'This reporter has these RECENTLY RESOLVED tickets (already closed; NOT in the active list above). ' +
      'If the new ticket is the same underlying issue as one of these, treat it as a duplicate and return ' +
      'that ClickUp id — a resolved bug resurfacing is a high-signal duplicate.',
    ...lines,
  ].join('\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest reporter-history`
Expected: PASS (all reporter-history tests).

- [ ] **Step 5: Commit**

```bash
git add lib/issue-triage/reporter-history.ts __tests__/lib/issue-triage/reporter-history.test.ts
git commit -m "feat(support-bot): triage-history formatter (closed-only, high-signal block)"
```

---

## Task 5: Extend `detectDuplicate` with optional closed-history

**Files:**
- Modify: `lib/issue-triage/duplicate-detection.ts:41` and the `userTurn` assembly (~lines 74-78)
- Test: `__tests__/lib/issue-triage/duplicate-detection.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/lib/issue-triage/duplicate-detection.test.ts` (check the file's existing imports/mocks first; reuse them). If the file mocks the Anthropic client, assert the closed-history string reaches the user turn. If it does not yet mock Anthropic, add this focused test that mocks both ClickUp and Anthropic:

```ts
// Captures the user-turn content passed to Anthropic so we can assert the
// reporter closed-history block is injected.
const createMock = jest.fn().mockResolvedValue({
  content: [{ type: 'text', text: '{"duplicate_task_id":null,"duplicate_confidence":0,"workaround_found":false,"workaround_text":null,"has_user_facing_docs":false,"documentation_gap":false,"routing_decision":"escalate_to_michael","routing_reasoning":"x"}' }],
})
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: class { messages = { create: createMock } },
}))
jest.mock('@/lib/clickup/client', () => ({
  buildClickUpClient: () => ({ getTasks: jest.fn().mockResolvedValue([]) }),
}))
jest.mock('@/lib/issue-triage/sop', () => ({
  getActiveSop: jest.fn().mockResolvedValue({ duplicate_thresholds: { possible: 0.6, confirmed: 0.85 } }),
}))

describe('detectDuplicate reporter closed-history', () => {
  beforeEach(() => { createMock.mockClear(); process.env.CLICKUP_BOT_TOKEN = 't'; process.env.ANTHROPIC_API_KEY = 'k' })

  it('injects the closed-history block into the user turn when provided', async () => {
    const { detectDuplicate } = await import('@/lib/issue-triage/duplicate-detection')
    await detectDuplicate({ issue_summary: 'x' } as any, undefined, 'RECENTLY RESOLVED\n[C1] (DONE) pdf export')
    const userTurn = createMock.mock.calls[0][0].messages[0].content as string
    expect(userTurn).toContain('RECENTLY RESOLVED')
    expect(userTurn).toContain('[C1]')
  })

  it('omits the block when no history is passed', async () => {
    const { detectDuplicate } = await import('@/lib/issue-triage/duplicate-detection')
    await detectDuplicate({ issue_summary: 'x' } as any)
    const userTurn = createMock.mock.calls[0][0].messages[0].content as string
    expect(userTurn).not.toContain('RECENTLY RESOLVED')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest duplicate-detection -t "reporter closed-history"`
Expected: FAIL — third arg is ignored, so `RECENTLY RESOLVED` is absent from the user turn.

- [ ] **Step 3: Add the parameter and inject it**

In `lib/issue-triage/duplicate-detection.ts`, change the signature (line 41):

```ts
export async function detectDuplicate(
  ticketData: TicketData,
  excludeTaskId?: string,
  reporterClosedHistory?: string,
): Promise<TriageClaudeResponse> {
```

And change the `userTurn` assembly (the existing 3-line array, ~lines 74-78) to:

```ts
  const userTurn = [
    `Possible threshold: ${possible}, Confirmed threshold: ${confirmed}`,
    `Completed ticket:\n${JSON.stringify(ticketData)}`,
    `Active ClickUp tasks (all lists):\n${formatTaskList(allTasks)}`,
    reporterClosedHistory ? reporterClosedHistory : '',
  ].filter(Boolean).join('\n\n')
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest duplicate-detection`
Expected: PASS (new tests + any pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add lib/issue-triage/duplicate-detection.ts __tests__/lib/issue-triage/duplicate-detection.test.ts
git commit -m "feat(support-bot): detectDuplicate accepts reporter closed-history block"
```

---

## Task 6: Wire into `handleNewIssue`

**Files:**
- Modify: `app/api/webhooks/slack/route.ts` (imports; `handleNewIssue` at lines ~231-378)

No new unit test — `route.ts` is integration glue (consistent with the rest of the file, which has no unit tests). Verification is typecheck + full suite + the manual checks in Step 6.

- [ ] **Step 1: Add the import**

After line 14 (`import { getDevTeamIds, ... } from '@/lib/issue-triage/dev-team'`), add:

```ts
import { fetchReporterHistory, formatHistoryForThread, formatHistoryForTriage } from '@/lib/issue-triage/reporter-history'
```

- [ ] **Step 2: Fetch history in parallel with the reporter profile**

Replace the existing profile lookup (currently line 260):

```ts
  // Look up reporter profile from Slack
  const reporterProfile = await slack.getUserProfile(event.user ?? '').catch(() => ({ email: null, displayName: null }))
```

with a parallel fetch (history fetch is independent of triage and safe to run now — the current thread is excluded by `event.ts` regardless of whether its row exists yet):

```ts
  // Look up reporter profile + prior ticket history in parallel. History runs
  // before triage (which consumes its closed subset); not parallel with triage.
  const [reporterProfile, reporterHistory] = await Promise.all([
    slack.getUserProfile(event.user ?? '').catch(() => ({ email: null, displayName: null })),
    fetchReporterHistory(supabase, event.user ?? '', event.ts).catch((err) => {
      console.warn('[slack-webhook] reporter history fetch failed:', err)
      return []
    }),
  ])
  const historyTaskIds = new Set(reporterHistory.map((t) => t.clickupTaskId))
  const historyBlock = formatHistoryForThread(reporterHistory)
```

- [ ] **Step 3: Feed closed-history into the initial triage call**

Replace the triage call (currently line 314):

```ts
    triageResult = await detectDuplicate(fullIssue.ticket_data, task.id)
```

with:

```ts
    triageResult = await detectDuplicate(fullIssue.ticket_data, task.id, formatHistoryForTriage(reporterHistory))
```

- [ ] **Step 4: Compute the `is_repeat_issue` flag after triage**

Immediately after the `try/catch` block that sets `triageResult` (i.e. right after the closing brace of the `catch` near line 320, before the "Check if a dev team member has already replied" comment), add:

```ts
  // Repeat detection: the matched duplicate is one of THIS reporter's own tickets.
  const isRepeatForReporter = !!(triageResult?.duplicate_task_id && historyTaskIds.has(triageResult.duplicate_task_id))
```

- [ ] **Step 5: Apply the override + render the thread block in both branches**

In the `devAlreadyReplied` branch, persist the flag (this branch does not run the intake turn) and append the history block. Replace:

```ts
  if (devAlreadyReplied) {
    await slack.postBlocks(
      event.channel,
      `I've opened a ticket: ${task.url}`,
      [
        { type: 'section', text: { type: 'mrkdwn', text: `I've opened a ticket: <${task.url}|View in ClickUp>\n🔗 <${originalMsgUrl}|Original message>\n\n${dupStatus}` } },
        ticketControlsBlock({ includeAssign: true }),
      ],
      event.ts,
    )
  } else {
```

with:

```ts
  if (devAlreadyReplied) {
    if (isRepeatForReporter) {
      await supabase.from('slack_issues')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update({ ticket_data: { ...fullIssue.ticket_data, is_repeat_issue: true } as any, updated_at: new Date().toISOString() })
        .eq('thread_ts', event.ts)
    }
    await slack.postBlocks(
      event.channel,
      `I've opened a ticket: ${task.url}`,
      [
        { type: 'section', text: { type: 'mrkdwn', text: `I've opened a ticket: <${task.url}|View in ClickUp>\n🔗 <${originalMsgUrl}|Original message>\n\n${dupStatus}${historyBlock ? `\n\n${historyBlock}` : ''}` } },
        ticketControlsBlock({ includeAssign: true }),
      ],
      event.ts,
    )
  } else {
```

In the normal branch, fold the override into the existing intake persist. Replace:

```ts
      await supabase.from('slack_issues')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update({ ticket_data: intakeResult.updated_schema as any, updated_at: new Date().toISOString() })
        .eq('thread_ts', event.ts)
```

with:

```ts
      const persistedSchema = {
        ...intakeResult.updated_schema,
        is_repeat_issue: isRepeatForReporter || intakeResult.updated_schema.is_repeat_issue,
      }
      await supabase.from('slack_issues')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update({ ticket_data: persistedSchema as any, updated_at: new Date().toISOString() })
        .eq('thread_ts', event.ts)
```

And append the history block to the normal-branch reply. Replace:

```ts
        { type: 'section', text: { type: 'mrkdwn', text: `I've opened a ticket for you: <${task.url}|View in ClickUp>\n🔗 <${originalMsgUrl}|Original message>\n\n${dupStatus}\n\n${firstQuestion}` } },
```

with:

```ts
        { type: 'section', text: { type: 'mrkdwn', text: `I've opened a ticket for you: <${task.url}|View in ClickUp>\n🔗 <${originalMsgUrl}|Original message>\n\n${dupStatus}${historyBlock ? `\n\n${historyBlock}` : ''}\n\n${firstQuestion}` } },
```

- [ ] **Step 6: Verify typecheck + full suite, then commit**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: PASS (entire suite, including the new reporter-history and duplicate-detection tests).

Manual reasoning check (no app run needed): confirm the `is_repeat_issue` override is applied in the intake persist (so the model can't clobber it) and in the `devAlreadyReplied` branch (which has no intake persist); confirm `historyBlock` is appended in both reply branches and omitted when `null`.

```bash
git add app/api/webhooks/slack/route.ts
git commit -m "feat(support-bot): recall reporter ticket history on new tickets"
```

---

## Self-Review

**Spec coverage:**
- Show in thread → Task 3 + Task 6 Step 5 (both branches). ✅
- Feed dedup/triage (closed-only) → Task 4 + Task 5 + Task 6 Step 3. ✅
- Set `is_repeat_issue` (deterministic, final override) → Task 6 Steps 4-5. ✅
- Open/closed classification (DONE/DEPLOYED/ARCHIVE/`is_archived`, case-insensitive, missing=open) → Task 2. ✅
- 30-day closed window + `FETCH_LIMIT` → Task 2. ✅
- Two-query approach (no embedded join) → Task 2. ✅
- `reporter_id` index; `tasks.clickup_task_id` already unique → Task 1. ✅
- Truncate-then-escape ordering + mrkdwn escaping → Task 3. ✅
- Slot-reserved display (5 open + 3 closed, per-group trailer) → Task 3. ✅
- Triage prompt-injection format → Task 4. ✅
- Error handling non-fatal; missing-task silent → Task 2 + Task 6 Step 2. ✅
- Concrete tests per spec testing section → Tasks 2-5. ✅
- Execution order (history before triage; parallel with profile/media) → Task 6 Step 2-3. ✅

**Type consistency:** `ReporterTicket` fields (`threadTs`, `clickupTaskId`, `summary`, `state`, `clickupStatus`, `closedAt`, `clickupUrl`) are identical across Tasks 2-4 and consumed unchanged in Task 6. `fetchReporterHistory(supabase, reporterId, excludeThreadTs)` and `detectDuplicate(ticketData, excludeTaskId, reporterClosedHistory)` signatures match their call sites in Task 6. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✅

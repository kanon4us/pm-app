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

const THREAD_OPEN_SLOTS = 5
const THREAD_CLOSED_SLOTS = 3
const SUMMARY_MAX = 80

function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Truncate the RAW summary first, then escape (escaping expands one char into a
// multi-char entity, so truncating an escaped string can split it).
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

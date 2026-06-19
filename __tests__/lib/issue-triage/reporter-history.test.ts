import { fetchReporterHistory } from '@/lib/issue-triage/reporter-history'
import { formatHistoryForThread } from '@/lib/issue-triage/reporter-history'
import { formatHistoryForTriage } from '@/lib/issue-triage/reporter-history'
import type { ReporterTicket } from '@/lib/issue-triage/reporter-history'

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

function ticket(over: Partial<ReporterTicket>): ReporterTicket {
  return {
    threadTs: 't', clickupTaskId: 'X', summary: 's', state: 'open',
    clickupStatus: '', closedAt: null, clickupUrl: 'https://app.clickup.com/t/X',
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
    expect(out.match(/•/g)).toHaveLength(8)
    expect(out).toContain('+2 open')
    expect(out).toContain('+1 closed')
    expect(out).toContain('not shown')
  })

  it('escapes mrkdwn AFTER truncation so a boundary entity is never split', () => {
    const summary = ' '.repeat(79) + '&&&'
    const out = formatHistoryForThread([ticket({ summary })])!
    expect(out).not.toContain('&am')
    expect(out).toContain('&amp;')
  })
})

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

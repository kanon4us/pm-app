import { detectArchivalChanges, type ArchiveSyncTask } from '@/lib/clickup/archive-detection'

const task = (over: Partial<ArchiveSyncTask> & { id: string }): ArchiveSyncTask => ({
  clickup_task_id: `cu-${over.id}`,
  list_id: 'listA',
  is_archived: false,
  ...over,
})

describe('detectArchivalChanges', () => {
  it('archives a task missing from ClickUp when its list WAS fetched', () => {
    const result = detectArchivalChanges({
      tasks: [task({ id: '1' })],
      activeTaskIds: new Set<string>(), // cu-1 absent from the response
      fetchedListIds: new Set(['listA']),
    })
    expect(result.archivedIds).toEqual(['1'])
    expect(result.reactivatedIds).toEqual([])
  })

  // Regression: a transient per-list fetch failure must NOT archive its tasks.
  it('does NOT archive a task whose list failed to fetch', () => {
    const result = detectArchivalChanges({
      tasks: [task({ id: '1', list_id: 'listA' })],
      activeTaskIds: new Set<string>(), // absent only because the fetch threw
      fetchedListIds: new Set<string>(), // listA was NOT fetched successfully
    })
    expect(result.archivedIds).toEqual([])
  })

  // Regression: a total fetch failure (e.g. expired token) must not blank the planner.
  it('does NOT archive anything when every list fetch failed', () => {
    const result = detectArchivalChanges({
      tasks: [task({ id: '1', list_id: 'listA' }), task({ id: '2', list_id: 'listB' })],
      activeTaskIds: new Set<string>(),
      fetchedListIds: new Set<string>(),
    })
    expect(result.archivedIds).toEqual([])
    expect(result.reactivatedIds).toEqual([])
  })

  it('reactivates a previously-archived task that reappears in ClickUp', () => {
    const result = detectArchivalChanges({
      tasks: [task({ id: '1', is_archived: true })],
      activeTaskIds: new Set(['cu-1']),
      fetchedListIds: new Set(['listA']),
    })
    expect(result.reactivatedIds).toEqual(['1'])
    expect(result.archivedIds).toEqual([])
  })

  it('leaves active, non-archived tasks untouched', () => {
    const result = detectArchivalChanges({
      tasks: [task({ id: '1' })],
      activeTaskIds: new Set(['cu-1']),
      fetchedListIds: new Set(['listA']),
    })
    expect(result.archivedIds).toEqual([])
    expect(result.reactivatedIds).toEqual([])
  })

  it('does not re-archive a task already marked archived (idempotent)', () => {
    const result = detectArchivalChanges({
      tasks: [task({ id: '1', is_archived: true })],
      activeTaskIds: new Set<string>(), // still absent
      fetchedListIds: new Set(['listA']),
    })
    expect(result.archivedIds).toEqual([])
  })

  it('handles a mix of fetched and unfetched lists', () => {
    const result = detectArchivalChanges({
      tasks: [
        task({ id: '1', list_id: 'listA' }), // fetched + absent -> archive
        task({ id: '2', list_id: 'listA', clickup_task_id: 'cu-2' }), // fetched + present -> keep
        task({ id: '3', list_id: 'listB' }), // list not fetched -> keep
      ],
      activeTaskIds: new Set(['cu-2']),
      fetchedListIds: new Set(['listA']),
    })
    expect(result.archivedIds).toEqual(['1'])
    expect(result.reactivatedIds).toEqual([])
  })
})

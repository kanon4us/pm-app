// Pure logic for the ClickUp status sync. Given the DB tasks and the fresh
// clickup_task_id → status map, group the tasks whose status CHANGED by their
// new status, so the route can issue ONE batched UPDATE per distinct status
// instead of one UPDATE per task.
//
// The previous route did `Promise.all(tasks.map(t => update one task))`, which
// fanned out N concurrent UPDATEs. On a large sync that exhausted the PostgREST
// connection pool and wedged every other query. Distinct statuses are few (a
// handful), so grouping collapses the fan-out to a small sequential loop.

export interface StatusSyncTask {
  id: string
  clickup_task_id: string
  status: string
}

/**
 * newStatus → [task ids] for every task whose ClickUp status differs from the
 * stored one. Tasks absent from the map (their list wasn't fetched) or already
 * matching are skipped.
 */
export function groupStatusUpdates(
  tasks: StatusSyncTask[],
  statusMap: Map<string, string>
): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const t of tasks) {
    const newStatus = statusMap.get(t.clickup_task_id)
    if (newStatus === undefined || newStatus === t.status) continue
    const ids = groups.get(newStatus) ?? []
    ids.push(t.id)
    groups.set(newStatus, ids)
  }
  return groups
}

// Pure logic for deciding which tasks the ClickUp status sync should mark
// archived or reactivated. Extracted from the sync-status route so it can be
// unit-tested in isolation — this is the logic that previously mass-archived
// real tasks (and hid them from the Sprint Planner) when a ClickUp fetch was
// incomplete.

export interface ArchiveSyncTask {
  id: string
  clickup_task_id: string
  list_id: string
  is_archived: boolean
}

export interface ArchiveDetectionInput {
  /** All tasks currently in the DB. */
  tasks: ArchiveSyncTask[]
  /** clickup_task_ids that were present in ClickUp's response. */
  activeTaskIds: Set<string>
  /** list_ids that were fetched from ClickUp successfully (not errored). */
  fetchedListIds: Set<string>
}

export interface ArchiveDetectionResult {
  archivedIds: string[]
  reactivatedIds: string[]
}

export function detectArchivalChanges(input: ArchiveDetectionInput): ArchiveDetectionResult {
  const { tasks, activeTaskIds, fetchedListIds } = input

  // Archive a task only when its list was fetched successfully AND the task was
  // absent from that response. A task in a list we could not fetch is left
  // untouched — otherwise a transient failure would wrongly archive it.
  const archivedIds = tasks
    .filter((t) => !t.is_archived && fetchedListIds.has(t.list_id) && !activeTaskIds.has(t.clickup_task_id))
    .map((t) => t.id)

  // Reactivate a previously-archived task that is present in ClickUp again.
  const reactivatedIds = tasks
    .filter((t) => t.is_archived && activeTaskIds.has(t.clickup_task_id))
    .map((t) => t.id)

  return { archivedIds, reactivatedIds }
}

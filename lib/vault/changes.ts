export interface VaultCommit {
  path: string
  changeType: 'added' | 'modified' | 'renamed' | 'deleted'
  oldPath?: string
}

export interface ChangeReport {
  added: string[]
  modified: string[]
  renamed: Array<{ from: string; to: string }>
  deleted: string[]
}

/**
 * Returns true when the last commit is strictly older than `days` days
 * relative to `now`. Uses millisecond diff / 86_400_000 for exactness.
 */
export function isStable(lastCommitISO: string, now: Date, days = 7): boolean {
  const lastCommit = new Date(lastCommitISO)
  const diffDays = (now.getTime() - lastCommit.getTime()) / 86_400_000
  return diffDays > days
}

/**
 * Buckets an array of VaultCommits by change type.
 * Duplicate paths within added/modified/deleted are deduped (first-seen wins).
 * Renamed entries map to { from: oldPath, to: path }.
 */
export function changeReport(commits: VaultCommit[]): ChangeReport {
  const added: string[] = []
  const modified: string[] = []
  const renamed: Array<{ from: string; to: string }> = []
  const deleted: string[] = []

  const seenAdded = new Set<string>()
  const seenModified = new Set<string>()
  const seenDeleted = new Set<string>()

  for (const commit of commits) {
    switch (commit.changeType) {
      case 'added':
        if (!seenAdded.has(commit.path)) {
          seenAdded.add(commit.path)
          added.push(commit.path)
        }
        break
      case 'modified':
        if (!seenModified.has(commit.path)) {
          seenModified.add(commit.path)
          modified.push(commit.path)
        }
        break
      case 'deleted':
        if (!seenDeleted.has(commit.path)) {
          seenDeleted.add(commit.path)
          deleted.push(commit.path)
        }
        break
      case 'renamed':
        renamed.push({ from: commit.oldPath!, to: commit.path })
        break
    }
  }

  return { added, modified, renamed, deleted }
}

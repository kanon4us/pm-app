// lib/vault/git-writes.ts
// Serialized git-write consumer: DI core for the vault consolidation write pipeline.
//
// All write actions in v1 are frontmatter patches only — no physical file moves or
// deletes — so they cannot break the Obsidian link graph. Physical moves / merges
// are a documented follow-up (humans complete merges in the PR).

import { patchFrontmatter } from '@/lib/vault/frontmatter'

// ── Dependency injection interface ────────────────────────────────────────────

/**
 * Injectable interface for all git operations needed by applyAction.
 * Production wires these to lib/github/vault.ts; tests use in-memory mocks.
 */
export interface GitWriteDeps {
  /** Create the branch if it does not already exist (idempotent). */
  ensureBranch(branch: string): Promise<void>
  /** Return the current blob SHA of the file on the given branch. */
  currentBlobSha(branch: string, path: string): Promise<string>
  /** Read the raw file content from the given branch. */
  readFile(branch: string, path: string): Promise<string>
  /** Write (create or update) a file on the given branch. Throws on failure. */
  writeFile(args: {
    branch: string
    path: string
    content: string
    message: string
  }): Promise<void>
}

// ── Action → frontmatter patch map ───────────────────────────────────────────

/**
 * Map a Slack button action ID to the frontmatter patch that should be applied.
 * The `today` parameter is the ISO date string (YYYY-MM-DD) for last_reviewed.
 */
export function patchForAction(
  actionId: string,
  today: string,
): Record<string, string> {
  switch (actionId) {
    case 'mark-legacy':
    case 'archive':
    case 'merge-canonical':
      return { status: 'legacy', review_status: 'reviewed', last_reviewed: today }

    case 'delete':
      return { status: 'orphan', review_status: 'reviewed', last_reviewed: today }

    case 'tag-support':
      return { audience: 'support', review_status: 'reviewed', last_reviewed: today }

    case 'tag-engineering':
      return { audience: 'engineering', review_status: 'reviewed', last_reviewed: today }

    case 'conceptual':
      return { status: 'conceptual', review_status: 'reviewed', last_reviewed: today }

    case 'snooze':
      return { review_status: 'snoozed', last_reviewed: today }

    // accurate, keep, distinct, and any future unknown action → review stamp only
    default:
      return { review_status: 'reviewed', last_reviewed: today }
  }
}

// ── applyAction ───────────────────────────────────────────────────────────────

/**
 * Apply a review action to a vault file with optimistic concurrency control and
 * 422 retry for non-fast-forward conflicts.
 *
 * Algorithm:
 *  1. ensureBranch — create if missing (idempotent).
 *  2. currentBlobSha — compare against baseBlobSha; abort as 'stale' if different.
 *  3. readFile → patchFrontmatter → writeFile.
 *  4. If writeFile throws a "422" error, retry from step 2 (re-read SHA, re-patch,
 *     re-write) with exponential backoff. A stale SHA on retry triggers the
 *     optimistic-lock abort in step 2, which is the correct outcome.
 *  5. Return { aborted: false } on success.
 *
 * @param args.baseBlobSha  The blob SHA the caller saw when generating the question card.
 * @param opts.maxRetries   Max number of 422-triggered retries (default 3).
 */
export async function applyAction(
  args: {
    branch: string
    path: string
    baseBlobSha: string
    actionId: string
  },
  deps: GitWriteDeps,
  opts?: { maxRetries?: number },
): Promise<{ aborted: boolean; reason?: string }> {
  const { branch, path, baseBlobSha, actionId } = args
  const maxRetries = opts?.maxRetries ?? 3
  const today = new Date().toISOString().slice(0, 10)

  // Step 1: ensure the branch exists
  await deps.ensureBranch(branch)

  let attempt = 0
  while (true) {
    // Step 2: optimistic lock — re-read SHA on every attempt (including retries)
    const liveSha = await deps.currentBlobSha(branch, path)
    if (liveSha !== baseBlobSha) {
      return { aborted: true, reason: 'stale' }
    }

    // Step 3: read → patch
    const raw = await deps.readFile(branch, path)
    const patched = patchFrontmatter(raw, patchForAction(actionId, today))

    // Step 4: write — catch 422 for retry
    try {
      await deps.writeFile({
        branch,
        path,
        content: patched,
        message: `docs(vault): ${actionId} — ${path}`,
      })
      // Step 5: success
      return { aborted: false }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('422') && attempt < maxRetries) {
        attempt += 1
        // Exponential backoff: 100ms, 200ms, 400ms …
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1)))
        // Loop: re-read SHA and retry
        continue
      }
      throw err
    }
  }
}

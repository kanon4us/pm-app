// __tests__/lib/vault/git-writes.test.ts
// Unit tests for lib/vault/git-writes.ts — fully DI-driven, no real GitHub calls.

import { patchForAction, applyAction, GitWriteDeps } from '@/lib/vault/git-writes'

// ── patchForAction ────────────────────────────────────────────────────────────

describe('patchForAction', () => {
  it('returns legacy patch for mark-legacy', () => {
    expect(patchForAction('mark-legacy', '2026-06-16')).toEqual({
      status: 'legacy',
      review_status: 'reviewed',
      last_reviewed: '2026-06-16',
    })
  })

  it('returns legacy patch for archive', () => {
    expect(patchForAction('archive', '2026-06-16')).toEqual({
      status: 'legacy',
      review_status: 'reviewed',
      last_reviewed: '2026-06-16',
    })
  })

  it('returns legacy patch for merge-canonical', () => {
    expect(patchForAction('merge-canonical', '2026-06-16')).toEqual({
      status: 'legacy',
      review_status: 'reviewed',
      last_reviewed: '2026-06-16',
    })
  })

  it('returns orphan patch for delete', () => {
    expect(patchForAction('delete', '2026-06-16')).toEqual({
      status: 'orphan',
      review_status: 'reviewed',
      last_reviewed: '2026-06-16',
    })
  })

  it('returns support audience patch for tag-support', () => {
    expect(patchForAction('tag-support', '2026-06-16')).toEqual({
      audience: 'support',
      review_status: 'reviewed',
      last_reviewed: '2026-06-16',
    })
  })

  it('returns engineering audience patch for tag-engineering', () => {
    expect(patchForAction('tag-engineering', '2026-06-16')).toEqual({
      audience: 'engineering',
      review_status: 'reviewed',
      last_reviewed: '2026-06-16',
    })
  })

  it('returns conceptual patch for conceptual', () => {
    expect(patchForAction('conceptual', '2026-06-16')).toEqual({
      status: 'conceptual',
      review_status: 'reviewed',
      last_reviewed: '2026-06-16',
    })
  })

  it('returns snoozed patch for snooze', () => {
    expect(patchForAction('snooze', '2026-06-16')).toEqual({
      review_status: 'snoozed',
      last_reviewed: '2026-06-16',
    })
  })

  it('returns reviewed-only patch for accurate (catch-all)', () => {
    expect(patchForAction('accurate', '2026-06-16')).toEqual({
      review_status: 'reviewed',
      last_reviewed: '2026-06-16',
    })
  })

  it('returns reviewed-only patch for keep (catch-all)', () => {
    expect(patchForAction('keep', '2026-06-16')).toEqual({
      review_status: 'reviewed',
      last_reviewed: '2026-06-16',
    })
  })

  it('returns reviewed-only patch for distinct (catch-all)', () => {
    expect(patchForAction('distinct', '2026-06-16')).toEqual({
      review_status: 'reviewed',
      last_reviewed: '2026-06-16',
    })
  })

  it('returns reviewed-only patch for any unknown action', () => {
    expect(patchForAction('some-future-action', '2026-06-16')).toEqual({
      review_status: 'reviewed',
      last_reviewed: '2026-06-16',
    })
  })
})

// ── applyAction ───────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<GitWriteDeps> = {}): {
  deps: GitWriteDeps
  ensureBranch: jest.Mock
  currentBlobSha: jest.Mock
  readFile: jest.Mock
  writeFile: jest.Mock
} {
  const ensureBranch = jest.fn().mockResolvedValue(undefined)
  const currentBlobSha = jest.fn().mockResolvedValue('sha-abc')
  const readFile = jest.fn().mockResolvedValue('---\nstatus: active\n---\n# Doc')
  const writeFile = jest.fn().mockResolvedValue(undefined)

  const deps: GitWriteDeps = {
    ensureBranch,
    currentBlobSha,
    readFile,
    writeFile,
    ...overrides,
  }

  return { deps, ensureBranch, currentBlobSha, readFile, writeFile }
}

const BASE_ARGS = {
  branch: 'vault-consolidation/2026-W25',
  path: 'docs/some-doc.md',
  baseBlobSha: 'sha-abc',
  actionId: 'keep',
}

describe('applyAction', () => {
  const TODAY = '2026-06-17'

  // ── optimistic lock ─────────────────────────────────────────────────────────

  it('aborts with stale reason when currentBlobSha !== baseBlobSha', async () => {
    const { deps, writeFile } = makeDeps({
      currentBlobSha: jest.fn().mockResolvedValue('sha-different'),
    })

    const result = await applyAction(
      { ...BASE_ARGS, baseBlobSha: 'sha-abc' },
      deps,
    )

    expect(result).toEqual({ aborted: true, reason: 'stale' })
    expect(writeFile).not.toHaveBeenCalled()
  })

  // ── happy path: tag-support ─────────────────────────────────────────────────

  it('calls writeFile once with content containing audience: support for tag-support', async () => {
    const { deps, writeFile } = makeDeps()

    const result = await applyAction(
      { ...BASE_ARGS, actionId: 'tag-support' },
      deps,
    )

    expect(result).toEqual({ aborted: false })
    expect(writeFile).toHaveBeenCalledTimes(1)

    const callArgs = writeFile.mock.calls[0][0] as {
      branch: string
      path: string
      content: string
      message: string
    }
    expect(callArgs.content).toContain('audience: support')
    expect(callArgs.content).toContain('review_status: reviewed')
    expect(callArgs.branch).toBe(BASE_ARGS.branch)
    expect(callArgs.path).toBe(BASE_ARGS.path)
  })

  // ── 422 retry ───────────────────────────────────────────────────────────────

  it('retries on 422 and returns aborted: false when second write succeeds', async () => {
    let callCount = 0
    const writeFile = jest.fn().mockImplementation(() => {
      callCount += 1
      if (callCount === 1) throw new Error('GitHub 422 non-fast-forward')
      return Promise.resolve(undefined)
    })

    const { deps } = makeDeps({ writeFile })

    const result = await applyAction(BASE_ARGS, deps, { maxRetries: 3 })

    expect(result).toEqual({ aborted: false })
    expect(writeFile).toHaveBeenCalledTimes(2)
  })

  it('re-reads SHA on retry so optimistic lock can fire if file changed during retry', async () => {
    // First write: 422. Second currentBlobSha returns a different SHA → stale abort.
    let blobShaCallCount = 0
    const currentBlobSha = jest.fn().mockImplementation(() => {
      blobShaCallCount += 1
      if (blobShaCallCount === 1) return Promise.resolve('sha-abc') // matches base
      return Promise.resolve('sha-changed-by-someone-else') // stale on retry
    })

    let writeCallCount = 0
    const writeFile = jest.fn().mockImplementation(() => {
      writeCallCount += 1
      if (writeCallCount === 1) throw new Error('GitHub 422 non-fast-forward')
      return Promise.resolve(undefined)
    })

    const { deps } = makeDeps({ currentBlobSha, writeFile })

    const result = await applyAction(BASE_ARGS, deps, { maxRetries: 3 })

    expect(result).toEqual({ aborted: true, reason: 'stale' })
    // writeFile should only have been called once (first attempt threw 422,
    // then the optimistic-lock check aborted before the second write)
    expect(writeFile).toHaveBeenCalledTimes(1)
  })

  // ── ensureBranch called ─────────────────────────────────────────────────────

  it('calls ensureBranch with the branch name', async () => {
    const { deps, ensureBranch } = makeDeps()

    await applyAction(BASE_ARGS, deps)

    expect(ensureBranch).toHaveBeenCalledWith(BASE_ARGS.branch)
  })

  // ── mark-legacy action ──────────────────────────────────────────────────────

  it('writes status: legacy for mark-legacy action', async () => {
    const { deps, writeFile } = makeDeps()

    await applyAction({ ...BASE_ARGS, actionId: 'mark-legacy' }, deps)

    const callArgs = writeFile.mock.calls[0][0] as { content: string }
    expect(callArgs.content).toContain('status: legacy')
    expect(callArgs.content).toContain('review_status: reviewed')
  })
})

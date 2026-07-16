// __tests__/lib/features/gatekeeper.test.ts
// Locks the scaffoldIfMissing guard: enrich-only callers (objectives sync /
// manual re-sync) must never CREATE a feature from a task that has none.
jest.mock('@/lib/clickup/client', () => ({
  buildClickUpClient: jest.fn(),
}))

import { activateFeatureFromTask } from '@/lib/features/gatekeeper'
import type { ClickUpTask } from '@/lib/clickup/client'

/** Minimal chainable Supabase mock covering the paths activateFeatureFromTask hits.
 * feature_tasks resolves EMPTY (no existing feature), so we exercise the branch
 * where the function decides whether to scaffold. */
function makeDb() {
  const featuresInsert = jest.fn(() => ({
    select: () => ({ single: () => Promise.resolve({ data: { id: 'new-feat' }, error: null }) }),
  }))
  const single = (table: string) => {
    if (table === 'tasks') return Promise.resolve({ data: { id: 't1', list_id: 'l1', fvi_score: null } })
    return Promise.resolve({ data: null }) // lists → no repo
  }
  const from = jest.fn((table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      limit: () => Promise.resolve({ data: [] }), // feature_tasks → no existing feature
      single: () => single(table),
      insert: table === 'features' ? featuresInsert : jest.fn().mockResolvedValue({ data: null, error: null }),
    }
    return chain
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from } as any, featuresInsert }
}

const cuTask = { id: 'cu-abc', name: 'T', description: 'd', custom_fields: [], tags: [], list: { id: 'L' } } as unknown as ClickUpTask

it('does NOT scaffold a feature when scaffoldIfMissing:false and none exists', async () => {
  const { db, featuresInsert } = makeDb()
  const result = await activateFeatureFromTask(db, 'cu-abc', cuTask, { scaffoldIfMissing: false })
  expect(result).toBeNull()
  expect(featuresInsert).not.toHaveBeenCalled()
})

it('scaffolds by default (scaffoldIfMissing omitted) when none exists', async () => {
  const { db, featuresInsert } = makeDb()
  const result = await activateFeatureFromTask(db, 'cu-abc', cuTask)
  expect(featuresInsert).toHaveBeenCalled()
  expect(result?.created).toBe(true)
})

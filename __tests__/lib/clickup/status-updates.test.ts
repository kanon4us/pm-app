import { groupStatusUpdates } from '@/lib/clickup/status-updates'

describe('groupStatusUpdates', () => {
  it('groups changed tasks by their new status', () => {
    const tasks = [
      { id: 'a', clickup_task_id: 'ca', status: 'open' },
      { id: 'b', clickup_task_id: 'cb', status: 'open' },
      { id: 'c', clickup_task_id: 'cc', status: 'ui/ux' },
    ]
    const map = new Map([['ca', 'in progress'], ['cb', 'in progress'], ['cc', 'done']])
    const groups = groupStatusUpdates(tasks, map)
    expect(groups.get('in progress')).toEqual(['a', 'b'])
    expect(groups.get('done')).toEqual(['c'])
    expect(groups.size).toBe(2)
  })

  it('skips tasks whose status is unchanged', () => {
    const groups = groupStatusUpdates(
      [{ id: 'a', clickup_task_id: 'ca', status: 'open' }],
      new Map([['ca', 'open']])
    )
    expect(groups.size).toBe(0)
  })

  it('skips tasks missing from the status map (list not fetched)', () => {
    const groups = groupStatusUpdates(
      [{ id: 'a', clickup_task_id: 'ca', status: 'open' }],
      new Map()
    )
    expect(groups.size).toBe(0)
  })

  it('collapses N changed tasks into one group per distinct status', () => {
    const tasks = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, clickup_task_id: `c${i}`, status: 'open' }))
    const map = new Map(tasks.map((t) => [t.clickup_task_id, 'in progress']))
    const groups = groupStatusUpdates(tasks, map)
    // 50 changed tasks → 1 batched UPDATE, not 50 concurrent ones.
    expect(groups.size).toBe(1)
    expect(groups.get('in progress')).toHaveLength(50)
  })
})

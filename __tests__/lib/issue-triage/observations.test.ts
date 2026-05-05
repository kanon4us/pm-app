// __tests__/lib/issue-triage/observations.test.ts
const mockInsert = jest.fn().mockResolvedValue({ error: null })
const mockFrom = jest.fn().mockReturnValue({ insert: mockInsert })

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({ from: mockFrom }),
}))

describe('recordObservation', () => {
  beforeEach(() => mockInsert.mockClear())

  it('inserts a row into bot_observations', async () => {
    const { recordObservation } = await import('@/lib/issue-triage/observations')
    await recordObservation('1234.0001', 'task-abc', 1, 'ticket_created', { confidence: 0.1 })

    expect(mockFrom).toHaveBeenCalledWith('bot_observations')
    expect(mockInsert).toHaveBeenCalledWith({
      thread_ts: '1234.0001',
      clickup_task_id: 'task-abc',
      sop_version: 1,
      event_type: 'ticket_created',
      payload: { confidence: 0.1 },
    })
  })

  it('accepts null clickup_task_id for tickets not yet created', async () => {
    const { recordObservation } = await import('@/lib/issue-triage/observations')
    await expect(
      recordObservation('1234.0001', null, 1, 'ticket_created', {})
    ).resolves.not.toThrow()
  })
})

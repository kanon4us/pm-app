// __tests__/lib/issue-triage/sop.test.ts
import type { BotSop } from '@/lib/issue-triage/types'

const mockSingle = jest.fn()
const mockEq = jest.fn().mockReturnThis()
const mockSelect = jest.fn().mockReturnThis()
const mockFrom = jest.fn().mockReturnValue({ select: mockSelect, eq: mockEq, single: mockSingle })

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({ from: mockFrom }),
}))

const fakeSop: BotSop = {
  id: 'sop-1',
  version: 1,
  intake_prompt: 'You are a helpful bot.',
  escalation_rules: { maxTurns: 8, disengagementThreshold: 2, minConfidenceMovementPerTurn: 0.05 },
  duplicate_thresholds: { possible: 0.60, confirmed: 0.85, collisionWindowHours: 24, collisionCount: 3 },
  manual_directives: [],
  status: 'active',
  change_summary: null,
  approved_by: null,
  approved_at: null,
  created_at: new Date().toISOString(),
}

describe('getActiveSop', () => {
  beforeEach(() => { jest.resetModules(); mockSingle.mockReset() })

  it('returns the active SOP from Supabase', async () => {
    mockSingle.mockResolvedValue({ data: fakeSop, error: null })
    const { getActiveSop } = await import('@/lib/issue-triage/sop')
    const result = await getActiveSop()
    expect(result.version).toBe(1)
    expect(result.intake_prompt).toBe('You are a helpful bot.')
  })

  it('throws when no active SOP exists', async () => {
    mockSingle.mockResolvedValue({ data: null, error: { message: 'No rows' } })
    const { getActiveSop } = await import('@/lib/issue-triage/sop')
    await expect(getActiveSop()).rejects.toThrow('No active SOP found')
  })
})

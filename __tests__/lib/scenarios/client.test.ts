import { createScenario, updateScenario, createStep, updateStep, deleteStep, getScenarioSteps } from '@/lib/scenarios/client'

jest.mock('@/lib/supabase/server')

function mockChain(returnValue: unknown) {
  return {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue(returnValue),
    order: jest.fn().mockResolvedValue(returnValue),
  }
}

describe('createScenario', () => {
  let mockFrom: jest.Mock
  let mockSupabase: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom = jest.fn()
    mockSupabase = { from: mockFrom }
    const { getSupabaseServiceClient } = require('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(mockSupabase)
  })

  it('inserts a scenario', async () => {
    const scenario = { id: 'sc-1', user_story_id: 's-1', title: 'Happy Path', description: null, display_order: 0 }
    mockFrom.mockReturnValue(mockChain({ data: scenario, error: null }))
    const result = await createScenario({ user_story_id: 's-1', title: 'Happy Path' })
    expect(result).toEqual(scenario)
  })
})

describe('updateScenario', () => {
  let mockFrom: jest.Mock
  let mockSupabase: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom = jest.fn()
    mockSupabase = { from: mockFrom }
    const { getSupabaseServiceClient } = require('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(mockSupabase)
  })

  it('updates a scenario', async () => {
    const scenario = { id: 'sc-1', user_story_id: 's-1', title: 'Updated', description: 'desc', display_order: 1 }
    mockFrom.mockReturnValue(mockChain({ data: scenario, error: null }))
    const result = await updateScenario('sc-1', { title: 'Updated' })
    expect(result).toEqual(scenario)
  })
})

describe('createStep', () => {
  let mockFrom: jest.Mock
  let mockSupabase: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom = jest.fn()
    mockSupabase = { from: mockFrom }
    const { getSupabaseServiceClient } = require('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(mockSupabase)
  })

  it('inserts a step', async () => {
    const step = { id: 'st-1', scenario_id: 'sc-1', title: 'Landing', description: null, figma_url: null, figma_frame_id: null, figma_thumbnail_url: null, display_order: 0 }
    mockFrom.mockReturnValue(mockChain({ data: step, error: null }))
    const result = await createStep({ scenario_id: 'sc-1', title: 'Landing' })
    expect(result).toEqual(step)
  })
})

describe('updateStep', () => {
  let mockFrom: jest.Mock
  let mockSupabase: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom = jest.fn()
    mockSupabase = { from: mockFrom }
    const { getSupabaseServiceClient } = require('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(mockSupabase)
  })

  it('updates a step', async () => {
    const step = { id: 'st-1', scenario_id: 'sc-1', title: 'Updated Landing', description: 'desc', figma_url: null, figma_frame_id: null, figma_thumbnail_url: null, display_order: 0 }
    mockFrom.mockReturnValue(mockChain({ data: step, error: null }))
    const result = await updateStep('st-1', { title: 'Updated Landing' })
    expect(result).toEqual(step)
  })
})

describe('deleteStep', () => {
  let mockFrom: jest.Mock
  let mockSupabase: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom = jest.fn()
    mockSupabase = { from: mockFrom }
    const { getSupabaseServiceClient } = require('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(mockSupabase)
  })

  it('deletes a step by id', async () => {
    const chain = {
      delete: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ error: null }),
      }),
    }
    mockFrom.mockReturnValue(chain)
    await expect(deleteStep('st-1')).resolves.not.toThrow()
    expect(mockFrom).toHaveBeenCalledWith('steps')
  })

  it('throws on delete error', async () => {
    const chain = {
      delete: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ error: { message: 'delete failed' } }),
      }),
    }
    mockFrom.mockReturnValue(chain)
    await expect(deleteStep('st-1')).rejects.toThrow('delete failed')
  })
})

describe('getScenarioSteps', () => {
  let mockFrom: jest.Mock
  let mockSupabase: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom = jest.fn()
    mockSupabase = { from: mockFrom }
    const { getSupabaseServiceClient } = require('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(mockSupabase)
  })

  it('returns steps for a scenario ordered by display_order', async () => {
    const steps = [
      { id: 'st-1', scenario_id: 'sc-1', title: 'Step 1', description: null, figma_url: null, figma_frame_id: null, figma_thumbnail_url: null, display_order: 0 },
      { id: 'st-2', scenario_id: 'sc-1', title: 'Step 2', description: null, figma_url: null, figma_frame_id: null, figma_thumbnail_url: null, display_order: 1 },
    ]
    mockFrom.mockReturnValue(mockChain({ data: steps, error: null }))
    const result = await getScenarioSteps('sc-1')
    expect(result).toEqual(steps)
  })

  it('returns empty array on error', async () => {
    mockFrom.mockReturnValue(mockChain({ data: null, error: { message: 'error' } }))
    const result = await getScenarioSteps('sc-1')
    expect(result).toEqual([])
  })
})

import { createFeature, getFeature, listFeatures, updateFeature, linkTask, unlinkTask } from '@/lib/features/client'

jest.mock('@/lib/supabase/server')

function mockChain(returnValue: unknown) {
  return {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    ilike: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue(returnValue),
    order: jest.fn().mockResolvedValue(returnValue),
  }
}

describe('createFeature', () => {
  let mockFrom: jest.Mock
  let mockSupabase: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom = jest.fn()
    mockSupabase = { from: mockFrom }
    const { getSupabaseServiceClient } = require('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(mockSupabase)
  })

  it('inserts a feature and returns it', async () => {
    const feature = { id: 'f-1', name: 'Login Flow', description: null, status: 'draft' as const, created_at: '', updated_at: '' }
    mockFrom.mockReturnValue(mockChain({ data: feature, error: null }))
    const result = await createFeature({ name: 'Login Flow' })
    expect(result).toEqual(feature)
    expect(mockFrom).toHaveBeenCalledWith('features')
  })

  it('throws when Supabase returns an error', async () => {
    mockFrom.mockReturnValue(mockChain({ data: null, error: { message: 'db error' } }))
    await expect(createFeature({ name: 'x' })).rejects.toThrow('db error')
  })
})

describe('getFeature', () => {
  let mockFrom: jest.Mock
  let mockSupabase: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom = jest.fn()
    mockSupabase = { from: mockFrom }
    const { getSupabaseServiceClient } = require('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(mockSupabase)
  })

  it('returns a feature by id', async () => {
    const feature = { id: 'f-1', name: 'Login Flow', description: null, status: 'draft' as const, created_at: '', updated_at: '' }
    mockFrom.mockReturnValue(mockChain({ data: feature, error: null }))
    const result = await getFeature('f-1')
    expect(result).toEqual(feature)
    expect(mockFrom).toHaveBeenCalledWith('features')
  })

  it('returns null when not found', async () => {
    mockFrom.mockReturnValue(mockChain({ data: null, error: { message: 'not found' } }))
    const result = await getFeature('f-999')
    expect(result).toBeNull()
  })
})

describe('listFeatures', () => {
  let mockFrom: jest.Mock
  let mockSupabase: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom = jest.fn()
    mockSupabase = { from: mockFrom }
    const { getSupabaseServiceClient } = require('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(mockSupabase)
  })

  it('returns all features ordered by created_at', async () => {
    const features = [
      { id: 'f-1', name: 'A', description: null, status: 'draft' as const, created_at: '', updated_at: '' },
      { id: 'f-2', name: 'B', description: null, status: 'active' as const, created_at: '', updated_at: '' },
    ]
    mockFrom.mockReturnValue(mockChain({ data: features, error: null }))
    const result = await listFeatures()
    expect(result).toEqual(features)
    expect(mockFrom).toHaveBeenCalledWith('features')
  })

  it('filters by name query', async () => {
    const features = [{ id: 'f-1', name: 'Login', description: null, status: 'draft' as const, created_at: '', updated_at: '' }]
    mockFrom.mockReturnValue(mockChain({ data: features, error: null }))
    const result = await listFeatures('Login')
    expect(result).toEqual(features)
  })

  it('returns empty array on error', async () => {
    mockFrom.mockReturnValue(mockChain({ data: null, error: { message: 'error' } }))
    const result = await listFeatures()
    expect(result).toEqual([])
  })
})

describe('updateFeature', () => {
  let mockFrom: jest.Mock
  let mockSupabase: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom = jest.fn()
    mockSupabase = { from: mockFrom }
    const { getSupabaseServiceClient } = require('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(mockSupabase)
  })

  it('updates a feature and returns it', async () => {
    const updated = { id: 'f-1', name: 'Updated', description: 'desc', status: 'active' as const, created_at: '', updated_at: '' }
    mockFrom.mockReturnValue(mockChain({ data: updated, error: null }))
    const result = await updateFeature('f-1', { name: 'Updated' })
    expect(result).toEqual(updated)
  })

  it('throws on update error', async () => {
    mockFrom.mockReturnValue(mockChain({ data: null, error: { message: 'update failed' } }))
    await expect(updateFeature('f-1', { name: 'x' })).rejects.toThrow('update failed')
  })
})

describe('linkTask', () => {
  let mockFrom: jest.Mock
  let mockSupabase: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom = jest.fn()
    mockSupabase = { from: mockFrom }
    const { getSupabaseServiceClient } = require('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(mockSupabase)
  })

  it('inserts into feature_tasks', async () => {
    const insertChain = {
      insert: jest.fn().mockResolvedValue({ data: null, error: null }),
    }
    mockFrom.mockReturnValue(insertChain)
    await linkTask('f-1', 'task-1')
    expect(mockFrom).toHaveBeenCalledWith('feature_tasks')
    expect(insertChain.insert).toHaveBeenCalledWith([{ feature_id: 'f-1', task_id: 'task-1' }])
  })

  it('ignores duplicate key errors', async () => {
    const insertChain = {
      insert: jest.fn().mockResolvedValue({ data: null, error: { message: 'duplicate key', code: '23505' } }),
    }
    mockFrom.mockReturnValue(insertChain)
    await linkTask('f-1', 'task-1')
    expect(mockFrom).toHaveBeenCalledWith('feature_tasks')
  })

  it('throws on other errors', async () => {
    const insertChain = {
      insert: jest.fn().mockResolvedValue({ data: null, error: { message: 'other error' } }),
    }
    mockFrom.mockReturnValue(insertChain)
    await expect(linkTask('f-1', 'task-1')).rejects.toThrow('other error')
  })
})

describe('unlinkTask', () => {
  let mockFrom: jest.Mock
  let mockSupabase: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom = jest.fn()
    mockSupabase = { from: mockFrom }
    const { getSupabaseServiceClient } = require('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(mockSupabase)
  })

  it('deletes from feature_tasks', async () => {
    const chain = {
      delete: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      }),
    }
    mockFrom.mockReturnValue(chain)
    await unlinkTask('f-1', 'task-1')
    expect(mockFrom).toHaveBeenCalledWith('feature_tasks')
  })

  it('throws on delete error', async () => {
    const chain = {
      delete: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: { message: 'delete failed' } }),
        }),
      }),
    }
    mockFrom.mockReturnValue(chain)
    await expect(unlinkTask('f-1', 'task-1')).rejects.toThrow('delete failed')
  })
})

import { createUserStory, updateUserStory, linkStory, unlinkStory, forkStory, getStoryFeatureCount } from '@/lib/user-stories/client'

jest.mock('@/lib/supabase/server')

function chain(ret: unknown) {
  return {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue(ret),
    count: jest.fn().mockReturnThis(),
    order: jest.fn().mockResolvedValue(ret),
  }
}

describe('createUserStory', () => {
  let mockFrom: jest.Mock
  let mockSupabase: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom = jest.fn()
    mockSupabase = { from: mockFrom }
    const { getSupabaseServiceClient } = require('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(mockSupabase)
  })

  it('inserts and returns the story', async () => {
    const story = { id: 's-1', title: 'T', as_a: 'PM', i_want: 'x', so_that: 'y', created_at: '' }
    mockFrom.mockReturnValue(chain({ data: story, error: null }))
    const result = await createUserStory({ title: 'T', as_a: 'PM', i_want: 'x', so_that: 'y' })
    expect(result).toEqual(story)
  })

  it('throws when Supabase returns an error', async () => {
    mockFrom.mockReturnValue(chain({ data: null, error: { message: 'db error' } }))
    await expect(createUserStory({ title: 'T', as_a: 'PM', i_want: 'x', so_that: 'y' })).rejects.toThrow('db error')
  })
})

describe('updateUserStory', () => {
  let mockFrom: jest.Mock
  let mockSupabase: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom = jest.fn()
    mockSupabase = { from: mockFrom }
    const { getSupabaseServiceClient } = require('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(mockSupabase)
  })

  it('updates and returns the story', async () => {
    const story = { id: 's-1', title: 'Updated', as_a: 'PM', i_want: 'x', so_that: 'y', created_at: '' }
    mockFrom.mockReturnValue(chain({ data: story, error: null }))
    const result = await updateUserStory('s-1', { title: 'Updated' })
    expect(result).toEqual(story)
  })

  it('throws on update error', async () => {
    mockFrom.mockReturnValue(chain({ data: null, error: { message: 'update failed' } }))
    await expect(updateUserStory('s-1', { title: 'x' })).rejects.toThrow('update failed')
  })
})

describe('linkStory', () => {
  let mockFrom: jest.Mock
  let mockSupabase: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom = jest.fn()
    mockSupabase = { from: mockFrom }
    const { getSupabaseServiceClient } = require('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(mockSupabase)
  })

  it('inserts into feature_user_stories', async () => {
    const insertChain = {
      insert: jest.fn().mockResolvedValue({ data: null, error: null }),
    }
    mockFrom.mockReturnValue(insertChain)
    await linkStory('f-1', 's-1', 0)
    expect(mockFrom).toHaveBeenCalledWith('feature_user_stories')
    expect(insertChain.insert).toHaveBeenCalledWith([{ feature_id: 'f-1', user_story_id: 's-1', display_order: 0 }])
  })

  it('ignores duplicate key errors', async () => {
    const insertChain = {
      insert: jest.fn().mockResolvedValue({ data: null, error: { message: 'duplicate key', code: '23505' } }),
    }
    mockFrom.mockReturnValue(insertChain)
    await linkStory('f-1', 's-1')
    expect(mockFrom).toHaveBeenCalledWith('feature_user_stories')
  })

  it('throws on other errors', async () => {
    const insertChain = {
      insert: jest.fn().mockResolvedValue({ data: null, error: { message: 'other error' } }),
    }
    mockFrom.mockReturnValue(insertChain)
    await expect(linkStory('f-1', 's-1')).rejects.toThrow('other error')
  })
})

describe('unlinkStory', () => {
  let mockFrom: jest.Mock
  let mockSupabase: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom = jest.fn()
    mockSupabase = { from: mockFrom }
    const { getSupabaseServiceClient } = require('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(mockSupabase)
  })

  it('deletes from feature_user_stories', async () => {
    const c = {
      delete: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      }),
    }
    mockFrom.mockReturnValue(c)
    await unlinkStory('f-1', 's-1')
    expect(mockFrom).toHaveBeenCalledWith('feature_user_stories')
  })

  it('throws on delete error', async () => {
    const c = {
      delete: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: { message: 'delete failed' } }),
        }),
      }),
    }
    mockFrom.mockReturnValue(c)
    await expect(unlinkStory('f-1', 's-1')).rejects.toThrow('delete failed')
  })
})

describe('getStoryFeatureCount', () => {
  let mockFrom: jest.Mock
  let mockSupabase: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom = jest.fn()
    mockSupabase = { from: mockFrom }
    const { getSupabaseServiceClient } = require('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(mockSupabase)
  })

  it('returns count of features for a story', async () => {
    const c = {
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ count: 3, error: null }),
      }),
    }
    mockFrom.mockReturnValue(c)
    const result = await getStoryFeatureCount('s-1')
    expect(result).toBe(3)
  })

  it('returns 0 on error', async () => {
    const c = {
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ count: null, error: { message: 'error' } }),
      }),
    }
    mockFrom.mockReturnValue(c)
    const result = await getStoryFeatureCount('s-1')
    expect(result).toBe(0)
  })
})

describe('forkStory', () => {
  let mockFrom: jest.Mock
  let mockSupabase: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom = jest.fn()
    mockSupabase = { from: mockFrom }
    const { getSupabaseServiceClient } = require('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(mockSupabase)
  })

  it('creates a copy with the same fields', async () => {
    const original = { id: 's-1', title: 'T', as_a: 'PM', i_want: 'x', so_that: 'y', created_at: '' }
    const forked = { ...original, id: 's-2' }

    mockFrom
      .mockReturnValueOnce(chain({ data: original, error: null })) // getStory
      .mockReturnValueOnce(chain({ data: forked, error: null }))   // insert fork
      .mockReturnValueOnce(chain({ data: null, error: null }))     // link fork to feature

    const result = await forkStory('s-1', 'f-1')
    expect(result.id).toBe('s-2')
    expect(result.title).toBe('T')
  })

  it('throws when story not found', async () => {
    mockFrom.mockReturnValue(chain({ data: null, error: { message: 'not found' } }))
    await expect(forkStory('s-999', 'f-1')).rejects.toThrow('Story not found')
  })

  it('throws when fork insert fails', async () => {
    const original = { id: 's-1', title: 'T', as_a: 'PM', i_want: 'x', so_that: 'y', created_at: '' }
    mockFrom
      .mockReturnValueOnce(chain({ data: original, error: null }))
      .mockReturnValueOnce(chain({ data: null, error: { message: 'insert failed' } }))

    await expect(forkStory('s-1', 'f-1')).rejects.toThrow('Fork failed')
  })
})

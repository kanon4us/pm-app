// __tests__/lib/features/context.test.ts
import { buildFeatureContext } from '@/lib/features/context'

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({
    from: jest.fn().mockImplementation((table: string) => {
      if (table === 'features') return { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), single: jest.fn().mockResolvedValue({ data: { id: 'f-1', name: 'Login', description: 'Auth flow', status: 'draft' }, error: null }) }
      if (table === 'feature_user_stories') return { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), order: jest.fn().mockResolvedValue({ data: [{ user_stories: { id: 's-1', title: 'T', as_a: 'PM', i_want: 'log in', so_that: 'access app' }, display_order: 0 }], error: null }) }
      if (table === 'scenarios') return { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), order: jest.fn().mockResolvedValue({ data: [{ id: 'sc-1', title: 'Happy Path', description: null, display_order: 0 }], error: null }) }
      if (table === 'steps') return { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), order: jest.fn().mockResolvedValue({ data: [{ id: 'st-1', title: 'Landing', description: 'User arrives', figma_url: 'https://figma.com/design/abc', figma_thumbnail_url: 'https://proj.supabase.co/img.png', display_order: 0 }], error: null }) }
      return { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), single: jest.fn().mockResolvedValue({ data: null, error: null }) }
    }),
  }),
}))

describe('buildFeatureContext', () => {
  it('includes feature name and status', async () => {
    const ctx = await buildFeatureContext('f-1')
    expect(ctx).toContain('Feature: Login')
    expect(ctx).toContain('Status: draft')
  })

  it('includes user story in as_a/i_want/so_that format', async () => {
    const ctx = await buildFeatureContext('f-1')
    expect(ctx).toContain('As a PM, I want log in so that access app')
  })

  it('includes scenario and step with image reference', async () => {
    const ctx = await buildFeatureContext('f-1')
    expect(ctx).toContain('Scenario: Happy Path')
    expect(ctx).toContain('Step 1: Landing')
    expect(ctx).toContain('https://proj.supabase.co/img.png')
  })
})

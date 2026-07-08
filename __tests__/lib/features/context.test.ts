// __tests__/lib/features/context.test.ts
import { buildFeatureContext } from '@/lib/features/context'

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({
    from: jest.fn().mockImplementation((table: string) => {
      if (table === 'features') return { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), single: jest.fn().mockResolvedValue({ data: { id: 'f-1', name: 'Login', description: 'Auth flow', status: 'draft', objectives_json: { objectives: [{ index: 3, name: 'User Success', notes: 'reduce friction' }] }, ux_stitch: { summary: 'plan summary', workflows: [{ name: 'Onboarding' }] } }, error: null }) }
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
    expect(ctx).toContain('Scenario (id: sc-1): Happy Path')
    expect(ctx).toContain('Step 1: Landing')
    expect(ctx).toContain('https://proj.supabase.co/img.png')
  })

  it('renders objectives from objectives_json', async () => {
    const ctx = await buildFeatureContext('f-1')
    expect(ctx).toContain('--- Objectives (from ClickUp) ---')
    expect(ctx).toContain('User Success: reduce friction')
  })

  it('renders the ux_stitch structural plan block', async () => {
    const ctx = await buildFeatureContext('f-1')
    expect(ctx).toContain('--- UX Structural Plan (Gemini) ---')
    expect(ctx).toContain('"summary": "plan summary"')
  })
})

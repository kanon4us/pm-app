// __tests__/api/features/prototype.test.ts
import { POST } from '@/app/api/features/[id]/prototype/route'
import { NextRequest } from 'next/server'

jest.mock('@/lib/auth', () => ({ getSessionUser: jest.fn().mockResolvedValue({ email: 'pm@test.com' }) }))
jest.mock('@/lib/features/context', () => ({ buildFeatureContext: jest.fn().mockResolvedValue('Feature: Login') }))
jest.mock('@/lib/prototypes/storage', () => ({ ensureStepImages: jest.fn().mockImplementation((s) => Promise.resolve(s)) }))
jest.mock('@/lib/prototypes/generator', () => ({ generatePrototypeHtml: jest.fn().mockResolvedValue('<html>prototype</html>') }))
jest.mock('@/lib/prototypes/vault', () => ({ pushPrototypeToVault: jest.fn().mockResolvedValue({ vaultPath: 'prototypes/features/f-1/happy-path.html', vaultUrl: 'https://github.com/...' }) }))
jest.mock('@/lib/scenarios/client', () => ({ getScenarioSteps: jest.fn().mockResolvedValue([]) }))
jest.mock('@/lib/features/client', () => ({ getFeature: jest.fn().mockResolvedValue({ id: 'f-1', name: 'Login', status: 'draft' }) }))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockImplementation(() => {
    const chainMethods = {
      update: jest.fn(),
      insert: jest.fn(),
      select: jest.fn(),
      eq: jest.fn(),
      single: jest.fn().mockResolvedValue({ data: { id: 'p-1', feature_id: 'f-1', scenario_id: 'sc-1', is_current: true, html_content: '<html>prototype</html>', vault_url: 'https://github.com/...' }, error: null }),
    }
    // Make all methods chainable
    chainMethods.update.mockReturnValue(chainMethods)
    chainMethods.insert.mockReturnValue(chainMethods)
    chainMethods.select.mockReturnValue(chainMethods)
    chainMethods.eq.mockReturnValue(chainMethods)
    return Promise.resolve({ from: jest.fn().mockReturnValue(chainMethods) })
  }),
}))

describe('POST /api/features/[id]/prototype', () => {
  it('returns 201 with prototype record', async () => {
    const req = new NextRequest('http://localhost/api/features/f-1/prototype', {
      method: 'POST',
      body: JSON.stringify({ scenario_id: 'sc-1', scenario_title: 'Happy Path' }),
    })
    const res = await POST(req, { params: Promise.resolve({ id: 'f-1' }) })
    expect(res.status).toBe(201)
  })
})

// __tests__/lib/bot/retrieval.test.ts
import { buildEntitlementFilter } from '@/lib/bot/retrieval'
import type { BotJwtClaims } from '@/lib/bot/types'

const base: BotJwtClaims = {
  iss: 'viscap-cloud-functions',
  aud: 'pm-app-bot',
  exp: 0,
  userId: 'u1',
  teamId: 't1',
  email: 'u@viscap.ai',
  roles: [],
  entitlements: [],
}

describe('buildEntitlementFilter (server-side entitlements only)', () => {
  it('free user gets only the free product', () => {
    expect(buildEntitlementFilter(base)).toBe('product_id:[help-resources-free] && superseded:false')
  })

  it('owned products are appended', () => {
    const f = buildEntitlementFilter({ ...base, entitlements: ['prod-a', 'prod-b'] })
    expect(f).toBe('product_id:[help-resources-free,prod-a,prod-b] && superseded:false')
  })

  it('deduplicates and drops empty strings', () => {
    const f = buildEntitlementFilter({ ...base, entitlements: ['prod-a', 'prod-a', '', 'help-resources-free'] })
    expect(f).toBe('product_id:[help-resources-free,prod-a] && superseded:false')
  })

  it('always excludes superseded lessons', () => {
    expect(buildEntitlementFilter(base)).toContain('superseded:false')
  })
})

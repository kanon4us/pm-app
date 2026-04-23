import { mergeRolesWithRegistry } from '../../lib/role-merge'

const mockRegistry = [
  { role_id: 'r1', role_name: 'Admin', team_domain: 'agency', influence_type: 'DM' as const, weight: 10 },
  { role_id: 'r2', role_name: 'Director', team_domain: 'agency', influence_type: 'DM' as const, weight: 9 },
  { role_id: 'r3', role_name: 'Copywriter', team_domain: 'agency', influence_type: 'NDM' as const, weight: 7 },
]

const mockProposed = [
  { roleName: 'Admin', usageFrequency: 3, reasoning: 'Uses this daily in workflow' },
]

describe('mergeRolesWithRegistry', () => {
  it('returns a row for every registry role', () => {
    const result = mergeRolesWithRegistry(mockRegistry, mockProposed)
    expect(result).toHaveLength(3)
  })

  it('fills proposed roles with Claude frequency and reasoning', () => {
    const result = mergeRolesWithRegistry(mockRegistry, mockProposed)
    const admin = result.find(r => r.roleName === 'Admin')!
    expect(admin.claudeProposedFrequency).toBe(3)
    expect(admin.claudeReasoning).toBe('Uses this daily in workflow')
    expect(admin.usageFrequency).toBe(3)
  })

  it('fills non-proposed roles with frequency 0 and null reasoning', () => {
    const result = mergeRolesWithRegistry(mockRegistry, mockProposed)
    const director = result.find(r => r.roleName === 'Director')!
    expect(director.claudeProposedFrequency).toBe(0)
    expect(director.claudeReasoning).toBeNull()
    expect(director.usageFrequency).toBe(0)
  })

  it('sets isUserOverride false for all merged roles', () => {
    const result = mergeRolesWithRegistry(mockRegistry, mockProposed)
    expect(result.every(r => r.isUserOverride === false)).toBe(true)
  })

  it('sets userOverrideFrequency and userReasoning to null for all merged roles', () => {
    const result = mergeRolesWithRegistry(mockRegistry, mockProposed)
    expect(result.every(r => r.userOverrideFrequency === null)).toBe(true)
    expect(result.every(r => r.userReasoning === null)).toBe(true)
  })

  it('preserves roleId from the registry', () => {
    const result = mergeRolesWithRegistry(mockRegistry, mockProposed)
    const admin = result.find(r => r.roleName === 'Admin')!
    expect(admin.roleId).toBe('r1')
  })
})

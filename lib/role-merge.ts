export interface RegistryRole {
  role_id: string
  role_name: string
  team_domain: string
  influence_type: 'DM' | 'NDM'
  weight: number
}

export interface ProposedRole {
  roleName: string
  usageFrequency: number
  reasoning: string
}

export interface FullRoleSelection {
  roleId: string
  roleName: string
  teamDomain: string
  influenceType: 'DM' | 'NDM'
  weight: number
  usageFrequency: number
  claudeProposedFrequency: number
  claudeReasoning: string | null
  userOverrideFrequency: number | null
  userReasoning: string | null
  isUserOverride: boolean
}

export function mergeRolesWithRegistry(
  registry: RegistryRole[],
  proposed: ProposedRole[]
): FullRoleSelection[] {
  const proposedMap = new Map(proposed.map(p => [p.roleName, p]))
  return registry.map(reg => {
    const match = proposedMap.get(reg.role_name)
    return {
      roleId: reg.role_id,
      roleName: reg.role_name,
      teamDomain: reg.team_domain,
      influenceType: reg.influence_type,
      weight: reg.weight,
      usageFrequency: match?.usageFrequency ?? 0,
      claudeProposedFrequency: match?.usageFrequency ?? 0,
      claudeReasoning: match?.reasoning ?? null,
      userOverrideFrequency: null,
      userReasoning: null,
      isUserOverride: false,
    }
  })
}

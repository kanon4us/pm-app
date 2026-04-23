import { buildAssessmentDoc } from '../../../lib/bundle-docs/assessment'

const mockObjectives = [
  { objectiveId: 1, objectiveName: 'Data Integrity', objectiveOwner: 'Engineering',
    score: 3, reasoning: 'Adds filtering to existing queries' },
]

const mockRoles = [
  { roleName: 'Admin', teamDomain: 'agency', influenceType: 'DM' as const,
    weight: 10, claudeProposedFrequency: 3, userOverrideFrequency: null,
    claudeReasoning: 'Uses archive filter daily', userReasoning: null },
  { roleName: 'Copywriter', teamDomain: 'agency', influenceType: 'NDM' as const,
    weight: 7, claudeProposedFrequency: 0, userOverrideFrequency: 2,
    claudeReasoning: null, userReasoning: 'They access brand lists regularly' },
]

const mockFVI = {
  fviScore: 6.2, decision: 'build-this-sprint' as const,
  iDmRaw: 30, iNdmRaw: 14, iDmNorm: 0.079, iNdmNorm: 0.063,
  invertedInfluence: 0.94, objTotal: 18,
}

describe('buildAssessmentDoc', () => {
  it('includes the task name and ClickUp ID', () => {
    const doc = buildAssessmentDoc({
      taskName: 'Restrict Archived Brands', clickupId: 'DEV-10405',
      objectives: mockObjectives, roles: mockRoles, fvi: mockFVI,
      effort: 3, riskLevel: 'Moderate', riskMultiplier: 1.5,
      conversationId: 'conv-123', experimentId: 'exp-v1', pmAppCommitSha: 'abc1234',
    })
    expect(doc).toContain('DEV-10405')
    expect(doc).toContain('Restrict Archived Brands')
  })

  it('includes FVI score and decision', () => {
    const doc = buildAssessmentDoc({
      taskName: 'Restrict Archived Brands', clickupId: 'DEV-10405',
      objectives: mockObjectives, roles: mockRoles, fvi: mockFVI,
      effort: 3, riskLevel: 'Moderate', riskMultiplier: 1.5,
      conversationId: 'conv-123',
    })
    expect(doc).toContain('6.2')
    expect(doc).toContain('build-this-sprint')
  })

  it('marks user-overridden roles with an indicator', () => {
    const doc = buildAssessmentDoc({
      taskName: 'Restrict Archived Brands', clickupId: 'DEV-10405',
      objectives: mockObjectives, roles: mockRoles, fvi: mockFVI,
      effort: 3, riskLevel: 'Moderate', riskMultiplier: 1.5,
      conversationId: 'conv-123',
    })
    expect(doc).toContain('Copywriter')
    expect(doc).toContain('human override')
  })

  it('includes experiment ID and pm-app commit SHA when provided', () => {
    const doc = buildAssessmentDoc({
      taskName: 'Restrict Archived Brands', clickupId: 'DEV-10405',
      objectives: mockObjectives, roles: mockRoles, fvi: mockFVI,
      effort: 3, riskLevel: 'Moderate', riskMultiplier: 1.5,
      conversationId: 'conv-123', experimentId: 'exp-v1', pmAppCommitSha: 'abc1234',
    })
    expect(doc).toContain('exp-v1')
    expect(doc).toContain('abc1234')
  })
})

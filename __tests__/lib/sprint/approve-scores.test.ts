import { resolveApproveScores } from '@/lib/sprint/approve-scores'

interface Role { roleId: string }

const fallback = { effortDays: 3, riskMultiplier: 1.2 }

describe('resolveApproveScores', () => {
  // The regression: finalizeProposal is null in scoring_review but approving
  // must still advance to the roles phase (not silently no-op).
  it('advances when finalizeProposal is null, using top-level effort/risk', () => {
    const action = resolveApproveScores<Role>(
      {
        finalizeProposal: null,
        proposedEffort: { days: 5 },
        proposedRisk: { multiplier: 1.5 },
      },
      fallback
    )
    expect(action).toEqual({
      kind: 'advance',
      phase: 'roles',
      roles: [],
      effortDays: 5,
      riskMultiplier: 1.5,
    })
  })

  it('advances even when finalizeProposal AND top-level proposals are missing', () => {
    const action = resolveApproveScores<Role>({ finalizeProposal: null }, fallback)
    expect(action.kind).toBe('advance')
    if (action.kind === 'advance') {
      expect(action.phase).toBe('roles')
      expect(action.roles).toEqual([])
      expect(action.effortDays).toBe(3) // fallback
      expect(action.riskMultiplier).toBe(1.2) // fallback
    }
  })

  it('prefers finalizeProposal values when present', () => {
    const roles: Role[] = [{ roleId: 'r1' }, { roleId: 'r2' }]
    const action = resolveApproveScores<Role>(
      {
        finalizeProposal: {
          proposedRoles: roles,
          proposedEffort: { days: 8 },
          proposedRisk: { multiplier: 2.0 },
        },
        proposedEffort: { days: 5 }, // should be ignored in favour of fp
        proposedRisk: { multiplier: 1.5 },
      },
      fallback
    )
    expect(action).toEqual({
      kind: 'advance',
      phase: 'roles',
      roles,
      effortDays: 8,
      riskMultiplier: 2.0,
    })
  })

  it('falls back per-field when finalizeProposal omits effort/risk', () => {
    const action = resolveApproveScores<Role>(
      {
        finalizeProposal: { proposedRoles: [{ roleId: 'r1' }] }, // no effort/risk
        proposedEffort: { days: 5 },
        proposedRisk: { multiplier: 1.5 },
      },
      fallback
    )
    if (action.kind !== 'advance') throw new Error('expected advance')
    expect(action.roles).toEqual([{ roleId: 'r1' }])
    expect(action.effortDays).toBe(5)
    expect(action.riskMultiplier).toBe(1.5)
  })

  it('no-ops only when there is no conversation at all', () => {
    expect(resolveApproveScores<Role>(null, fallback)).toEqual({ kind: 'noop' })
  })
})

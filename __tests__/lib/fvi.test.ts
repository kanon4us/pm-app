import {
  computeInfluence,
  computeInvertedInfluence,
  computeFVI,
  fviDecision,
  trojanHorseCheck,
  computeFullFVI,
  MAX_DM_SCORE,
  MAX_NDM_SCORE,
  FREQ_LABELS,
  RoleAssessment,
} from '@/lib/fvi'

describe('FVI constants', () => {
  test('MAX_DM_SCORE is 380', () => expect(MAX_DM_SCORE).toBe(380))
  test('MAX_NDM_SCORE is 224', () => expect(MAX_NDM_SCORE).toBe(224))
})

describe('computeInfluence', () => {
  test('no roles → zero influence', () => {
    const { iDmRaw, iNdmRaw, iDmNorm, iNdmNorm } = computeInfluence([])
    expect(iDmRaw).toBe(0)
    expect(iNdmRaw).toBe(0)
    expect(iDmNorm).toBe(0)
    expect(iNdmNorm).toBe(0)
  })

  test('single DM role weight 10, daily use (freq 4)', () => {
    const { iDmRaw, iDmNorm } = computeInfluence([
      { roleName: 'Admin', influenceType: 'DM', weight: 10, usageFrequency: 4 },
    ])
    expect(iDmRaw).toBe(40)
    expect(iDmNorm).toBeCloseTo(40 / 380, 5)
  })

  test('single NDM role weight 7, sometimes use (freq 3)', () => {
    const { iNdmRaw, iNdmNorm } = computeInfluence([
      { roleName: 'Copywriter', influenceType: 'NDM', weight: 7, usageFrequency: 3 },
    ])
    expect(iNdmRaw).toBe(21)
    expect(iNdmNorm).toBeCloseTo(21 / 224, 5)
  })
})

describe('computeInvertedInfluence', () => {
  test('zero influence → 1.0', () => {
    expect(computeInvertedInfluence(0, 0)).toBe(1.0)
  })

  test('max DM and NDM → clamped to 0.01', () => {
    // At full normalization: 1 - ((3×1 + 1) / 4) = 1 - 1 = 0 → clamped to 0.01
    expect(computeInvertedInfluence(1.0, 1.0)).toBe(0.01)
  })

  test('typical case: Admin daily (DM) + Copywriter sometimes (NDM)', () => {
    const iDmNorm = 40 / 380   // ≈ 0.1053
    const iNdmNorm = 21 / 224  // ≈ 0.0938
    const inv = computeInvertedInfluence(iDmNorm, iNdmNorm)
    // 1 - ((3 × 0.1053 + 0.0938) / 4) = 1 - (0.4097/4) = 1 - 0.1024 ≈ 0.8976
    expect(inv).toBeGreaterThan(0.85)
    expect(inv).toBeLessThan(0.95)
  })
})

describe('computeFVI', () => {
  test('typical feature: objTotal=10, invInf=0.9, effort=5, risk=1.2', () => {
    const fvi = computeFVI(10, 0.9, 5, 1.2)
    // (10 + 64) / (0.9 × 5 × 1.2) = 74 / 5.4 ≈ 13.7
    expect(fvi).toBeCloseTo(74 / 5.4, 1)
  })

  test('zero denominator returns 0', () => {
    expect(computeFVI(10, 0, 5, 1.0)).toBe(0)
  })

  test('negative objTotal still produces positive FVI (offset ensures this)', () => {
    // Worst case: -35 + 64 = 29 → still positive
    const fvi = computeFVI(-35, 0.5, 3, 1.0)
    expect(fvi).toBeGreaterThan(0)
  })
})

describe('fviDecision', () => {
  test('>= 5 → build-this-sprint', () => expect(fviDecision(7.5)).toBe('build-this-sprint'))
  test('2 to 5 → build-next-sprint', () => expect(fviDecision(3.0)).toBe('build-next-sprint'))
  test('0.5 to 2 → backlog', () => expect(fviDecision(1.0)).toBe('backlog'))
  test('0 to 0.5 → kill', () => expect(fviDecision(0.3)).toBe('kill'))
  test('negative → kill-immediately', () => expect(fviDecision(-1)).toBe('kill-immediately'))
  test('exactly 5 → build-this-sprint', () => expect(fviDecision(5.0)).toBe('build-this-sprint'))
  test('exactly 0.5 → backlog', () => expect(fviDecision(0.5)).toBe('backlog'))
})

describe('trojanHorseCheck', () => {
  test('Data=+5, Modular=-4 → Trojan Horse', () => {
    expect(trojanHorseCheck([
      { objectiveId: 1, score: 5 },
      { objectiveId: 2, score: -4 },
      { objectiveId: 3, score: 2 },
    ])).toBe(true)
  })

  test('Data=+5, UserSuccess=-5 → Trojan Horse', () => {
    expect(trojanHorseCheck([
      { objectiveId: 1, score: 5 },
      { objectiveId: 2, score: 0 },
      { objectiveId: 3, score: -5 },
    ])).toBe(true)
  })

  test('Data=+5, both fine → not Trojan Horse', () => {
    expect(trojanHorseCheck([
      { objectiveId: 1, score: 5 },
      { objectiveId: 2, score: 2 },
      { objectiveId: 3, score: 1 },
    ])).toBe(false)
  })

  test('Data=+3, bad Modular → not Trojan Horse (Data must be +5)', () => {
    expect(trojanHorseCheck([
      { objectiveId: 1, score: 3 },
      { objectiveId: 2, score: -5 },
      { objectiveId: 3, score: -5 },
    ])).toBe(false)
  })
})

describe('FREQ_LABELS', () => {
  it('exports 5 labels indexed 0-4', () => {
    expect(FREQ_LABELS).toHaveLength(5)
    expect(FREQ_LABELS[0]).toBe('Cannot Access')
    expect(FREQ_LABELS[1]).toBe('Access Sometimes')
    expect(FREQ_LABELS[2]).toBe('Access by Default')
    expect(FREQ_LABELS[3]).toBe('Uses Sometimes')
    expect(FREQ_LABELS[4]).toBe('Uses Every Day')
  })
})

describe('computeInfluence with 0-frequency roles', () => {
  it('excludes roles with usageFrequency 0 from influence totals', () => {
    const roles: RoleAssessment[] = [
      { roleName: 'Admin', influenceType: 'DM', weight: 10, usageFrequency: 0 },
      { roleName: 'Director', influenceType: 'DM', weight: 9, usageFrequency: 2 },
    ]
    const result = computeInfluence(roles)
    // Only Director contributes: 9 * 2 = 18
    expect(result.iDmRaw).toBe(18)
  })

  it('returns zero influence when all roles are 0-frequency', () => {
    const roles: RoleAssessment[] = [
      { roleName: 'Admin', influenceType: 'DM', weight: 10, usageFrequency: 0 },
    ]
    const result = computeInfluence(roles)
    expect(result.iDmRaw).toBe(0)
    expect(result.iNdmRaw).toBe(0)
  })
})

describe('computeFullFVI — end-to-end', () => {
  test('feature with good scores, moderate influence, standard effort', () => {
    const scores = [
      { objectiveId: 1, score: 3 },
      { objectiveId: 2, score: 2 },
      { objectiveId: 3, score: 3 },
      { objectiveId: 4, score: 1 },
      { objectiveId: 5, score: 0 },
      { objectiveId: 6, score: 1 },
      { objectiveId: 7, score: 2 },
    ] // total = 12
    const roles = [
      { roleName: 'Admin', influenceType: 'DM' as const, weight: 10, usageFrequency: 4 },
      { roleName: 'Creative Strategist', influenceType: 'DM' as const, weight: 10, usageFrequency: 3 },
      { roleName: 'Copywriter', influenceType: 'NDM' as const, weight: 7, usageFrequency: 2 },
    ]
    const result = computeFullFVI(scores, roles, 5, 1.2)
    expect(result.objTotal).toBe(12)
    expect(result.fviScore).toBeGreaterThan(2)  // should be worth building
    expect(result.trojanHorse).toBe(false)
    expect(result.decision).toBeTruthy()
  })

  test('Trojan Horse is detected even when FVI is high', () => {
    const scores = [
      { objectiveId: 1, score: 5 },
      { objectiveId: 2, score: -5 },
      { objectiveId: 3, score: 3 },
      { objectiveId: 4, score: 3 },
      { objectiveId: 5, score: 2 },
      { objectiveId: 6, score: 1 },
      { objectiveId: 7, score: 2 },
    ]
    const result = computeFullFVI(scores, [], 3, 1.0)
    expect(result.trojanHorse).toBe(true)
  })
})

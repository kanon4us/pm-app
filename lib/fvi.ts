/**
 * FVI (Feature Value Index) calculation library.
 * Single source of truth for all FVI math — never compute FVI inline elsewhere.
 *
 * Formula: FVI = (ObjTotal + 64) / (InvertedInfluence × Effort × Risk)
 * Inverted Influence = 1 − ((3 × I_DM_norm + I_NDM_norm) / 4)
 *
 * Reference: documentation/00-Meta/FVI-Rubric.md
 */

// Theoretical maximum raw scores for normalization.
// DM roles: agency(10+10+8+9+7+5+6=55) + brand(10+10+9+5+6=40) = 95 × max_freq(4) = 380
// NDM roles: agency(5+4+3+1+7+4+2+1+1+1=29) + brand(5+4+3+7+4+2+1+1=27) = 56 × 4 = 224
export const MAX_DM_SCORE = 380
export const MAX_NDM_SCORE = 224

export interface RoleAssessment {
  roleName: string
  influenceType: 'DM' | 'NDM'
  weight: number
  usageFrequency: number // 1=Access Default, 2=Access Sometimes, 3=Uses Sometimes, 4=Uses Every Day
}

export interface ObjectiveScore {
  objectiveId: number
  score: number // -5 to +5
}

export interface FVIResult {
  objTotal: number
  iDmRaw: number
  iNdmRaw: number
  iDmNorm: number
  iNdmNorm: number
  invertedInfluence: number
  fviScore: number
  decision: FVIDecision
  trojanHorse: boolean
}

export type FVIDecision =
  | 'build-this-sprint'
  | 'build-next-sprint'
  | 'backlog'
  | 'kill'
  | 'kill-immediately'

export const RISK_LEVELS = [
  { label: 'Routine',  multiplier: 1.0, description: 'We have done this 100 times. Isolated, easy to revert.' },
  { label: 'Standard', multiplier: 1.2, description: 'Standard feature work using existing patterns.' },
  { label: 'Moderate', multiplier: 1.5, description: '3rd-party integration or minor DB change.' },
  { label: 'High',     multiplier: 2.0, description: 'Touches login, billing, permissions, or creative formula.' },
  { label: 'Critical', multiplier: 3.0, description: 'New AI model, payment provider switch, or core refactor.' },
] as const

export function computeInfluence(roles: RoleAssessment[]): {
  iDmRaw: number
  iNdmRaw: number
  iDmNorm: number
  iNdmNorm: number
} {
  let iDmRaw = 0
  let iNdmRaw = 0
  for (const r of roles) {
    const roleScore = r.weight * r.usageFrequency
    if (r.influenceType === 'DM') iDmRaw += roleScore
    else iNdmRaw += roleScore
  }
  return {
    iDmRaw,
    iNdmRaw,
    iDmNorm: iDmRaw / MAX_DM_SCORE,
    iNdmNorm: iNdmRaw / MAX_NDM_SCORE,
  }
}

export function computeInvertedInfluence(iDmNorm: number, iNdmNorm: number): number {
  const raw = 1 - (3 * iDmNorm + iNdmNorm) / 4
  // Clamp to [0.01, 1.0] to prevent division by zero and negative values
  return Math.max(0.01, Math.min(1.0, raw))
}

export function computeFVI(
  objTotal: number,
  invertedInfluence: number,
  effort: number,
  risk: number
): number {
  const denominator = invertedInfluence * effort * risk
  if (denominator <= 0) return 0
  return (objTotal + 64) / denominator
}

export function fviDecision(fvi: number): FVIDecision {
  if (fvi < 0) return 'kill-immediately'
  if (fvi < 0.5) return 'kill'
  if (fvi < 2.0) return 'backlog'
  if (fvi < 5.0) return 'build-next-sprint'
  return 'build-this-sprint'
}

export function fviDecisionLabel(decision: FVIDecision): string {
  switch (decision) {
    case 'build-this-sprint': return 'Build This Sprint'
    case 'build-next-sprint': return 'Build Next Sprint'
    case 'backlog':           return 'Backlog — revisit next quarter'
    case 'kill':              return 'Kill'
    case 'kill-immediately':  return 'Kill Immediately'
  }
}

/** Returns true if a Trojan Horse pattern is detected: Data=+5 but Modular≤-4 or UserSuccess≤-4 */
export function trojanHorseCheck(scores: ObjectiveScore[]): boolean {
  const data = scores.find((s) => s.objectiveId === 1)?.score ?? 0
  const modular = scores.find((s) => s.objectiveId === 2)?.score ?? 0
  const userSuccess = scores.find((s) => s.objectiveId === 3)?.score ?? 0
  return data >= 5 && (modular <= -4 || userSuccess <= -4)
}

/** Full computation from roles + objective scores + effort + risk */
export function computeFullFVI(
  scores: ObjectiveScore[],
  roles: RoleAssessment[],
  effort: number,
  risk: number
): FVIResult {
  const objTotal = scores.reduce((sum, s) => sum + s.score, 0)
  const { iDmRaw, iNdmRaw, iDmNorm, iNdmNorm } = computeInfluence(roles)
  const invertedInfluence = computeInvertedInfluence(iDmNorm, iNdmNorm)
  const fviScore = computeFVI(objTotal, invertedInfluence, effort, risk)
  return {
    objTotal,
    iDmRaw,
    iNdmRaw,
    iDmNorm,
    iNdmNorm,
    invertedInfluence,
    fviScore: Math.round(fviScore * 100) / 100,
    decision: fviDecision(fviScore),
    trojanHorse: trojanHorseCheck(scores),
  }
}

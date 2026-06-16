// Decision logic for the "Approve scores" action in the assessment modal,
// extracted from app/sprint/page.tsx so it can be unit-tested.
//
// Regression context: approving must ALWAYS advance to the roles phase, even
// when finalizeProposal is null (a reachable scoring_review state, e.g. via
// "Skip to roles"). A prior `if (!fp) return` guard made the button silently do
// nothing. This module encodes "do we advance, and with what data" so that
// behaviour is pinned by tests.

export interface ApproveScoresConversation<Role> {
  finalizeProposal: {
    proposedRoles?: Role[]
    proposedEffort?: { days?: number | null } | null
    proposedRisk?: { multiplier?: number | null } | null
  } | null
  proposedEffort?: { days?: number | null } | null
  proposedRisk?: { multiplier?: number | null } | null
}

export type ApproveScoresAction<Role> =
  | { kind: 'noop' }
  | { kind: 'advance'; phase: 'roles'; roles: Role[]; effortDays: number; riskMultiplier: number }

export function resolveApproveScores<Role>(
  conversation: ApproveScoresConversation<Role> | null,
  fallback: { effortDays: number; riskMultiplier: number }
): ApproveScoresAction<Role> {
  // Only a missing conversation is a genuine no-op. A null finalizeProposal is
  // NOT — we fall back to the conversation's top-level proposal and advance.
  if (!conversation) return { kind: 'noop' }

  const fp = conversation.finalizeProposal
  return {
    kind: 'advance',
    phase: 'roles',
    roles: fp?.proposedRoles ?? [],
    effortDays: fp?.proposedEffort?.days ?? conversation.proposedEffort?.days ?? fallback.effortDays,
    riskMultiplier: fp?.proposedRisk?.multiplier ?? conversation.proposedRisk?.multiplier ?? fallback.riskMultiplier,
  }
}

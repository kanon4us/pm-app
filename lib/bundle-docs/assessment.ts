import { FREQ_LABELS } from '../fvi'

interface ObjectiveRow {
  objectiveId: number
  objectiveName: string
  objectiveOwner: string
  score: number
  reasoning: string
}

interface RoleRow {
  roleName: string
  teamDomain: string
  influenceType: 'DM' | 'NDM'
  weight: number
  claudeProposedFrequency: number
  userOverrideFrequency: number | null
  claudeReasoning: string | null
  userReasoning: string | null
}

interface FVIShape {
  fviScore: number
  decision: string
  iDmRaw: number
  iNdmRaw: number
  iDmNorm: number
  iNdmNorm: number
  invertedInfluence: number
  objTotal: number
}

interface AssessmentDocInput {
  taskName: string
  clickupId: string
  objectives: ObjectiveRow[]
  roles: RoleRow[]
  fvi: FVIShape
  effort: number
  riskLevel: string
  riskMultiplier: number
  conversationId: string
  experimentId?: string
  pmAppCommitSha?: string
}

export function buildAssessmentDoc(input: AssessmentDocInput): string {
  const {
    taskName, clickupId, objectives, roles, fvi,
    effort, riskLevel, riskMultiplier,
    conversationId, experimentId, pmAppCommitSha,
  } = input

  const activeFreq = (r: RoleRow) => r.userOverrideFrequency ?? r.claudeProposedFrequency

  const dmRoles = roles.filter(r => r.influenceType === 'DM')
  const ndmRoles = roles.filter(r => r.influenceType === 'NDM')

  const roleRow = (r: RoleRow) => {
    const freq = activeFreq(r)
    const label = FREQ_LABELS[freq] ?? 'Unknown'
    const source = r.userOverrideFrequency !== null ? ' *(human override)*' : ''
    const reasoning = r.userOverrideFrequency !== null
      ? (r.userReasoning ?? '')
      : (r.claudeReasoning ?? '')
    return `| ${r.roleName} | ${r.teamDomain} | ${r.weight} | ${freq} — ${label}${source} | ${reasoning} |`
  }

  const objRows = objectives.map(o =>
    `| ${o.objectiveId} | ${o.objectiveName} | ${o.objectiveOwner} | ${o.score >= 0 ? '+' : ''}${o.score} | ${o.reasoning} |`
  ).join('\n')

  const dmRows = dmRoles.map(roleRow).join('\n')
  const ndmRows = ndmRoles.map(roleRow).join('\n')

  const metaLines = [
    experimentId ? `experiment: ${experimentId}` : null,
    pmAppCommitSha ? `pm-app-commit: ${pmAppCommitSha}` : null,
    `conversation: ${conversationId}`,
    `generated: ${new Date().toISOString()}`,
  ].filter(Boolean).join('\n')

  return `# Assessment: ${taskName}

**ClickUp:** ${clickupId}

\`\`\`
${metaLines}
\`\`\`

---

## FVI Result

| Metric | Value |
|---|---|
| FVI Score | **${fvi.fviScore.toFixed(2)}** |
| Decision | **${fvi.decision}** |
| I-DM (raw) | ${fvi.iDmRaw} / 380 |
| I-NDM (raw) | ${fvi.iNdmRaw} / 224 |
| Inverted Influence | ${fvi.invertedInfluence.toFixed(4)} |
| Objective Total | ${fvi.objTotal} |
| Effort | ${effort} dev-days |
| Risk | ${riskLevel} (×${riskMultiplier}) |

---

## Developer Objectives

| # | Objective | Owner | Score | Reasoning |
|---|---|---|---|---|
${objRows}

---

## Role Influence — Decision Makers (I-DM)

| Role | Domain | Weight | Frequency | Reasoning |
|---|---|---|---|---|
${dmRows}

---

## Role Influence — Non-Decision Makers (I-NDM)

| Role | Domain | Weight | Frequency | Reasoning |
|---|---|---|---|---|
${ndmRows}
`
}

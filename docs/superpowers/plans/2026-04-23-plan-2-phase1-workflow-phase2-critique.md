# Plan 2: Phase 1 Workflow Audit + Phase 2 Critique Loop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Phase 1 (workflow standardization) to the assessment init prompt so Claude maps affected workflows before scoring; add a scoring-review phase with critique loop so users can give feedback that re-evaluates all 7 objectives with ripple-effect explanation; and add a reassessment confirmation dialog for tasks that already have an FVI score.

**Architecture:** DB migration adds `affected_workflows JSONB` to `assessment_conversations`. A new shared type file defines `AffectedWorkflow`. The init route gains a Phase 1 system-prompt block and returns `affectedWorkflows` in its response. The reply route gains a `critiqueMode` path that re-evaluates all 7 objectives and returns a `rippleEffect` string. The frontend gains a `'scoring_review'` phase (between interview and roles), a `'reassess_check'` phase (before loading for re-assessed tasks), and all associated state and handlers.

**Tech Stack:** Next.js App Router, Supabase (postgres), TypeScript, Ant Design, Anthropic SDK

---

### Task 1: DB migration — add `affected_workflows` column

**Files:**
- Create: `supabase/migrations/008_phase1_workflow_column.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/008_phase1_workflow_column.sql
alter table assessment_conversations
  add column if not exists affected_workflows jsonb;

comment on column assessment_conversations.affected_workflows
  is 'Phase 1 workflow audit: [{name,sopImpacted,educationImpacted,scribehowImpacted,registryStatus}]';
```

- [ ] **Step 2: Apply the migration**

Run: `npx supabase db query --linked < supabase/migrations/008_phase1_workflow_column.sql`
Expected: No error output (or "already exists" if re-run).

Then mark it as applied in the migration history:
Run: `npx supabase migration repair --status applied 20240101000008 2>/dev/null || true`
(Ignore errors — this is just to keep the local migration log in sync.)

- [ ] **Step 3: Run tests to verify no regressions**

Run: `npm test`
Expected: 99 passed, 0 failed.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/008_phase1_workflow_column.sql
git commit -m "feat: add affected_workflows column to assessment_conversations"
```

---

### Task 2: Shared `AffectedWorkflow` type

**Files:**
- Create: `lib/assessment-types.ts`
- Create: `__tests__/lib/assessment-types.test.ts`

- [ ] **Step 1: Write the type file**

```typescript
// lib/assessment-types.ts

export interface AffectedWorkflow {
  name: string
  sopImpacted: boolean
  educationImpacted: boolean
  scribehowImpacted: boolean
  registryStatus: 'existing' | 'proposed'
}
```

- [ ] **Step 2: Write the test**

```typescript
// __tests__/lib/assessment-types.test.ts
import type { AffectedWorkflow } from '@/lib/assessment-types'

describe('AffectedWorkflow', () => {
  it('accepts a valid existing workflow', () => {
    const w: AffectedWorkflow = {
      name: 'Create Campaign Brief',
      sopImpacted: true,
      educationImpacted: false,
      scribehowImpacted: true,
      registryStatus: 'existing',
    }
    expect(w.name).toBe('Create Campaign Brief')
    expect(w.registryStatus).toBe('existing')
  })

  it('accepts a proposed workflow', () => {
    const w: AffectedWorkflow = {
      name: 'Submit Change Order',
      sopImpacted: false,
      educationImpacted: true,
      scribehowImpacted: false,
      registryStatus: 'proposed',
    }
    expect(w.registryStatus).toBe('proposed')
  })
})
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npm test -- --testPathPattern=assessment-types`
Expected: PASS, 2 tests.

- [ ] **Step 4: Commit**

```bash
git add lib/assessment-types.ts __tests__/lib/assessment-types.test.ts
git commit -m "feat: add AffectedWorkflow shared type"
```

---

### Task 3: Init route — Phase 1 workflow standardization

**Files:**
- Modify: `app/api/sprint/tasks/[id]/assess/init/route.ts`

Read this file before editing. Key locations:
- Line 174: `const systemPrompt = \`You are the Viscap PM Agent...`
- Line 196: `Your response MUST be valid JSON matching this exact structure...` — the JSON schema block
- Line 213: `const userMessage = ...`
- Lines 273–283: `supabase.from('assessment_conversations').insert({...})`
- Lines 295–304: `return NextResponse.json({...})`

- [ ] **Step 1: Add `AffectedWorkflow` import**

Add at the top of the file (after the existing imports):

```typescript
import type { AffectedWorkflow } from '@/lib/assessment-types'
```

- [ ] **Step 2: Accept reassessment options from request body**

The route currently ignores the request body. Change the function signature to read it:

```typescript
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as {
    considerExistingNotes?: boolean
    specificFeedback?: string
  }
  const considerExistingNotes = body.considerExistingNotes ?? true
  const specificFeedback = body.specificFeedback ?? ''
```

- [ ] **Step 3: Update `reassessmentContext` to use the new params**

Find the existing `reassessmentContext` string (around line 170–172):

```typescript
const reassessmentContext = isReassessment && lastAssessment
  ? `\n\nPREVIOUS ASSESSMENT (${lastAssessment.created_at.slice(0, 10)}): FVI was ${lastAssessment.fvi_score?.toFixed(2) ?? 'N/A'}. Previous scores: ${JSON.stringify(lastAssessment.final_scores)}. Note what may have changed since then.`
  : ''
```

Replace with:

```typescript
const reassessmentContext = isReassessment && lastAssessment
  ? `\n\nPREVIOUS ASSESSMENT (${lastAssessment.created_at.slice(0, 10)}): FVI was ${lastAssessment.fvi_score?.toFixed(2) ?? 'N/A'}. Previous scores: ${JSON.stringify(lastAssessment.final_scores)}.${considerExistingNotes ? ' Use these previous notes as context when scoring.' : ' Start fresh — do not anchor on previous scores.'}${specificFeedback ? ` PM feedback on what changed: ${specificFeedback}` : ''}`
  : ''
```

- [ ] **Step 4: Add Phase 1 instructions to the system prompt**

In the `systemPrompt` string, find the line:

```
TROJAN HORSE RULE: If Obj1(Data)=+5 AND (Obj2(Modular)≤-4 OR Obj3(UserSuccess)≤-4) → flag as Trojan Horse.
```

Insert the following BEFORE that line:

```
PHASE 1 — WORKFLOW STANDARDIZATION:
Before proposing objective scores, identify all workflows this feature affects. A workflow is a named, repeatable process within the Viscap platform (e.g., "Create Campaign Brief", "Review Media Plan", "Submit Change Order").

For each affected workflow:
- name: Standardized title-case name matching or derived from Viscap documentation manuals
- registryStatus: "existing" if this matches a known Viscap workflow, "proposed" if this would be a new manual entry  
- sopImpacted: true if this changes internal team operating procedures
- educationImpacted: true if this changes customer-facing lesson content sold to customers
- scribehowImpacted: true if this changes step-by-step ScribeHow tutorial documentation

Your clarifying questions should surface: (1) which workflows change (not just what the feature does), (2) edge cases and failure modes, (3) which roles are directly vs. indirectly affected. Ask at least 2 workflow-focused questions BEFORE asking objective-specific questions.

```

- [ ] **Step 5: Add `affectedWorkflows` to the JSON response schema in the system prompt**

Find the JSON schema block in `systemPrompt`. It starts with:

```
Your response MUST be valid JSON matching this exact structure — no markdown, no explanation outside JSON:
{
  "proposedScores": [
```

Add `"affectedWorkflows"` as the FIRST field in the schema, before `"proposedScores"`:

```
Your response MUST be valid JSON matching this exact structure — no markdown, no explanation outside JSON:
{
  "affectedWorkflows": [
    {"name":"<title-case workflow name>","registryStatus":"existing|proposed","sopImpacted":<true|false>,"educationImpacted":<true|false>,"scribehowImpacted":<true|false>}
  ],
  "proposedScores": [
```

- [ ] **Step 6: Parse `affectedWorkflows` from the Claude response**

After the JSON parse block (around line 264), Claude's response is in `assessment`. Add:

```typescript
const affectedWorkflows: AffectedWorkflow[] = (
  assessment.affectedWorkflows as AffectedWorkflow[] | undefined
) ?? []
```

- [ ] **Step 7: Persist `affected_workflows` to the DB**

Find the `supabase.from('assessment_conversations').insert({...})` block (around lines 273–282). Add `affected_workflows` to the insert:

```typescript
const { data: conv } = await supabase
  .from('assessment_conversations')
  .insert({
    task_id: id,
    status: 'in_progress',
    vault_context: { filesRead: vaultFilesRead, hasVault: vaultConnected } as unknown as import('@/lib/supabase/types').Json,
    proposed_scores: assessment.proposedScores as unknown as import('@/lib/supabase/types').Json,
    affected_workflows: affectedWorkflows as unknown as import('@/lib/supabase/types').Json,
  })
  .select('id')
  .single()
```

- [ ] **Step 8: Include `affectedWorkflows` in the API response**

Find the `return NextResponse.json({...})` block (around lines 295–304). Add `affectedWorkflows`:

```typescript
return NextResponse.json({
  conversationId: conv?.id,
  ...assessment,
  affectedWorkflows,
  proposedRoles: fullRoles,
  figmaThumbUrl,
  figmaLink,
  vaultConnected,
  vaultFilesRead,
  isReassessment,
})
```

- [ ] **Step 9: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add "app/api/sprint/tasks/[id]/assess/init/route.ts" lib/assessment-types.ts
git commit -m "feat: add Phase 1 workflow standardization to assessment init prompt"
```

---

### Task 4: Reply route — critique loop

**Files:**
- Modify: `app/api/sprint/tasks/[id]/assess/[conversationId]/reply/route.ts`

Read this file before editing. Key locations:
- Line 22: `const { answer, objectiveId } = await req.json()` — body parsing
- Line 68: `const systemPrompt = \`You are the Viscap PM Agent...` — system prompt
- Line 102: `const userMessage = \`ASSESSMENT HISTORY...` — user message
- Lines 143–163: post-response processing (update scores, save next question)

- [ ] **Step 1: Update body parsing to accept critique mode**

Replace line 22:
```typescript
const { answer, objectiveId } = await req.json()
```
With:
```typescript
const body = await req.json() as {
  answer?: string
  objectiveId?: number
  critiqueMode?: boolean
  critiqueText?: string
  currentScores?: Array<{ objectiveId: number; score: number; reasoning: string }>
}
const { answer, objectiveId, critiqueMode, critiqueText, currentScores } = body
```

- [ ] **Step 2: Save user answer only in normal mode**

Find the `await supabase.from('assessment_messages').insert({...})` block that saves the user answer (around line 46–51). Wrap it in a guard:

```typescript
// Save user answer (only in normal Q&A mode, not critique)
if (!critiqueMode && answer && objectiveId !== undefined) {
  await supabase.from('assessment_messages').insert({
    conversation_id: conversationId,
    role: 'user',
    content: answer,
    objective_id: objectiveId,
  })
}
```

- [ ] **Step 3: Add `rippleEffect` to the finalize schema in the normal system prompt**

Find the `IF ready to finalize` JSON block in the existing system prompt:

```
IF ready to finalize (no more questions needed):
{
  "type": "finalize",
  ...
  "vaultSpecContent": "<full markdown content...>"
}
```

Add `"rippleEffect"` to that block:

```
IF ready to finalize (no more questions needed):
{
  "type": "finalize",
  "updatedScore": {"objectiveId":<id>,"score":<-5 to 5>,"confidence":"high","reasoning":"<reasoning>"},
  "allScores": [{"objectiveId":<1-7>,"objectiveName":"...","objectiveOwner":"...","score":<-5 to 5>,"reasoning":"<1-2 sentences>"}],
  "proposedRoles": [{"roleName":"...","teamDomain":"agency|brand","influenceType":"DM|NDM","weight":<number>,"usageFrequency":<1-4>,"reasoning":"..."}],
  "proposedEffort": {"days":<number>,"reasoning":"..."},
  "proposedRisk": {"level":"Routine|Standard|Moderate|High|Critical","multiplier":<1.0|1.2|1.5|2.0|3.0>,"reasoning":"..."},
  "vaultSpecContent": "<full markdown content for the vault spec stub, following Feature-Spec-Template.md format>",
  "rippleEffect": null
}
```

- [ ] **Step 4: Add the critique branch before the Anthropic call**

Find the section where `systemPrompt` and `userMessage` are defined (around lines 68–108). Change the structure so that critique mode uses its own prompt. Replace the current prompt building block with:

```typescript
  let systemPrompt: string
  let userMessage: string

  if (critiqueMode) {
    const scoresText = (currentScores ?? [])
      .map((s) => `Obj ${s.objectiveId}: score=${s.score} | reasoning: ${s.reasoning}`)
      .join('\n')

    systemPrompt = `You are the Viscap PM Agent re-evaluating FVI objective scores based on PM feedback.

THE 7 OBJECTIVES:
${objectivesText}

CURRENT PROPOSED SCORES:
${scoresText}

The PM has reviewed these scores and provided feedback. You must:
1. Re-evaluate ALL 7 objectives in light of the feedback — not just the one mentioned.
2. Explain the ripple effect: how adjusting the primary score influenced the other objectives and why.
3. The PM must approve the full modified set before proceeding.

Your response MUST be valid JSON — no markdown, no text outside JSON:
{
  "type": "finalize",
  "updatedScore": {"objectiveId":<primary objective mentioned in feedback>,"score":<-5 to 5>,"confidence":"high","reasoning":"<updated reasoning>"},
  "allScores": [{"objectiveId":<1-7>,"objectiveName":"...","objectiveOwner":"...","score":<-5 to 5>,"reasoning":"<1-2 sentences>"}],
  "proposedRoles": [{"roleName":"...","teamDomain":"agency|brand","influenceType":"DM|NDM","weight":<number>,"usageFrequency":<1-4>,"reasoning":"..."}],
  "proposedEffort": {"days":<number>,"reasoning":"..."},
  "proposedRisk": {"level":"Routine|Standard|Moderate|High|Critical","multiplier":<1.0|1.2|1.5|2.0|3.0>,"reasoning":"..."},
  "vaultSpecContent": "<full markdown for vault spec stub>",
  "rippleEffect": "<2-4 sentences explaining how the primary score change influenced the other 6 objectives>"
}`

    userMessage = `PM FEEDBACK ON SCORES:
"${critiqueText ?? ''}"

Re-evaluate all 7 objectives and explain the ripple effect.`

  } else {
    // ── Normal Q&A mode ──────────────────────────────────────────────────────
    const historyText = (priorMessages ?? []).map((m) => {
      const label = m.role === 'assistant' ? `PM Agent (about Obj ${m.objective_id})` : 'User'
      return `${label}: ${m.content}`
    }).join('\n\n')

    systemPrompt = `You are the Viscap PM Agent continuing an FVI assessment interview.

You have proposed scores for all 7 objectives. The user has just answered a question about one objective. Your job is to:
1. Update the score for the objective the question was about, based on the answer.
2. Determine if there are other low-confidence objectives still needing a question.
3. If yes: return the next question.
4. If no (all objectives confidently scored): return a finalization proposal.

THE 7 OBJECTIVES:
${objectivesText}

Current proposed scores (may need updating based on new answer):
${proposedScores.map((s) => `Obj ${s.objectiveId}: score=${s.score}, confidence=${s.confidence}`).join('\n')}

Your response MUST be valid JSON — no markdown, no text outside JSON:

IF more questions are needed:
{
  "type": "question",
  "updatedScore": {"objectiveId":<id>,"score":<-5 to 5>,"confidence":"high|medium|low","reasoning":"<updated reasoning>"},
  "nextQuestion": {"objectiveId":<id>,"objectiveName":"...","objectiveOwner":"...","question":"...","reasoning":"...","evidence":"...","currentProposedScore":<score>}
}

IF ready to finalize (no more questions needed):
{
  "type": "finalize",
  "updatedScore": {"objectiveId":<id>,"score":<-5 to 5>,"confidence":"high","reasoning":"<reasoning>"},
  "allScores": [{"objectiveId":<1-7>,"objectiveName":"...","objectiveOwner":"...","score":<-5 to 5>,"reasoning":"<1-2 sentences>"}],
  "proposedRoles": [{"roleName":"...","teamDomain":"agency|brand","influenceType":"DM|NDM","weight":<number>,"usageFrequency":<1-4>,"reasoning":"..."}],
  "proposedEffort": {"days":<number>,"reasoning":"..."},
  "proposedRisk": {"level":"Routine|Standard|Moderate|High|Critical","multiplier":<1.0|1.2|1.5|2.0|3.0>,"reasoning":"..."},
  "vaultSpecContent": "<full markdown content for the vault spec stub, following Feature-Spec-Template.md format>",
  "rippleEffect": null
}`

    userMessage = `ASSESSMENT HISTORY:
${historyText}

USER JUST ANSWERED (about Objective ${objectiveId ?? '?'}):
"${answer ?? ''}"

Based on this answer, update the score for Objective ${objectiveId ?? '?'} and determine whether more questions are needed or you can finalize.`
  }
```

Note: You will need to remove the original `systemPrompt` and `userMessage` const declarations since they are now inside the if/else. Also move the `historyText` variable so it only exists inside the normal Q&A branch.

- [ ] **Step 5: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: 99 passed, 0 failed.

- [ ] **Step 7: Commit**

```bash
git add "app/api/sprint/tasks/[id]/assess/[conversationId]/reply/route.ts"
git commit -m "feat: add critique loop to reply route — re-evaluate all 7 objectives with ripple effect"
```

---

### Task 5: Frontend types + new state variables

**Files:**
- Modify: `app/sprint/page.tsx` (types section at top, useState section)

Read this file before editing. Key locations:
- Line 58: `interface FinalizeProposal`
- Line 67: `interface AssessConversation`
- Line 138: `type AssessPhase`
- Lines 224–236: `useState` declarations for the assessment section

- [ ] **Step 1: Add `rippleEffect` to `FinalizeProposal`**

Find the `FinalizeProposal` interface (line 58). Add one field:

```typescript
interface FinalizeProposal {
  allScores: ProposedScore[]
  proposedRoles: RoleSelection[]
  proposedEffort: { days: number; reasoning: string }
  proposedRisk: { level: string; multiplier: number; reasoning: string }
  vaultSpecContent: string
  updatedDescription?: string
  rippleEffect?: string
}
```

- [ ] **Step 2: Add `affectedWorkflows` to `AssessConversation`**

Find the `AssessConversation` interface (line 67). Add `affectedWorkflows` as the last field before the closing brace:

```typescript
interface AssessConversation {
  conversationId: string
  proposedScores: ProposedScore[]
  currentQuestion: AssessQuestion | null
  totalEstimatedQuestions: number
  questionsAnswered: number
  overlappingTasks: OverlappingTask[]
  costOfNotBuilding: string
  workflowGapAssessment: string
  proposedRisk: { level: string; multiplier: number; reasoning: string }
  proposedEffort: { days: number; reasoning: string }
  isReassessment: boolean
  previousScoreSummary: string | null
  figmaThumbUrl: string | null
  figmaLink: string
  vaultConnected: boolean
  vaultFilesRead: string[]
  finalizeProposal: FinalizeProposal | null
  affectedWorkflows: import('@/lib/assessment-types').AffectedWorkflow[]
}
```

- [ ] **Step 3: Add `'scoring_review'` and `'reassess_check'` to `AssessPhase`**

Find line 138:
```typescript
type AssessPhase = 'idle' | 'loading' | 'interview' | 'roles' | 'confirming' | 'results'
```

Replace with:
```typescript
type AssessPhase = 'idle' | 'loading' | 'reassess_check' | 'interview' | 'scoring_review' | 'roles' | 'confirming' | 'results'
```

- [ ] **Step 4: Add new state variables**

Find the AI Assessment state block (around line 223). Add three new state vars after the existing assessment state declarations:

```typescript
  const [critiqueText, setCritiqueText] = useState('')
  const [rippleEffect, setRippleEffect] = useState<string | null>(null)
  const [reassessChoice, setReassessChoice] = useState<{ considerNotes: boolean; feedback: string } | null>(null)
```

- [ ] **Step 5: TypeScript check**

Run: `npx tsc --noEmit`
Expected: errors only for new undefined references (critiqueText/rippleEffect/reassessChoice not yet wired — that's fine, they come in Task 6 & 7).

- [ ] **Step 6: Commit**

```bash
git add app/sprint/page.tsx
git commit -m "feat: add scoring_review/reassess_check phases and AffectedWorkflow state to assessment modal"
```

---

### Task 6: Frontend — scoring_review phase

**Files:**
- Modify: `app/sprint/page.tsx` — handlers (`initAssessment`, `handleAnswer`, `openAssess`) and UI block

Read `app/sprint/page.tsx` before editing. Key locations:
- `function openAssess()` around line 316
- `async function initAssessment()` around line 331
- `async function handleAnswer()` around line 374
- The `{/* ── Interview ── */}` UI block around line 969
- The `{/* ── Role Picker ── */}` UI block around line 1079

- [ ] **Step 1: Update `openAssess()` to reset new state vars**

Find `openAssess()` (around line 316). Add resets for the new state vars inside the function body, before `setAssessOpen(true)`:

```typescript
  function openAssess() {
    setAssessPhase('loading')
    setAssessError('')
    setConversation(null)
    setCurrentAnswer('')
    setConfirmResult(null)
    setBundleResult(null)
    setBundleError('')
    setDesignReview(null)
    setDesignReviewLoading(false)
    setDivergenceOpen(false)
    setCritiqueText('')
    setRippleEffect(null)
    setReassessChoice(null)
    setAssessOpen(true)
    void initAssessment()
  }
```

(Reassessment check is wired in Task 7 — for now leave `void initAssessment()` unconditional.)

- [ ] **Step 2: Update `initAssessment()` to accept opts and populate `affectedWorkflows`**

Replace the current `async function initAssessment()` signature and the `const res = await apiFetch(...)` call:

```typescript
  async function initAssessment(opts?: { considerNotes?: boolean; specificFeedback?: string }) {
    if (!detailTask) return
    try {
      const res = await apiFetch(`/api/sprint/tasks/${detailTask.id}/assess/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          considerExistingNotes: opts?.considerNotes ?? true,
          specificFeedback: opts?.specificFeedback ?? '',
        }),
      })
```

- [ ] **Step 3: Update `initAssessment()` conversation building block**

Replace the block that builds `conv` and the `if (!data.firstQuestion...)` routing (around lines 338–367) with:

```typescript
      const noQuestionsNeeded = !data.firstQuestion || data.totalEstimatedQuestions === 0

      const conv: AssessConversation = {
        conversationId: data.conversationId,
        proposedScores: data.proposedScores ?? [],
        currentQuestion: data.firstQuestion ?? null,
        totalEstimatedQuestions: data.totalEstimatedQuestions ?? 0,
        questionsAnswered: 0,
        overlappingTasks: data.overlappingTasks ?? [],
        costOfNotBuilding: data.costOfNotBuilding ?? '',
        workflowGapAssessment: data.workflowGapAssessment ?? '',
        proposedRisk: data.proposedRisk ?? { level: 'Standard', multiplier: 1.2, reasoning: '' },
        proposedEffort: data.proposedEffort ?? { days: 3, reasoning: '' },
        isReassessment: data.isReassessment ?? false,
        previousScoreSummary: data.previousScoreSummary ?? null,
        figmaThumbUrl: data.figmaThumbUrl ?? null,
        figmaLink: data.figmaLink ?? '',
        vaultConnected: data.vaultConnected ?? false,
        vaultFilesRead: data.vaultFilesRead ?? [],
        affectedWorkflows: data.affectedWorkflows ?? [],
        // When no questions needed, build a synthetic finalizeProposal from init data
        finalizeProposal: noQuestionsNeeded ? {
          allScores: (data.proposedScores ?? []).map((s: ProposedScore) => ({ ...s, confidence: 'high' as const })),
          proposedRoles: data.proposedRoles ?? [],
          proposedEffort: data.proposedEffort ?? { days: 3, reasoning: '' },
          proposedRisk: data.proposedRisk ?? { level: 'Standard', multiplier: 1.2, reasoning: '' },
          vaultSpecContent: data.vaultSpecContent ?? '',
        } : null,
      }
      setConversation(conv)
      setConfirmedEffort(data.proposedEffort?.days ?? 3)
      setConfirmedRisk(data.proposedRisk?.multiplier ?? 1.2)

      if (noQuestionsNeeded) {
        setAssessPhase('scoring_review')   // Phase 2: let user review before roles
      } else {
        setAssessPhase('interview')
      }
```

- [ ] **Step 4: Update `handleAnswer()` to route to `'scoring_review'` after finalize**

Find the `} else {` block in `handleAnswer` that handles the finalize case (around line 401). The current code calls `setAssessPhase('roles')`. Replace with `setAssessPhase('scoring_review')` and include `affectedWorkflows`:

```typescript
      } else {
        // finalize → go to scoring_review for critique loop
        const finalScores: ProposedScore[] = (data.allScores ?? updatedScores).map((s: ProposedScore) => ({
          ...s,
          confidence: 'high' as const,
        }))
        setRippleEffect(null)
        setConversation({
          ...conversation,
          proposedScores: finalScores,
          questionsAnswered: conversation.questionsAnswered + 1,
          finalizeProposal: {
            allScores: finalScores,
            proposedRoles: data.proposedRoles ?? [],
            proposedEffort: data.proposedEffort ?? { days: confirmedEffort, reasoning: '' },
            proposedRisk: data.proposedRisk ?? { level: 'Standard', multiplier: confirmedRisk, reasoning: '' },
            vaultSpecContent: data.vaultSpecContent ?? '',
            updatedDescription: data.updatedDescription,
            rippleEffect: data.rippleEffect,
          },
        })
        setAssessPhase('scoring_review')   // was 'roles'
      }
```

- [ ] **Step 5: Add `handleCritique()` handler**

Add this function after `skipToRoles()` (around line 431):

```typescript
  async function handleCritique() {
    if (!conversation || !critiqueText.trim()) return
    const scores = (conversation.finalizeProposal?.allScores ?? conversation.proposedScores).map((s) => ({
      objectiveId: s.objectiveId,
      score: s.score,
      reasoning: s.reasoning,
    }))
    setAssessPhase('loading')
    try {
      const res = await apiFetch(
        `/api/sprint/tasks/${detailTask!.id}/assess/${conversation.conversationId}/reply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ critiqueMode: true, critiqueText, currentScores: scores }),
        }
      )
      const data = await res.json()
      if (!res.ok) { setAssessError(data.error ?? 'Critique failed'); setAssessPhase('scoring_review'); return }

      if (data.type === 'finalize') {
        const finalScores: ProposedScore[] = (data.allScores ?? []).map((s: ProposedScore) => ({
          ...s,
          confidence: 'high' as const,
        }))
        setRippleEffect(data.rippleEffect ?? null)
        setCritiqueText('')
        setConversation({
          ...conversation,
          proposedScores: finalScores,
          finalizeProposal: {
            allScores: finalScores,
            proposedRoles: data.proposedRoles ?? conversation.finalizeProposal?.proposedRoles ?? [],
            proposedEffort: data.proposedEffort ?? conversation.finalizeProposal?.proposedEffort ?? { days: confirmedEffort, reasoning: '' },
            proposedRisk: data.proposedRisk ?? conversation.finalizeProposal?.proposedRisk ?? { level: 'Standard', multiplier: confirmedRisk, reasoning: '' },
            vaultSpecContent: data.vaultSpecContent ?? conversation.finalizeProposal?.vaultSpecContent ?? '',
            updatedDescription: data.updatedDescription,
            rippleEffect: data.rippleEffect,
          },
        })
      }
      setAssessPhase('scoring_review')
    } catch (e) {
      setAssessError(e instanceof Error ? e.message : 'Critique failed')
      setAssessPhase('scoring_review')
    }
  }
```

- [ ] **Step 6: Add `handleApproveScores()` handler**

Add right after `handleCritique()`:

```typescript
  function handleApproveScores() {
    if (!conversation) return
    const fp = conversation.finalizeProposal
    if (fp) {
      setRoleSelections(setupRolesFromProposal(fp.proposedRoles ?? []))
      setConfirmedEffort(fp.proposedEffort?.days ?? confirmedEffort)
      setConfirmedRisk(fp.proposedRisk?.multiplier ?? confirmedRisk)
    }
    setRippleEffect(null)
    setCritiqueText('')
    setAssessPhase('roles')
  }
```

- [ ] **Step 7: Add the scoring_review UI block**

Find the `{/* ── Interview ── */}` comment (around line 969). Insert the following block AFTER the closing `)}` of the interview block and BEFORE `{/* ── Role Picker ── */}`:

```tsx
        {/* ── Scoring Review ── */}
        {assessPhase === 'scoring_review' && conversation && (
          <Space direction="vertical" style={{ width: '100%' }}>
            {/* Affected Workflows */}
            {conversation.affectedWorkflows.length > 0 && (
              <div>
                <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>AFFECTED WORKFLOWS</Typography.Text>
                <div style={{ marginTop: 4 }}>
                  {conversation.affectedWorkflows.map((w, i) => (
                    <div key={i} style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 4, padding: '6px 8px', marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <Typography.Text style={{ color: '#e6edf3', fontSize: 12, fontWeight: 600 }}>{w.name}</Typography.Text>
                      {w.registryStatus === 'proposed' && <Tag color="orange" style={{ fontSize: 10 }}>proposed</Tag>}
                      {w.sopImpacted && <Tag color="blue" style={{ fontSize: 10 }}>SOP</Tag>}
                      {w.educationImpacted && <Tag color="purple" style={{ fontSize: 10 }}>Education</Tag>}
                      {w.scribehowImpacted && <Tag color="cyan" style={{ fontSize: 10 }}>ScribeHow</Tag>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Ripple Effect (shown after critique) */}
            {rippleEffect && (
              <div style={{ background: '#1c2128', border: '1px solid #388bfd', borderRadius: 6, padding: '10px 12px' }}>
                <Typography.Text style={{ color: '#58a6ff', fontSize: 11 }}>RIPPLE EFFECT</Typography.Text>
                <Typography.Paragraph style={{ color: '#e6edf3', fontSize: 12, margin: '4px 0 0' }}>
                  {rippleEffect}
                </Typography.Paragraph>
              </div>
            )}

            {/* Proposed scores */}
            <div>
              <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>PROPOSED SCORES — review and approve or provide feedback</Typography.Text>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginTop: 6 }}>
                {(conversation.finalizeProposal?.allScores ?? conversation.proposedScores).map((s) => (
                  <div key={s.objectiveId} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '4px 0' }}>
                    <Tag
                      color={s.score > 0 ? 'green' : s.score === 0 ? 'default' : 'red'}
                      style={{ fontSize: 11, minWidth: 32, textAlign: 'center', marginTop: 2 }}
                    >
                      {s.score > 0 ? '+' : ''}{s.score}
                    </Tag>
                    <div>
                      <Typography.Text style={{ color: '#e6edf3', fontSize: 11 }}>{s.objectiveName}</Typography.Text>
                      <Typography.Text style={{ color: '#8b949e', fontSize: 11, display: 'block' }}>{s.reasoning}</Typography.Text>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <Divider style={{ borderColor: '#21262d', margin: '4px 0' }} />

            {/* Critique input */}
            <div>
              <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>FEEDBACK (optional) — describe any score that seems wrong and why</Typography.Text>
              <Input.TextArea
                rows={2}
                value={critiqueText}
                onChange={(e) => setCritiqueText(e.target.value)}
                placeholder="e.g. Complexity should be higher — this touches the billing system…"
                style={{ marginTop: 6 }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button
                size="small"
                disabled={!critiqueText.trim()}
                onClick={handleCritique}
              >
                Submit feedback
              </Button>
              <Button type="primary" size="small" onClick={handleApproveScores}>
                Approve scores →
              </Button>
            </div>
          </Space>
        )}
```

- [ ] **Step 8: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Run full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 10: Commit**

```bash
git add app/sprint/page.tsx
git commit -m "feat: add scoring_review phase with critique loop and workflow display"
```

---

### Task 7: Frontend — reassessment confirmation dialog

**Files:**
- Modify: `app/sprint/page.tsx` — `openAssess()` and UI block

Read `app/sprint/page.tsx` before editing. Find `function openAssess()` (around line 316) and the `{assessPhase === 'loading' && ...}` block (around line 960).

- [ ] **Step 1: Update `openAssess()` to route to `'reassess_check'` for tasks with scores**

Replace the current `openAssess()` function body with:

```typescript
  function openAssess() {
    setAssessPhase('loading')
    setAssessError('')
    setConversation(null)
    setCurrentAnswer('')
    setConfirmResult(null)
    setBundleResult(null)
    setBundleError('')
    setDesignReview(null)
    setDesignReviewLoading(false)
    setDivergenceOpen(false)
    setCritiqueText('')
    setRippleEffect(null)
    setReassessChoice(null)
    setAssessOpen(true)

    if (detailTask?.fvi_score !== null && detailTask?.fvi_score !== undefined) {
      setAssessPhase('reassess_check')   // show confirmation for existing assessments
    } else {
      void initAssessment()
    }
  }
```

- [ ] **Step 2: Add the reassess_check UI block**

Find the `{assessPhase === 'loading' && ...}` block (around line 960). Insert the following BEFORE it:

```tsx
        {/* ── Reassessment Check ── */}
        {assessPhase === 'reassess_check' && detailTask && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div style={{ background: '#161b22', border: '1px solid #f0883e', borderRadius: 8, padding: '14px 16px' }}>
              <Typography.Text style={{ color: '#f0883e', fontSize: 12, fontWeight: 600 }}>
                This task already has an FVI assessment (score: {detailTask.fvi_score?.toFixed(2)}).
              </Typography.Text>
              <Typography.Paragraph style={{ color: '#8b949e', fontSize: 12, marginTop: 6, marginBottom: 0 }}>
                Running a fresh assessment will create a new conversation but won&apos;t overwrite the existing score until you confirm.
              </Typography.Paragraph>
            </div>

            <div style={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: 6, padding: '12px 14px' }}>
              <Typography.Text style={{ color: '#e6edf3', fontSize: 12 }}>Should Claude consider the existing notes?</Typography.Text>
              <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                <Button
                  size="small"
                  type={reassessChoice?.considerNotes === true ? 'primary' : 'default'}
                  onClick={() => setReassessChoice((prev) => ({ ...prev ?? { feedback: '' }, considerNotes: true }))}
                >
                  Yes, use existing notes
                </Button>
                <Button
                  size="small"
                  type={reassessChoice?.considerNotes === false ? 'primary' : 'default'}
                  onClick={() => setReassessChoice((prev) => ({ ...prev ?? { feedback: '' }, considerNotes: false }))}
                >
                  No, start fresh
                </Button>
              </div>

              {reassessChoice !== null && (
                <>
                  <Typography.Text style={{ color: '#8b949e', fontSize: 11, marginTop: 12, display: 'block' }}>
                    Anything specific that&apos;s wrong? (optional)
                  </Typography.Text>
                  <Input.TextArea
                    rows={2}
                    value={reassessChoice.feedback}
                    onChange={(e) => setReassessChoice((prev) => ({ ...prev!, feedback: e.target.value }))}
                    placeholder="e.g. The effort estimate was too low — we discovered a DB migration is needed…"
                    style={{ marginTop: 4 }}
                  />
                </>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button size="small" onClick={() => { setAssessOpen(false); setAssessPhase('idle') }}>
                Cancel
              </Button>
              <Button
                type="primary"
                size="small"
                disabled={reassessChoice === null}
                onClick={() => {
                  setAssessPhase('loading')
                  void initAssessment({ considerNotes: reassessChoice!.considerNotes, specificFeedback: reassessChoice!.feedback })
                }}
              >
                Start fresh assessment →
              </Button>
            </div>
          </Space>
        )}
```

- [ ] **Step 3: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Manual smoke test**

Run: `npm run dev`

Test 1 — New task (no existing FVI):
- Open the assessment modal for a task with `fvi_score === null`
- Expected: Goes straight to loading → interview (or scoring_review)

Test 2 — Re-assessed task:
- Open the assessment modal for a task with an existing `fvi_score`
- Expected: `reassess_check` phase appears with existing score shown
- Select "Yes, use existing notes" → both buttons highlight
- Click "Start fresh assessment →" → loading → interview (or scoring_review)

Test 3 — Full scoring review flow:
- Complete an assessment (answer questions or skip straight through)
- Expected: `scoring_review` phase shows, not `roles` phase
- Affected workflows section shows (may be empty on short assessments)
- Score list shows with reasoning
- Type something in feedback textarea → "Submit feedback" button enables
- Click "Submit feedback" → loading → scoring_review returns with ripple effect shown
- Click "Approve scores →" → roles phase appears

- [ ] **Step 6: Commit**

```bash
git add app/sprint/page.tsx
git commit -m "feat: add reassessment confirmation dialog before init for tasks with existing FVI"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Task |
|---|---|
| Phase 1: Map affected workflows with standardized names | Task 3 (init prompt + response) |
| Phase 1: Impact flags (SOP, Education, ScribeHow) | Task 3 (affectedWorkflows schema) |
| Phase 1: Proposed new workflow registry entries | Task 3 (registryStatus: "proposed") |
| Phase 1: At least 3 clarifying questions, workflow-first | Task 3 (prompt instruction) |
| Phase 1: Store affected_workflows in DB | Task 1 (migration) + Task 3 (DB insert) |
| Phase 2: Re-assess check — "Would you like to regenerate?" | Task 7 |
| Phase 2: Consider existing notes option | Task 3 (considerExistingNotes param) + Task 7 (UI) |
| Phase 2: Critique loop — re-evaluate all 7 with ripple effect | Task 4 (reply route) + Task 6 (UI) |
| Phase 2: User must approve full modified set | Task 6 (handleApproveScores gate) |
| Phase 2: Scoring visible before roles phase | Task 6 (scoring_review phase) |

### Placeholder scan

No TBD or TODO placeholders found. All code blocks are complete.

### Type consistency

- `AffectedWorkflow` defined in `lib/assessment-types.ts` (Task 2), imported in init route (Task 3) and frontend via inline import in interface (Task 5).
- `rippleEffect?: string` added to `FinalizeProposal` (Task 5), populated in `handleAnswer` finalize branch (Task 6) and `handleCritique` (Task 6).
- `affectedWorkflows: AffectedWorkflow[]` on `AssessConversation` (Task 5), populated in `initAssessment` (Task 6).
- `initAssessment(opts?)` signature updated in Task 6, called with opts in Task 7.

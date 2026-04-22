# Plan 1: Roles Phase Fixes + Override Model + assessment.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the roles phase so all 30 roles are always shown and editable, user overrides are tracked separately from Claude's proposals with mandatory reasoning, and every bundle writes a full assessment.md to the vault.

**Architecture:** Schema migration adds four override columns to conversation_role_assessments. A new server-side utility merges all registry roles with Claude's proposals before sending to the client. The roles UI is rebuilt to show all 30 roles with inline reasoning and override badges. The confirm route saves the full 30-role set. The bundle route gains a new assessment.md builder.

**Tech Stack:** Next.js App Router, Supabase (postgres), TypeScript, Jest

---

### Task 1: DB migration — add override columns

**Files:**
- Create: `supabase/migrations/007_role_override_model.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/007_role_override_model.sql
alter table conversation_role_assessments
  add column if not exists claude_proposed_frequency integer
    check (claude_proposed_frequency between 0 and 4),
  add column if not exists user_override_frequency integer
    check (user_override_frequency between 0 and 4),
  add column if not exists claude_reasoning text,
  add column if not exists user_reasoning text;

comment on column conversation_role_assessments.claude_proposed_frequency
  is 'Frequency Claude proposed (0=Cannot Access). 0 for roles Claude did not select.';
comment on column conversation_role_assessments.user_override_frequency
  is 'Frequency the user chose when overriding Claude. Null if user accepted Claude proposal.';
comment on column conversation_role_assessments.claude_reasoning
  is 'Claude reasoning for the proposed frequency. Null for roles Claude scored 0.';
comment on column conversation_role_assessments.user_reasoning
  is 'Required when user_override_frequency is set. Explains why the user corrected Claude.';
```

- [ ] **Step 2: Apply the migration locally**

Run: `npx supabase db push`
Expected: `Applying migration 007_role_override_model.sql... done`

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/007_role_override_model.sql
git commit -m "feat: add role override model columns to conversation_role_assessments"
```

---

### Task 2: Export FREQ_LABELS from lib/fvi.ts and accept 0-frequency roles

**Files:**
- Modify: `lib/fvi.ts`
- Modify: `__tests__/lib/fvi.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `__tests__/lib/fvi.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest __tests__/lib/fvi.test.ts -t "FREQ_LABELS" --no-coverage`
Expected: FAIL — `FREQ_LABELS` not exported

- [ ] **Step 3: Add FREQ_LABELS export and guard 0-frequency in computeInfluence**

In `lib/fvi.ts`, add near the top:

```typescript
export const FREQ_LABELS = [
  'Cannot Access',     // 0
  'Access Sometimes',  // 1
  'Access by Default', // 2
  'Uses Sometimes',    // 3
  'Uses Every Day',    // 4
] as const
```

In `computeInfluence`, filter out 0-frequency roles before calculating (roles with frequency 0 do not contribute to influence):

```typescript
export function computeInfluence(roles: RoleAssessment[]): {
  iDmRaw: number; iNdmRaw: number; iDmNorm: number; iNdmNorm: number
} {
  const active = roles.filter(r => r.usageFrequency > 0)
  const iDmRaw = active
    .filter(r => r.influenceType === 'DM')
    .reduce((sum, r) => sum + r.weight * r.usageFrequency, 0)
  const iNdmRaw = active
    .filter(r => r.influenceType === 'NDM')
    .reduce((sum, r) => sum + r.weight * r.usageFrequency, 0)
  return {
    iDmRaw,
    iNdmRaw,
    iDmNorm: iDmRaw / 380,
    iNdmNorm: iNdmRaw / 224,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest __tests__/lib/fvi.test.ts --no-coverage`
Expected: PASS — all existing + new tests green

- [ ] **Step 5: Commit**

```bash
git add lib/fvi.ts __tests__/lib/fvi.test.ts
git commit -m "feat: export FREQ_LABELS, exclude 0-frequency roles from influence"
```

---

### Task 3: New utility — mergeRolesWithRegistry

**Files:**
- Create: `lib/role-merge.ts`
- Create: `__tests__/lib/role-merge.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// __tests__/lib/role-merge.test.ts
import { mergeRolesWithRegistry } from '../../lib/role-merge'

const mockRegistry = [
  { role_id: 'r1', role_name: 'Admin', team_domain: 'agency', influence_type: 'DM', weight: 10 },
  { role_id: 'r2', role_name: 'Director', team_domain: 'agency', influence_type: 'DM', weight: 9 },
  { role_id: 'r3', role_name: 'Copywriter', team_domain: 'agency', influence_type: 'NDM', weight: 7 },
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
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/lib/role-merge.test.ts --no-coverage`
Expected: FAIL — module not found

- [ ] **Step 3: Implement mergeRolesWithRegistry**

```typescript
// lib/role-merge.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest __tests__/lib/role-merge.test.ts --no-coverage`
Expected: PASS — 4 tests green

- [ ] **Step 5: Commit**

```bash
git add lib/role-merge.ts __tests__/lib/role-merge.test.ts
git commit -m "feat: add mergeRolesWithRegistry utility"
```

---

### Task 4: Init route — return all 30 roles with per-role reasoning

**Files:**
- Modify: `app/api/sprint/tasks/[id]/assess/init/route.ts`

- [ ] **Step 1: Import mergeRolesWithRegistry and fetch full registry**

At the top of the file, add:

```typescript
import { mergeRolesWithRegistry } from '@/lib/role-merge'
```

Locate the existing `role_registry` fetch in the route handler. It already fetches roles — confirm the query returns `role_id, role_name, team_domain, influence_type, weight`. If it selects `*`, it's fine. If not, add those columns:

```typescript
const { data: allRoles } = await supabase
  .from('role_registry')
  .select('role_id, role_name, team_domain, influence_type, weight')
  .eq('is_active', true)
  .order('team_domain')
  .order('influence_type')
  .order('weight', { ascending: false })
```

- [ ] **Step 2: Merge proposed roles with registry before returning**

Find the section where `proposedRoles` is set from Claude's response. After parsing Claude's JSON, replace the direct return of `proposedRoles` with the merged list:

```typescript
// Claude still returns only the roles it considers affected (with reasoning)
// We merge those with the full registry to produce all 30 rows
const claudeProposed: Array<{ roleName: string; usageFrequency: number; reasoning: string }> =
  parsed.proposedRoles ?? []

const fullRoles = mergeRolesWithRegistry(allRoles ?? [], claudeProposed)

return NextResponse.json({
  // ... existing fields ...
  proposedRoles: fullRoles,   // now always 30 rows
})
```

- [ ] **Step 3: Verify manually**

Run the dev server: `npm run dev`
Trigger an assessment init and inspect the network response in DevTools.
Expected: `proposedRoles` array has 30 items; Claude-selected roles have non-zero `claudeProposedFrequency` and non-null `claudeReasoning`; others have `claudeProposedFrequency: 0` and `claudeReasoning: null`.

- [ ] **Step 4: Commit**

```bash
git add app/api/sprint/tasks/[id]/assess/init/route.ts
git commit -m "feat: init route returns all 30 roles merged with registry"
```

---

### Task 5: Reply route — return all 30 roles on finalize

**Files:**
- Modify: `app/api/sprint/tasks/[id]/assess/[conversationId]/reply/route.ts`

- [ ] **Step 1: Import mergeRolesWithRegistry and fetch full registry**

```typescript
import { mergeRolesWithRegistry } from '@/lib/role-merge'
```

Inside the finalize branch of the route handler, add a fetch for all active roles (same query as Task 4 Step 1).

- [ ] **Step 2: Merge on finalize response**

Find the `type: 'finalize'` response block. Replace the raw `proposedRoles` pass-through with the merged list:

```typescript
const claudeProposed: Array<{ roleName: string; usageFrequency: number; reasoning: string }> =
  parsed.proposedRoles ?? []

const fullRoles = mergeRolesWithRegistry(allRoles ?? [], claudeProposed)

return NextResponse.json({
  type: 'finalize',
  // ... existing fields ...
  proposedRoles: fullRoles,
})
```

- [ ] **Step 3: Verify manually**

Complete an assessment interview through finalize. Inspect the reply response.
Expected: `proposedRoles` has 30 rows with the same structure as Task 4.

- [ ] **Step 4: Commit**

```bash
git add "app/api/sprint/tasks/[id]/assess/[conversationId]/reply/route.ts"
git commit -m "feat: reply finalize returns all 30 roles merged with registry"
```

---

### Task 6: Update RoleSelection interface and state init in page.tsx

**Files:**
- Modify: `app/sprint/page.tsx`

- [ ] **Step 1: Update RoleSelection interface**

Find the `RoleSelection` interface and replace it:

```typescript
interface RoleSelection {
  roleId?: string
  roleName: string
  teamDomain: string
  influenceType: 'DM' | 'NDM'
  weight: number
  usageFrequency: number           // active value used in FVI (0-4)
  claudeProposedFrequency: number  // Claude's original proposal
  claudeReasoning: string | null   // Claude's explanation
  userOverrideFrequency: number | null  // set when user changes from Claude's value
  userReasoning: string | null     // required when userOverrideFrequency is set
  isUserOverride: boolean          // derived: userOverrideFrequency !== null
}
```

- [ ] **Step 2: Update setupRolesFromProposal to map FullRoleSelection**

Find `setupRolesFromProposal` (around line 433). Update it to map the new fields:

```typescript
function setupRolesFromProposal(
  proposed: Array<{
    roleId?: string; roleName: string; teamDomain: string
    influenceType: 'DM' | 'NDM'; weight: number; usageFrequency: number
    claudeProposedFrequency: number; claudeReasoning: string | null
    userOverrideFrequency: number | null; userReasoning: string | null
    isUserOverride: boolean
  }>
): RoleSelection[] {
  return proposed.map(r => ({
    roleId: r.roleId,
    roleName: r.roleName,
    teamDomain: r.teamDomain,
    influenceType: r.influenceType,
    weight: r.weight,
    usageFrequency: r.usageFrequency,
    claudeProposedFrequency: r.claudeProposedFrequency,
    claudeReasoning: r.claudeReasoning,
    userOverrideFrequency: r.userOverrideFrequency,
    userReasoning: r.userReasoning,
    isUserOverride: r.isUserOverride,
  }))
}
```

- [ ] **Step 3: Update updateRoleFreq to track overrides**

Find `updateRoleFreq` (around line 438) and replace it:

```typescript
function updateRoleFreq(roleName: string, teamDomain: string, newFreq: number) {
  setRoleSelections(prev => prev.map(r => {
    if (r.roleName !== roleName || r.teamDomain !== teamDomain) return r
    const isOverride = newFreq !== r.claudeProposedFrequency
    return {
      ...r,
      usageFrequency: newFreq,
      userOverrideFrequency: isOverride ? newFreq : null,
      isUserOverride: isOverride,
      // keep userReasoning if previously set; clear if reverting to Claude's value
      userReasoning: isOverride ? (r.userReasoning ?? '') : null,
    }
  }))
}

function updateRoleReasoning(roleName: string, teamDomain: string, reasoning: string) {
  setRoleSelections(prev => prev.map(r => {
    if (r.roleName !== roleName || r.teamDomain !== teamDomain) return r
    return { ...r, userReasoning: reasoning }
  }))
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors in page.tsx

- [ ] **Step 5: Commit**

```bash
git add app/sprint/page.tsx
git commit -m "feat: update RoleSelection interface and state management for override model"
```

---

### Task 7: Rebuild roles phase UI — all 30 roles, dropdown, reasoning field, badges

**Files:**
- Modify: `app/sprint/page.tsx`

- [ ] **Step 1: Import FREQ_LABELS**

At the top of page.tsx, add:

```typescript
import { FREQ_LABELS } from '@/lib/fvi'
```

Remove any local `FREQ_LABELS` definition in the file.

- [ ] **Step 2: Derive override validation state**

Before the roles phase JSX, add:

```typescript
const hasInvalidOverride = roleSelections.some(
  r => r.isUserOverride && !r.userReasoning?.trim()
)
```

- [ ] **Step 3: Replace the roles phase grid JSX**

Find the roles phase section (around line 1043). Replace the entire two-column grid with:

```tsx
{/* Group roles: Agency DM → Agency NDM → Brand DM → Brand NDM */}
{(['agency', 'brand'] as const).map(domain => (
  <div key={domain} className="mb-6">
    {(['DM', 'NDM'] as const).map(iType => {
      const group = roleSelections.filter(
        r => r.teamDomain === domain && r.influenceType === iType
      )
      if (group.length === 0) return null
      return (
        <div key={iType} className="mb-4">
          <p className="text-xs font-mono font-bold mb-2 text-muted-foreground">
            {domain.toUpperCase()} — {iType === 'DM' ? 'DECISION MAKERS (I-DM)' : 'NON-DECISION MAKERS (I-NDM)'}
          </p>
          {group.map(role => {
            const isOverride = role.isUserOverride
            const missingReasoning = isOverride && !role.userReasoning?.trim()
            return (
              <div key={`${role.teamDomain}-${role.roleName}`} className="mb-3">
                <div className="flex items-center gap-3">
                  {/* Role label */}
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{role.roleName}</span>
                    <span className="text-xs text-muted-foreground ml-2">wt {role.weight}</span>
                  </div>
                  {/* Override badge */}
                  {isOverride ? (
                    <span className="text-xs text-orange-400" title="You overrode Claude">👤</span>
                  ) : role.usageFrequency > 0 ? (
                    <span className="text-xs text-blue-400" title="Claude proposed">✦ AI</span>
                  ) : null}
                  {/* Frequency dropdown */}
                  <select
                    value={role.usageFrequency}
                    onChange={e => updateRoleFreq(role.roleName, role.teamDomain, Number(e.target.value))}
                    className="text-sm border rounded px-2 py-1 bg-background"
                  >
                    {FREQ_LABELS.map((label, idx) => (
                      <option key={idx} value={idx}>{idx} — {label}</option>
                    ))}
                  </select>
                </div>
                {/* Reasoning field — always visible */}
                <div className="mt-1 ml-0">
                  <input
                    type="text"
                    value={isOverride ? (role.userReasoning ?? '') : (role.claudeReasoning ?? '')}
                    readOnly={!isOverride}
                    onChange={e => isOverride && updateRoleReasoning(role.roleName, role.teamDomain, e.target.value)}
                    placeholder={isOverride ? 'Your override — explain why (required)' : ''}
                    className={`w-full text-xs px-2 py-1 rounded border bg-background
                      ${isOverride ? 'border-orange-400' : 'border-transparent text-muted-foreground'}
                      ${missingReasoning ? 'border-red-500' : ''}
                    `}
                  />
                  {missingReasoning && (
                    <p className="text-xs text-red-500 mt-0.5">Explanation required for overrides</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )
    })}
  </div>
))}
```

- [ ] **Step 4: Disable confirm button when overrides are missing reasoning**

Find the "Compute FVI & Save" button (around line 1124). Add the disabled condition:

```tsx
<button
  onClick={handleConfirm}
  disabled={confirmLoading || hasInvalidOverride}
  className={`... ${hasInvalidOverride ? 'opacity-50 cursor-not-allowed' : ''}`}
>
  {hasInvalidOverride ? 'Explain all overrides to continue' : 'Compute FVI & Save'}
</button>
```

- [ ] **Step 5: Verify in browser**

Run: `npm run dev`
Open the sprint page, trigger an assessment, reach the roles phase.
Expected:
- All 30 roles visible grouped by Agency DM / Agency NDM / Brand DM / Brand NDM
- Claude-proposed roles show ✦ AI badge and pre-filled reasoning (read-only)
- Roles at 0 show no badge and no reasoning text
- Changing a dropdown value highlights the reasoning field in orange and shows 👤 badge
- Confirm button disabled until all overrides have reasoning text

- [ ] **Step 6: Commit**

```bash
git add app/sprint/page.tsx lib/fvi.ts
git commit -m "feat: rebuild roles phase UI with all 30 roles, override badges, required reasoning"
```

---

### Task 8: Update confirm route — save all 30 roles with override model

**Files:**
- Modify: `app/api/sprint/tasks/[id]/assess/[conversationId]/confirm/route.ts`

- [ ] **Step 1: Update request body type**

Find the type/interface for the confirm request body. Update the `roles` field:

```typescript
type ConfirmRole = {
  roleId: string              // role_registry.role_id — sent from client
  roleName: string
  teamDomain: string
  influenceType: 'DM' | 'NDM'
  weight: number
  claudeProposedFrequency: number
  userOverrideFrequency: number | null
  claudeReasoning: string | null
  userReasoning: string | null
}
```

- [ ] **Step 2: Add server-side validation for override reasoning**

Before computing FVI, add:

```typescript
const missingReasoning = roles.filter(
  r => r.userOverrideFrequency !== null && !r.userReasoning?.trim()
)
if (missingReasoning.length > 0) {
  return NextResponse.json(
    { error: `Missing override reasoning for: ${missingReasoning.map(r => r.roleName).join(', ')}` },
    { status: 400 }
  )
}
```

- [ ] **Step 3: Pass active frequencies to FVI computation**

The FVI computation uses `usageFrequency`. Derive it from the override model:

```typescript
const rolesForFVI = roles.map(r => ({
  roleName: r.roleName,
  influenceType: r.influenceType,
  weight: r.weight,
  usageFrequency: r.userOverrideFrequency ?? r.claudeProposedFrequency,
}))
// Pass rolesForFVI to computeFullFVI (not the raw roles array)
```

- [ ] **Step 4: Update the conversation_role_assessments insert**

Find the existing insert into `conversation_role_assessments`. Replace it with an upsert that saves all columns:

```typescript
// role.roleId comes from mergeRolesWithRegistry which set it from role_registry.role_id
// No additional DB lookup needed — the frontend sends it in the payload
const roleInserts = roles.map(role => ({
  conversation_id: conversationId,
  role_id: role.roleId,   // sent from client, sourced from role_registry.role_id
  usage_frequency: role.userOverrideFrequency ?? role.claudeProposedFrequency,
  claude_proposed_frequency: role.claudeProposedFrequency,
  user_override_frequency: role.userOverrideFrequency,
  claude_reasoning: role.claudeReasoning,
  user_reasoning: role.userReasoning,
}))

const { error: roleError } = await supabase
  .from('conversation_role_assessments')
  .upsert(roleInserts, { onConflict: 'conversation_id,role_id' })

if (roleError) {
  console.error('Role insert error:', roleError)
  return NextResponse.json({ error: 'Failed to save role assessments' }, { status: 500 })
}
```

- [ ] **Step 5: Update handleConfirm in page.tsx to send new fields**

In `app/sprint/page.tsx`, find `handleConfirm` (around line 448). Update the roles payload:

```typescript
const rolesPayload = roleSelections.map(r => ({
  roleName: r.roleName,
  teamDomain: r.teamDomain,
  influenceType: r.influenceType,
  weight: r.weight,
  claudeProposedFrequency: r.claudeProposedFrequency,
  userOverrideFrequency: r.userOverrideFrequency,
  claudeReasoning: r.claudeReasoning,
  userReasoning: r.userReasoning,
}))
```

- [ ] **Step 6: Verify end-to-end**

Run: `npm run dev`
Complete a full assessment, override at least one role with a reason, click confirm.
Expected:
- FVI computes successfully
- `conversation_role_assessments` has 30 rows in Supabase dashboard
- Overridden role has both `claude_proposed_frequency` and `user_override_frequency` populated
- Non-overridden roles have `user_override_frequency` as null

- [ ] **Step 7: Commit**

```bash
git add "app/api/sprint/tasks/[id]/assess/[conversationId]/confirm/route.ts" app/sprint/page.tsx
git commit -m "feat: confirm route saves all 30 roles with full override model"
```

---

### Task 9: Build assessment.md content generator

**Files:**
- Create: `lib/bundle-docs/assessment.ts`
- Create: `__tests__/lib/bundle-docs/assessment.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// __tests__/lib/bundle-docs/assessment.test.ts
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
    // Copywriter was overridden by user
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest __tests__/lib/bundle-docs/assessment.test.ts --no-coverage`
Expected: FAIL — module not found

- [ ] **Step 3: Implement buildAssessmentDoc**

```typescript
// lib/bundle-docs/assessment.ts
import { FREQ_LABELS } from '../fvi'
import type { FVIResult } from '../fvi'

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

interface AssessmentDocInput {
  taskName: string
  clickupId: string
  objectives: ObjectiveRow[]
  roles: RoleRow[]
  fvi: FVIResult
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

  const meta = [
    experimentId ? `experiment: ${experimentId}` : null,
    pmAppCommitSha ? `pm-app-commit: ${pmAppCommitSha}` : null,
    `conversation: ${conversationId}`,
    `generated: ${new Date().toISOString()}`,
  ].filter(Boolean).join('\n')

  return `# Assessment: ${taskName}

**ClickUp:** ${clickupId}

\`\`\`
${meta}
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest __tests__/lib/bundle-docs/assessment.test.ts --no-coverage`
Expected: PASS — 4 tests green

- [ ] **Step 5: Commit**

```bash
git add lib/bundle-docs/assessment.ts __tests__/lib/bundle-docs/assessment.test.ts
git commit -m "feat: add buildAssessmentDoc generator"
```

---

### Task 10: Wire assessment.md into the bundle route

**Files:**
- Modify: `app/api/sprint/tasks/[id]/bundle/route.ts`

- [ ] **Step 1: Import buildAssessmentDoc**

```typescript
import { buildAssessmentDoc } from '@/lib/bundle-docs/assessment'
```

- [ ] **Step 2: Fetch override-aware role data after assessment completion**

Inside the bundle route handler, after fetching the completed assessment conversation, add a query for the full role assessment data:

```typescript
const { data: roleAssessments } = await supabase
  .from('conversation_role_assessments')
  .select(`
    claude_proposed_frequency,
    user_override_frequency,
    claude_reasoning,
    user_reasoning,
    role_registry (role_name, team_domain, influence_type, weight)
  `)
  .eq('conversation_id', conversationId)

const rolesForDoc = (roleAssessments ?? []).map(ra => ({
  roleName: ra.role_registry.role_name,
  teamDomain: ra.role_registry.team_domain,
  influenceType: ra.role_registry.influence_type as 'DM' | 'NDM',
  weight: ra.role_registry.weight,
  claudeProposedFrequency: ra.claude_proposed_frequency ?? 0,
  userOverrideFrequency: ra.user_override_frequency ?? null,
  claudeReasoning: ra.claude_reasoning,
  userReasoning: ra.user_reasoning,
}))
```

- [ ] **Step 3: Resolve PM-App commit SHA**

```typescript
const pmAppCommitSha = process.env.NEXT_PUBLIC_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev'
```

Add `NEXT_PUBLIC_COMMIT_SHA` to `.env.local` for local dev:

```bash
echo "NEXT_PUBLIC_COMMIT_SHA=$(git rev-parse --short HEAD)" >> .env.local
```

- [ ] **Step 4: Build and write assessment.md to vault**

Find the section where vault files are written (the series of `writeVaultFile` or equivalent calls). Add assessment.md before roles-affected.md:

```typescript
const assessmentContent = buildAssessmentDoc({
  taskName: task.name,
  clickupId: task.clickup_id,
  objectives: finalScores,       // from assessment_conversations.final_scores
  roles: rolesForDoc,
  fvi: fviResult,
  effort: conversation.effort,
  riskLevel: confirmedRiskLevel,
  riskMultiplier: conversation.risk,
  conversationId,
  experimentId: conversation.experiment_id ?? undefined,
  pmAppCommitSha,
})

await writeVaultFile('assessment.md', assessmentContent)
```

- [ ] **Step 5: Update git commit message to include experiment and SHA tags**

Find where the vault commit message is constructed. Update it to include the tags:

```typescript
const expTag = conversation.experiment_id ? ` [exp:${conversation.experiment_id}]` : ''
const shaTag = ` [pm-app:${pmAppCommitSha}]`
const commitMessage = `feat(${task.clickup_id}): bundle assessment docs${expTag}${shaTag}`
```

- [ ] **Step 6: Verify end-to-end**

Run: `npm run dev`
Complete a full assessment and click "Generate Bundle."
Expected:
- Vault branch contains `assessment.md`
- `assessment.md` includes FVI score, all 30 roles (with override indicators), all 7 objectives
- Git commit message contains `[pm-app:SHA]`
- If experiment_id set, commit message also contains `[exp:SLUG]`

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: all tests pass, no regressions

- [ ] **Step 8: Commit**

```bash
git add "app/api/sprint/tasks/[id]/bundle/route.ts" .env.local
git commit -m "feat: write assessment.md to vault with override data and pm-app SHA tag"
```

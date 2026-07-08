# Objectives → JSON + Gemini UX-Architect Stitch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken free-text objectives extraction with a strict JSON schema, and add a Gemini "UX Architect" step that turns objectives + the planning tree into a per-workflow structural stitch injected into Claude's prototyping context.

**Architecture:** Two isolated units. **Module A** is a pure function in `gatekeeper-extract.ts` that maps ClickUp `Obj #1…#7 Notes` into `{ objectives: [{ index, name, notes }] }` (names positional from the `Objectives` label options), written to a new `features.objectives_json` column at gatekeeper time. **Module B** (`lib/features/ux-architect.ts`) calls Gemini 2.5 Pro (JSON mode) to produce a structural stitch, stored in `features.ux_stitch`, triggered by the `planning → approved` PATCH via Next's `after()` (background, non-blocking, write-only-on-success). `buildFeatureContext` renders both new columns into the prompt.

**Tech Stack:** TypeScript, Next.js 16.2.2 (App Router, `after()` from `next/server`), Supabase (Postgres/jsonb), `@google/genai` SDK, Jest 29 + ts-jest.

**Spec:** `docs/superpowers/specs/2026-07-07-objectives-json-gemini-ux-architect-design.md`

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `supabase/migrations/036_feature_ux_architecture.sql` | Create | Add `objectives_json` + `ux_stitch` jsonb columns |
| `lib/supabase/types.ts` | Modify | Add the two columns to `features` Row/Insert/Update |
| `lib/features/gatekeeper-extract.ts` | Modify | Add `extractObjectivesJson`; extend `ClickUpCustomField` with `type_config`; remove old `extractObjectives` |
| `__tests__/lib/gatekeeper-extract.test.ts` | Modify | Replace `extractObjectives` tests with `extractObjectivesJson` |
| `lib/features/gatekeeper.ts` | Modify | Write `objectives_json` instead of `objectives` |
| `lib/features/ux-architect.ts` | Create | Gemini client, schema, `generateUxStitch` |
| `__tests__/lib/features/ux-architect.test.ts` | Create | Unit tests with mocked `@google/genai` |
| `lib/features/context.ts` | Modify | Render `objectives_json` (preferred) + `ux_stitch` |
| `__tests__/lib/features/context.test.ts` | Modify | Assert new rendering |
| `app/api/features/[id]/route.ts` | Modify | Fire `generateUxStitch` via `after()` on `planning→approved`; `maxDuration` |
| `__tests__/api/features/id-route.test.ts` | Create | PATCH transition-trigger tests |
| `app/features/[id]/components/ClaudePanel.tsx` | Modify | Toast copy on approve |
| `package.json` | Modify | Add `@google/genai` dependency |

**Convention notes for the implementer:**
- Tests live under `__tests__/`, mirror the source path, import via the `@/` alias, and mock modules with `jest.mock('@/...')`. External SDKs are mocked with `{ __esModule: true, default: jest.fn()... }` (see `__tests__/lib/features/conversation.test.ts`).
- Run a single test file: `npx jest <path> -v`. Run everything: `npm test`.
- Typecheck: `npx tsc --noEmit`. Build: `npm run build`.
- Commit frequently; one commit per task (commands given per task).

---

### Task 1: Migration + Supabase types

**Files:**
- Create: `supabase/migrations/036_feature_ux_architecture.sql`
- Modify: `lib/supabase/types.ts` (the `features` table `Row`, `Insert`, `Update`)

> Additive columns only; the existing `objectives text` column is left untouched. Prod apply is **manual** (Michael) before deploy — this task only writes the files.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/036_feature_ux_architecture.sql`:

```sql
-- 036_feature_ux_architecture.sql
-- Structured objectives (Module A) and the Gemini UX-architect stitch (Module B).
-- Additive: the legacy `objectives text` column is retained as a read-only fallback.
alter table features add column if not exists objectives_json jsonb;
alter table features add column if not exists ux_stitch       jsonb;
```

- [ ] **Step 2: Add the columns to the generated types**

In `lib/supabase/types.ts`, the `features` table has three inline type blocks (`Row`, `Insert`, `Update`) around lines 240–247. Add `objectives_json` and `ux_stitch` to each, typed `Json | null` (the file already imports/defines `Json`).

- `Row` (line ~240): after `objectives: string | null;` add `objectives_json: Json | null; ux_stitch: Json | null;`
- `Insert` (line ~246): after `objectives?: string | null;` add `objectives_json?: Json | null; ux_stitch?: Json | null;`
- `Update` (line ~247): after `objectives?: string | null;` add `objectives_json?: Json | null; ux_stitch?: Json | null;`

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (columns now known to the `Feature` type).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/036_feature_ux_architecture.sql lib/supabase/types.ts
git commit -m "feat(db): add objectives_json + ux_stitch columns (migration 036)"
```

---

### Task 2: Module A — `extractObjectivesJson` (pure, TDD)

**Files:**
- Modify: `lib/features/gatekeeper-extract.ts`
- Test: `__tests__/lib/gatekeeper-extract.test.ts`

> Adds the new function and extends `ClickUpCustomField` with `type` / `type_config`. Leaves the old `extractObjectives` in place for now (removed in Task 3) so the suite stays green.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/lib/gatekeeper-extract.test.ts`. Add `extractObjectivesJson` to the import block at the top of the file, then add:

```ts
describe('extractObjectivesJson', () => {
  const objectivesField = {
    name: 'Objectives',
    type: 'labels',
    type_config: {
      options: [
        { id: 'a', label: 'Data Backed Decisions', orderindex: 0 },
        { id: 'b', label: 'Modular Content', orderindex: 1 },
        { id: 'c', label: 'User Success', orderindex: 2 },
      ],
    },
  }

  it('pairs each Obj #N note with the label at orderindex N-1, dropping scores', () => {
    const result = extractObjectivesJson([
      objectivesField,
      { name: 'Obj #1', value: '3' },
      { name: 'Obj #1 Notes', value: 'improves analytics' },
      { name: 'Obj #3', value: '-2' },
      { name: 'Obj #3 Notes', value: 'removes friction' },
    ])
    expect(result).toEqual({
      objectives: [
        { index: 1, name: 'Data Backed Decisions', notes: 'improves analytics' },
        { index: 3, name: 'User Success', notes: 'removes friction' },
      ],
    })
  })

  it('emits only objectives that have non-empty notes', () => {
    const result = extractObjectivesJson([
      objectivesField,
      { name: 'Obj #1 Notes', value: '   ' },
      { name: 'Obj #2 Notes', value: 'keeps it modular' },
    ])
    expect(result).toEqual({ objectives: [{ index: 2, name: 'Modular Content', notes: 'keeps it modular' }] })
  })

  it('falls back to empty name when the label option is missing', () => {
    const result = extractObjectivesJson([{ name: 'Obj #5 Notes', value: 'integration work' }])
    expect(result).toEqual({ objectives: [{ index: 5, name: '', notes: 'integration work' }] })
  })

  it('returns null when no objective has notes', () => {
    expect(extractObjectivesJson([objectivesField, { name: 'Obj #1', value: '3' }])).toBeNull()
    expect(extractObjectivesJson(undefined)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest __tests__/lib/gatekeeper-extract.test.ts -t extractObjectivesJson -v`
Expected: FAIL — `extractObjectivesJson is not a function`.

- [ ] **Step 3: Implement the function**

In `lib/features/gatekeeper-extract.ts`, extend the `ClickUpCustomField` interface and add the new types + function. Replace the existing `ClickUpCustomField` interface with:

```ts
export interface ClickUpLabelOption {
  id?: string
  label?: string
  name?: string
  orderindex?: number
}
export interface ClickUpCustomField {
  id?: string
  name?: string
  value?: unknown
  type?: string
  type_config?: { options?: ClickUpLabelOption[] }
}

export interface FeatureObjective {
  index: number
  name: string
  notes: string
}
export interface ObjectivesJson {
  objectives: FeatureObjective[]
}
```

Then add (place it just below `extractObjectives`, which Task 3 will delete):

```ts
/**
 * Objectives as strict JSON for the UX pipeline. Reads the `Obj #1…#7 Notes`
 * text fields, pairing each with the strategic-objective NAME defined by the
 * `Objectives` labels field's option at `orderindex N-1` (verified positional
 * mapping). Scores / ObjTotal / Approved are prioritization signal and dropped.
 * Returns null when no objective carries notes.
 */
export function extractObjectivesJson(
  fields: ClickUpCustomField[] | undefined
): ObjectivesJson | null {
  const list = fields ?? []

  const objectivesField = list.find((f) => f.name?.trim().toLowerCase() === 'objectives')
  const labelByOrder = new Map<number, string>()
  for (const opt of objectivesField?.type_config?.options ?? []) {
    if (typeof opt.orderindex === 'number') {
      labelByOrder.set(opt.orderindex, (opt.label ?? opt.name ?? '').trim())
    }
  }

  const objectives: FeatureObjective[] = []
  for (let n = 1; n <= 7; n++) {
    const noteField = list.find((f) => new RegExp(`^Obj #${n} Notes$`, 'i').test(f.name?.trim() ?? ''))
    const notes = typeof noteField?.value === 'string' ? noteField.value.trim() : ''
    if (!notes) continue
    objectives.push({ index: n, name: labelByOrder.get(n - 1) ?? '', notes })
  }

  return objectives.length ? { objectives } : null
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest __tests__/lib/gatekeeper-extract.test.ts -t extractObjectivesJson -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/features/gatekeeper-extract.ts __tests__/lib/gatekeeper-extract.test.ts
git commit -m "feat(objectives): add extractObjectivesJson strict-schema extractor"
```

---

### Task 3: Wire Module A into the gatekeeper; remove legacy `extractObjectives`

**Files:**
- Modify: `lib/features/gatekeeper.ts` (the `enrichment` object + import)
- Modify: `lib/features/gatekeeper-extract.ts` (delete `extractObjectives`)
- Modify: `__tests__/lib/gatekeeper-extract.test.ts` (delete the `extractObjectives` describe block + import)

- [ ] **Step 1: Update the gatekeeper import and enrichment**

In `lib/features/gatekeeper.ts`:

Change the import (line ~13):
```ts
import {
  extractFviScore,
  extractObjectivesJson,
  resolveAppIdentity,
  type ClickUpCustomField,
} from '@/lib/features/gatekeeper-extract'
```

Change the `enrichment` object (line ~49) — write `objectives_json`, drop the `objectives` text write:
```ts
  const enrichment = {
    clickup_details: cuTask.description?.trim() || null,
    objectives_json: (extractObjectivesJson(fields) as unknown as Json) ?? null,
    fvi_score: extractFviScore(fields) ?? task?.fvi_score ?? null,
  }
```
(`Json` is already imported at the top of the file.)

- [ ] **Step 2: Delete the legacy extractor**

In `lib/features/gatekeeper-extract.ts`, delete the entire `extractObjectives` function (the JSDoc block + function body, roughly the current lines 44–82). Leave `extractObjectivesJson` in place.

- [ ] **Step 3: Delete the legacy tests**

In `__tests__/lib/gatekeeper-extract.test.ts`, remove `extractObjectives` from the top import block and delete the whole `describe('extractObjectives', …)` block.

- [ ] **Step 4: Typecheck + run the extract suite**

Run: `npx tsc --noEmit`
Expected: no errors (no remaining references to `extractObjectives`).

Run: `npx jest __tests__/lib/gatekeeper-extract.test.ts -v`
Expected: PASS, no `extractObjectives` describe present.

- [ ] **Step 5: Commit**

```bash
git add lib/features/gatekeeper.ts lib/features/gatekeeper-extract.ts __tests__/lib/gatekeeper-extract.test.ts
git commit -m "feat(gatekeeper): write objectives_json; drop legacy text extractor"
```

---

### Task 4: Add the `@google/genai` dependency

**Files:**
- Modify: `package.json` (+ `package-lock.json`)

- [ ] **Step 1: Install**

Run: `npm install @google/genai`
Expected: `@google/genai` appears under `dependencies` in `package.json`.

- [ ] **Step 2: Verify it resolves**

Run: `node -e "require('@google/genai'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add @google/genai"
```

---

### Task 5: Module B — `generateUxStitch` (TDD, mocked Gemini)

**Files:**
- Create: `lib/features/ux-architect.ts`
- Test: `__tests__/lib/features/ux-architect.test.ts`

> Confirm the `@google/genai` entrypoint against the installed version before finalizing (`ai.models.generateContent({ model, contents, config })`, text at `response.text`). The mock below defines the contract the code is written against.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/lib/features/ux-architect.test.ts`:

```ts
// __tests__/lib/features/ux-architect.test.ts
process.env.GEMINI_API_KEY = 'test-key'

const mockGenerateContent = jest.fn()
jest.mock('@google/genai', () => ({
  __esModule: true,
  GoogleGenAI: jest.fn().mockImplementation(() => ({ models: { generateContent: mockGenerateContent } })),
  Type: new Proxy({}, { get: (_t, p) => String(p) }), // Type.OBJECT -> 'OBJECT', etc.
}))

const mockGetFeature = jest.fn()
const mockUpdateFeature = jest.fn().mockResolvedValue({})
jest.mock('@/lib/features/client', () => ({
  getFeature: (...a: unknown[]) => mockGetFeature(...a),
  updateFeature: (...a: unknown[]) => mockUpdateFeature(...a),
}))
jest.mock('@/lib/features/context', () => ({
  buildFeatureContext: jest.fn().mockResolvedValue('Feature: Login\n--- Objectives ---\n- User Success: x'),
}))
jest.mock('@/lib/claude/design-md', () => ({ getDesignContract: jest.fn().mockReturnValue('DESIGN TOKENS') }))

import { generateUxStitch } from '@/lib/features/ux-architect'

const approvedFeature = { id: 'f-1', app: 'web', planning_phase: 'approved', objectives_json: { objectives: [{ index: 3, name: 'User Success', notes: 'x' }] } }

beforeEach(() => {
  jest.clearAllMocks()
  process.env.GEMINI_API_KEY = 'test-key'
})

it('writes ux_stitch when Gemini returns valid JSON', async () => {
  mockGetFeature.mockResolvedValue(approvedFeature)
  const stitch = { summary: 's', workflows: [{ name: 'w' }] }
  mockGenerateContent.mockResolvedValue({ text: JSON.stringify(stitch) })
  await generateUxStitch('f-1')
  expect(mockUpdateFeature).toHaveBeenCalledWith('f-1', { ux_stitch: stitch })
})

it('does NOT write when Gemini throws', async () => {
  mockGetFeature.mockResolvedValue(approvedFeature)
  mockGenerateContent.mockRejectedValue(new Error('timeout'))
  await generateUxStitch('f-1')
  expect(mockUpdateFeature).not.toHaveBeenCalled()
})

it('does NOT write when Gemini returns unparseable text', async () => {
  mockGetFeature.mockResolvedValue(approvedFeature)
  mockGenerateContent.mockResolvedValue({ text: '{ not json' })
  await generateUxStitch('f-1')
  expect(mockUpdateFeature).not.toHaveBeenCalled()
})

it('skips (no Gemini call) while still planning', async () => {
  mockGetFeature.mockResolvedValue({ ...approvedFeature, planning_phase: 'planning' })
  await generateUxStitch('f-1')
  expect(mockGenerateContent).not.toHaveBeenCalled()
  expect(mockUpdateFeature).not.toHaveBeenCalled()
})

it('skips when objectives_json is absent', async () => {
  mockGetFeature.mockResolvedValue({ ...approvedFeature, objectives_json: null })
  await generateUxStitch('f-1')
  expect(mockGenerateContent).not.toHaveBeenCalled()
})

it('skips when GEMINI_API_KEY is unset', async () => {
  delete process.env.GEMINI_API_KEY
  mockGetFeature.mockResolvedValue(approvedFeature)
  await generateUxStitch('f-1')
  expect(mockGenerateContent).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest __tests__/lib/features/ux-architect.test.ts -v`
Expected: FAIL — cannot find module `@/lib/features/ux-architect`.

- [ ] **Step 3: Implement the module**

Create `lib/features/ux-architect.ts`:

```ts
// lib/features/ux-architect.ts
// Module B: the Gemini "UX Architect" pre-processing step. Turns a feature's
// objectives + planning tree + design contract into a structural stitch
// (component hierarchy, data-flow, mid-fi wireframe per workflow — no code),
// stored in features.ux_stitch and injected into Claude's prototyping context.
//
// Isolation: the ONLY module that talks to Gemini. Never throws into callers and
// NEVER writes on failure — a bad/slow/absent response leaves ux_stitch untouched.
import { GoogleGenAI, Type, type Schema } from '@google/genai'
import { getFeature, updateFeature } from '@/lib/features/client'
import { buildFeatureContext } from '@/lib/features/context'
import { getDesignContract } from '@/lib/claude/design-md'
import { getAppTarget } from '@/lib/claude/apps'
import type { Json } from '@/lib/supabase/types'

const GEMINI_MODEL = 'gemini-2.5-pro'
const MAX_OUTPUT_TOKENS = 8192 // respect the model revision's output ceiling

const UX_ARCHITECT_SYSTEM = `You are a UX Architect. Given a feature's strategic objectives, its user-story/scenario/step workflows, and the product's design contract, produce a MID-FIDELITY STRUCTURAL PLAN as JSON that satisfies the objectives through the given workflows.

Rules:
- NEVER emit code (no React, no HTML, no CSS).
- Represent EVERY workflow; organize the plan by workflow.
- Describe structure only — layout intent, component composition, and data movement. Be terse; do not write prose paragraphs inside fields (long output risks truncation).
- Respect the design contract's information architecture.`

const UX_STITCH_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    components: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          purpose: { type: Type.STRING },
          props: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['name', 'purpose'],
      },
    },
    workflows: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          userStories: { type: Type.ARRAY, items: { type: Type.STRING } },
          screens: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                layout: { type: Type.STRING },
                regions: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      role: { type: Type.STRING },
                      components: { type: Type.ARRAY, items: { type: Type.STRING } },
                      data: { type: Type.STRING },
                    },
                    required: ['role'],
                  },
                },
              },
              required: ['name'],
            },
          },
          dataFlow: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                trigger: { type: Type.STRING },
                reads: { type: Type.ARRAY, items: { type: Type.STRING } },
                writes: { type: Type.ARRAY, items: { type: Type.STRING } },
                result: { type: Type.STRING },
              },
              required: ['trigger'],
            },
          },
        },
        required: ['name'],
      },
    },
  },
  required: ['summary', 'workflows'],
}

/**
 * Generate and persist the UX structural stitch for a feature. Fires on the
 * planning→approved transition (see the PATCH route). No-ops (never throws,
 * never writes) if planning hasn't produced a tree, objectives are missing,
 * the API key is unset, or Gemini fails/returns unparseable output.
 */
export async function generateUxStitch(featureId: string): Promise<void> {
  const feature = await getFeature(featureId)
  if (!feature) return
  if (feature.planning_phase === 'planning') {
    console.log('[ux-architect] skip: feature still planning', featureId)
    return
  }
  if (!feature.objectives_json) {
    console.log('[ux-architect] skip: no objectives_json', featureId)
    return
  }
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.warn('[ux-architect] skip: GEMINI_API_KEY unset')
    return
  }

  const context = await buildFeatureContext(featureId)
  const target = getAppTarget(feature.app)
  const designContract = getDesignContract(target.slug)
  const prompt = [
    'FEATURE CONTEXT (objectives + workflows + spec):',
    context,
    '',
    designContract ? `DESIGN CONTRACT (${target.label}):\n${designContract}` : '',
    '',
    'Produce the structural stitch as JSON matching the response schema.',
  ]
    .filter(Boolean)
    .join('\n')

  let stitch: unknown
  try {
    const ai = new GoogleGenAI({ apiKey })
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        systemInstruction: UX_ARCHITECT_SYSTEM,
        responseMimeType: 'application/json',
        responseSchema: UX_STITCH_SCHEMA,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
    })
    const text = response.text
    if (!text) {
      console.warn('[ux-architect] empty Gemini response for', featureId)
      return
    }
    stitch = JSON.parse(text)
  } catch (err) {
    console.warn('[ux-architect] generation failed for', featureId, err instanceof Error ? err.message : err)
    return // never write on failure
  }

  await updateFeature(featureId, { ux_stitch: stitch as Json })
  console.log('[ux-architect] stitch stored for', featureId)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest __tests__/lib/features/ux-architect.test.ts -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (If `@google/genai` types name the config/schema differently, adjust the import/field names to the installed version — the mock contract stays the same.)

- [ ] **Step 6: Commit**

```bash
git add lib/features/ux-architect.ts __tests__/lib/features/ux-architect.test.ts
git commit -m "feat(ux-architect): Gemini structural-stitch generator (write-only-on-success)"
```

---

### Task 6: Render `objectives_json` + `ux_stitch` in feature context

**Files:**
- Modify: `lib/features/context.ts`
- Test: `__tests__/lib/features/context.test.ts`

- [ ] **Step 1: Write the failing tests**

In `__tests__/lib/features/context.test.ts`, extend the `features` mock so the feature row includes the new columns, then add assertions. Change the `features` branch of the mock (currently returns `{ id: 'f-1', name: 'Login', description: 'Auth flow', status: 'draft' }`) to also include:

```ts
objectives_json: { objectives: [{ index: 3, name: 'User Success', notes: 'reduce friction' }] },
ux_stitch: { summary: 'plan summary', workflows: [{ name: 'Onboarding' }] },
```

Then add:

```ts
it('renders objectives from objectives_json', async () => {
  const ctx = await buildFeatureContext('f-1')
  expect(ctx).toContain('--- Objectives (from ClickUp) ---')
  expect(ctx).toContain('User Success: reduce friction')
})

it('renders the ux_stitch structural plan block', async () => {
  const ctx = await buildFeatureContext('f-1')
  expect(ctx).toContain('--- UX Structural Plan (Gemini) ---')
  expect(ctx).toContain('"summary": "plan summary"')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest __tests__/lib/features/context.test.ts -v`
Expected: FAIL — new assertions not met.

- [ ] **Step 3: Implement the rendering**

In `lib/features/context.ts`, add an import at the top:

```ts
import type { ObjectivesJson } from '@/lib/features/gatekeeper-extract'
```

Replace the existing objectives line inside the `lines` array:

```ts
    ...(feature.objectives ? ['', '--- Objectives (from ClickUp) ---', feature.objectives] : []),
```

with calls to two helpers:

```ts
    ...renderObjectivesLines(feature),
    ...renderStitchLines(feature),
```

Then add the helpers below `buildFeatureContext` (near `truncate`):

```ts
function renderObjectivesLines(feature: { objectives_json: unknown; objectives: string | null }): string[] {
  const oj = feature.objectives_json as ObjectivesJson | null
  if (oj?.objectives?.length) {
    const lines = oj.objectives.map((o) => `- ${o.name || `Objective #${o.index}`}: ${o.notes}`)
    return ['', '--- Objectives (from ClickUp) ---', ...lines]
  }
  if (feature.objectives) return ['', '--- Objectives (from ClickUp) ---', feature.objectives]
  return []
}

function renderStitchLines(feature: { ux_stitch: unknown }): string[] {
  if (!feature.ux_stitch) return []
  return ['', '--- UX Structural Plan (Gemini) ---', JSON.stringify(feature.ux_stitch, null, 2)]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest __tests__/lib/features/context.test.ts -v`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add lib/features/context.ts __tests__/lib/features/context.test.ts
git commit -m "feat(context): render objectives_json + ux_stitch into feature context"
```

---

### Task 7: PATCH route fires `generateUxStitch` on `planning→approved`

**Files:**
- Modify: `app/api/features/[id]/route.ts`
- Test: `__tests__/api/features/id-route.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `__tests__/api/features/id-route.test.ts`:

```ts
// __tests__/api/features/id-route.test.ts
import { NextRequest } from 'next/server'

const mockGetFeature = jest.fn()
const mockUpdateFeature = jest.fn()
jest.mock('@/lib/features/client', () => ({
  getFeature: (...a: unknown[]) => mockGetFeature(...a),
  updateFeature: (...a: unknown[]) => mockUpdateFeature(...a),
}))
jest.mock('@/lib/user-stories/client', () => ({ getFeatureStories: jest.fn(), getStoryFeatureCount: jest.fn() }))
jest.mock('@/lib/scenarios/client', () => ({ getStoryScenarios: jest.fn(), getScenarioSteps: jest.fn() }))
jest.mock('@/lib/auth', () => ({ getSessionUser: jest.fn().mockResolvedValue({ email: 'pm@test.com' }) }))

const mockGenerate = jest.fn().mockResolvedValue(undefined)
jest.mock('@/lib/features/ux-architect', () => ({ generateUxStitch: (...a: unknown[]) => mockGenerate(...a) }))

// after() runs its callback synchronously enough for assertions in tests:
jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server')
  return { ...actual, after: (fn: () => unknown) => { void fn() } }
})

import { PATCH } from '@/app/api/features/[id]/route'

function patch(body: unknown) {
  return new NextRequest('http://localhost/api/features/f-1', { method: 'PATCH', body: JSON.stringify(body) })
}
const params = Promise.resolve({ id: 'f-1' })

beforeEach(() => jest.clearAllMocks())

it('fires generateUxStitch on the planning→approved edge', async () => {
  mockGetFeature.mockResolvedValue({ id: 'f-1', planning_phase: 'planning' })
  mockUpdateFeature.mockResolvedValue({ id: 'f-1', planning_phase: 'approved' })
  await PATCH(patch({ planning_phase: 'approved' }), { params })
  expect(mockGenerate).toHaveBeenCalledWith('f-1')
})

it('does NOT fire when the feature was already approved', async () => {
  mockGetFeature.mockResolvedValue({ id: 'f-1', planning_phase: 'approved' })
  mockUpdateFeature.mockResolvedValue({ id: 'f-1', planning_phase: 'approved' })
  await PATCH(patch({ planning_phase: 'approved' }), { params })
  expect(mockGenerate).not.toHaveBeenCalled()
})

it('does NOT fire on a non-approval transition', async () => {
  mockGetFeature.mockResolvedValue({ id: 'f-1', planning_phase: 'approved' })
  mockUpdateFeature.mockResolvedValue({ id: 'f-1', planning_phase: 'prototyping' })
  await PATCH(patch({ planning_phase: 'prototyping' }), { params })
  expect(mockGenerate).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest __tests__/api/features/id-route.test.ts -v`
Expected: FAIL — `generateUxStitch` never called (route not yet wired).

- [ ] **Step 3: Implement the route change**

In `app/api/features/[id]/route.ts`:

Change the import line:
```ts
import { NextRequest, NextResponse, after } from 'next/server'
```
Add the generator import:
```ts
import { generateUxStitch } from '@/lib/features/ux-architect'
```
Add a `maxDuration` export near the top (after imports):
```ts
// after() work (Gemini stitch) counts against the function budget.
export const maxDuration = 120
```
In `PATCH`, read the prior phase before the update and schedule generation after it:
```ts
  const prev = await getFeature(id)
  const feature = await updateFeature(id, {
    ...(status !== undefined && { status }),
    ...(name !== undefined && { name }),
    ...(description !== undefined && { description }),
    ...(planning_phase !== undefined && { planning_phase }),
    ...(app !== undefined && { app }),
  })

  if (prev?.planning_phase === 'planning' && planning_phase === 'approved') {
    // Background, non-blocking; after() keeps the lambda warm on Vercel.
    after(async () => {
      try {
        await generateUxStitch(id)
      } catch (err) {
        console.warn('[ux-architect] background generation error', err)
      }
    })
  }

  return NextResponse.json(feature)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest __tests__/api/features/id-route.test.ts -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/api/features/\[id\]/route.ts __tests__/api/features/id-route.test.ts
git commit -m "feat(features): fire UX-architect stitch on planning→approved via after()"
```

---

### Task 8: Toast copy on approve

**Files:**
- Modify: `app/features/[id]/components/ClaudePanel.tsx:191`

> No new infra — the panel already uses antd's `message.success`. Just set PM expectations about background generation.

- [ ] **Step 1: Update the message**

At `app/features/[id]/components/ClaudePanel.tsx:191`, replace:
```ts
      message.success('Spec approved — ready for prototyping')
```
with:
```ts
      message.success('Spec approved — generating a structural plan in the background; it will inform the next prototype build.')
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/features/\[id\]/components/ClaudePanel.tsx
git commit -m "feat(ui): approve toast notes background structural-plan generation"
```

---

### Task 9: Full verification

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all green (baseline was 581; this plan nets new tests and removes the `extractObjectives` block — the number rises accordingly, 0 failures).

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: build succeeds (validates the `after()` usage + `maxDuration` export on the route).

- [ ] **Step 4: Confirm the ops checklist is captured in the PR description**

The PR body must call out the manual steps Michael owns:
- Apply migration `036` to prod **before** deploy (columns are read *and written* by the deployed code).
- Set `GEMINI_API_KEY` in Vercel Production.

---

## Ops checklist (for the PR description — Michael executes)

1. Apply `supabase/migrations/036_feature_ux_architecture.sql` to prod before deploying.
2. Set `GEMINI_API_KEY` in Vercel Production.
3. Backfill: `objectives_json` populates on the next gatekeeper enrichment per task; existing features re-enrich when their task next fires `taskUpdated`, or can be re-run manually.

## Notes for later specs (do NOT build here)

- Spec #2 publishes `ux_stitch` → Figma (per-feature file: workflow pages + component library) via the MCP write path; adds `features.figma_file_key`.
- Spec #3 resolves `view_figma`/`get_figma_styles` to the feature's own file.
- Spec #4 builds the master per-app mirror from the repo screen-map + `DESIGN.md`.
- A live stitch-viewing panel + its poller/lock belong to Spec #2/#3, not here.

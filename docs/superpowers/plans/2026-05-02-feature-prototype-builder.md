# Feature Prototype Builder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Feature Prototype Builder to the PM app — a surface where PMs define features (with user stories, scenarios, and steps), attach Figma screens per step, chat with Claude, and generate permanent HTML slideshow prototypes pushed to Supabase Storage and the vault.

**Architecture:** Eight new Supabase tables model features (M:M with tasks and user stories), scenarios, steps, prototypes, and conversations. A Figma image permanence pipeline fetches Figma PNGs and re-uploads them to Supabase Storage at generation time so vault prototypes never break. Claude generates self-contained HTML slideshows with natural-language hotspot detection. Two UI surfaces: a Features tab in the existing task detail panel, and a full-page `/features/[id]` editor with a 3-panel layout.

**Tech Stack:** Next.js App Router, TypeScript, Supabase (Postgres + Storage), Ant Design, Claude API (`claude-sonnet-4-6`), `lib/github/vault.ts` for vault push. All tests use Jest + `@testing-library/react`.

> **Before writing any Next.js route or page code:** read `node_modules/next/dist/docs/` for the current API. This codebase's AGENTS.md warns that APIs may differ from training data.

---

## File Map

**New files:**
- `supabase/migrations/011_feature_prototype_builder.sql`
- `lib/features/client.ts` — CRUD for features and feature_tasks
- `lib/features/context.ts` — builds Claude context block from feature state
- `lib/features/conversation.ts` — feature conversation CRUD + Claude call
- `lib/features/review.ts` — app-wide UX review Claude call
- `lib/user-stories/client.ts` — CRUD for user_stories, feature_user_stories, fork
- `lib/scenarios/client.ts` — CRUD for scenarios and steps
- `lib/prototypes/storage.ts` — Figma PNG → Supabase Storage pipeline
- `lib/prototypes/generator.ts` — HTML prototype generation via Claude
- `lib/prototypes/vault.ts` — push generated HTML to vault repo
- `app/api/features/route.ts` — GET list, POST create
- `app/api/features/[id]/route.ts` — GET full, PATCH
- `app/api/features/[id]/tasks/route.ts` — POST link task
- `app/api/features/[id]/tasks/[taskId]/route.ts` — DELETE unlink task
- `app/api/features/[id]/stories/route.ts` — POST link/create story
- `app/api/features/[id]/stories/[storyId]/route.ts` — DELETE unlink story
- `app/api/features/[id]/prototype/route.ts` — POST generate prototype
- `app/api/features/[id]/conversation/route.ts` — GET history
- `app/api/features/[id]/conversation/message/route.ts` — POST send message
- `app/api/features/review/route.ts` — POST scoped UX review
- `app/api/user-stories/route.ts` — POST create standalone story
- `app/api/user-stories/[id]/route.ts` — PATCH update
- `app/api/user-stories/[id]/fork/route.ts` — POST fork shared story
- `app/api/scenarios/route.ts` — POST create
- `app/api/scenarios/[id]/route.ts` — PATCH
- `app/api/steps/route.ts` — POST create
- `app/api/steps/[id]/route.ts` — PATCH, DELETE
- `app/features/[id]/page.tsx` — full-page feature editor shell
- `app/features/[id]/components/UserStoriesPanel.tsx`
- `app/features/[id]/components/ScenariosPanel.tsx`
- `app/features/[id]/components/StepRow.tsx`
- `app/features/[id]/components/ClaudePanel.tsx`
- `app/features/[id]/components/ReviewPanel.tsx`
- `components/FeaturesTab.tsx` — task detail panel Features tab
- `__tests__/lib/features/client.test.ts`
- `__tests__/lib/features/context.test.ts`
- `__tests__/lib/features/conversation.test.ts`
- `__tests__/lib/features/review.test.ts`
- `__tests__/lib/user-stories/client.test.ts`
- `__tests__/lib/scenarios/client.test.ts`
- `__tests__/lib/prototypes/storage.test.ts`
- `__tests__/lib/prototypes/generator.test.ts`
- `__tests__/api/features/route.test.ts`
- `__tests__/api/features/prototype.test.ts`
- `__tests__/api/features/conversation.test.ts`

**Modified files:**
- `lib/supabase/types.ts` — add 8 new table types

---

## Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/011_feature_prototype_builder.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 011_feature_prototype_builder.sql

-- Core feature entity
create table if not exists features (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  status text not null default 'draft' check (status in ('draft','active','archived')),
  created_at timestamptz not null default now()
);

-- M:M features ↔ tasks
create table if not exists feature_tasks (
  feature_id uuid not null references features(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  primary key (feature_id, task_id)
);

-- Standalone user stories (reusable across features)
create table if not exists user_stories (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  as_a text not null,
  i_want text not null,
  so_that text not null,
  created_at timestamptz not null default now()
);

-- M:M features ↔ user_stories with ordering
create table if not exists feature_user_stories (
  feature_id uuid not null references features(id) on delete cascade,
  user_story_id uuid not null references user_stories(id) on delete cascade,
  display_order int not null default 0,
  primary key (feature_id, user_story_id)
);

-- Scenarios owned by a user story
create table if not exists scenarios (
  id uuid primary key default gen_random_uuid(),
  user_story_id uuid not null references user_stories(id) on delete cascade,
  title text not null,
  description text,
  display_order int not null default 0
);

-- Steps within a scenario (each maps to one Figma screen)
create table if not exists steps (
  id uuid primary key default gen_random_uuid(),
  scenario_id uuid not null references scenarios(id) on delete cascade,
  title text not null,
  description text,
  figma_url text,
  figma_frame_id text,
  figma_thumbnail_url text, -- permanent Supabase Storage URL once uploaded
  display_order int not null default 0
);

-- Generated HTML prototypes
create table if not exists feature_prototypes (
  id uuid primary key default gen_random_uuid(),
  feature_id uuid not null references features(id) on delete cascade,
  scenario_id uuid references scenarios(id) on delete set null,
  is_current boolean not null default true,
  html_content text not null,
  vault_path text,
  vault_url text,
  generated_by text not null,
  created_at timestamptz not null default now()
);

-- One conversation per feature (unique constraint)
create table if not exists feature_conversations (
  id uuid primary key default gen_random_uuid(),
  feature_id uuid not null unique references features(id) on delete cascade,
  status text not null default 'in_progress' check (status in ('in_progress','complete')),
  created_at timestamptz not null default now()
);

-- Messages within a feature conversation
create table if not exists feature_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references feature_conversations(id) on delete cascade,
  role text not null check (role in ('assistant','user')),
  content text not null,
  created_at timestamptz not null default now()
);

-- Supabase Storage bucket for permanent Figma images
insert into storage.buckets (id, name, public)
values ('prototype-assets', 'prototype-assets', true)
on conflict (id) do nothing;

-- Allow public reads on prototype-assets
create policy if not exists "prototype-assets public read"
  on storage.objects for select
  using (bucket_id = 'prototype-assets');

-- Allow authenticated users to upload
create policy if not exists "prototype-assets auth upload"
  on storage.objects for insert
  with check (bucket_id = 'prototype-assets' and auth.role() = 'authenticated');
```

- [ ] **Step 2: Apply the migration**

```bash
npx supabase db push
```

Expected: all 8 tables created, `prototype-assets` bucket visible in Supabase dashboard.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/011_feature_prototype_builder.sql
git commit -m "feat: add feature prototype builder DB migration"
```

---

## Task 2: TypeScript Types

**Files:**
- Modify: `lib/supabase/types.ts`

- [ ] **Step 1: Add the 8 new table types inside the `Tables` block**

Open `lib/supabase/types.ts` and add the following entries inside `Tables: {` alongside the existing tables:

```typescript
      features: {
        Row: { id: string; name: string; description: string | null; status: 'draft' | 'active' | 'archived'; created_at: string }
        Insert: { id?: string; name: string; description?: string | null; status?: 'draft' | 'active' | 'archived' }
        Update: { name?: string; description?: string | null; status?: 'draft' | 'active' | 'archived' }
        Relationships: []
      }
      feature_tasks: {
        Row: { feature_id: string; task_id: string }
        Insert: { feature_id: string; task_id: string }
        Update: never
        Relationships: []
      }
      user_stories: {
        Row: { id: string; title: string; as_a: string; i_want: string; so_that: string; created_at: string }
        Insert: { id?: string; title: string; as_a: string; i_want: string; so_that: string }
        Update: { title?: string; as_a?: string; i_want?: string; so_that?: string }
        Relationships: []
      }
      feature_user_stories: {
        Row: { feature_id: string; user_story_id: string; display_order: number }
        Insert: { feature_id: string; user_story_id: string; display_order?: number }
        Update: { display_order?: number }
        Relationships: []
      }
      scenarios: {
        Row: { id: string; user_story_id: string; title: string; description: string | null; display_order: number }
        Insert: { id?: string; user_story_id: string; title: string; description?: string | null; display_order?: number }
        Update: { title?: string; description?: string | null; display_order?: number }
        Relationships: []
      }
      steps: {
        Row: { id: string; scenario_id: string; title: string; description: string | null; figma_url: string | null; figma_frame_id: string | null; figma_thumbnail_url: string | null; display_order: number }
        Insert: { id?: string; scenario_id: string; title: string; description?: string | null; figma_url?: string | null; figma_frame_id?: string | null; figma_thumbnail_url?: string | null; display_order?: number }
        Update: { title?: string; description?: string | null; figma_url?: string | null; figma_frame_id?: string | null; figma_thumbnail_url?: string | null; display_order?: number }
        Relationships: []
      }
      feature_prototypes: {
        Row: { id: string; feature_id: string; scenario_id: string | null; is_current: boolean; html_content: string; vault_path: string | null; vault_url: string | null; generated_by: string; created_at: string }
        Insert: { id?: string; feature_id: string; scenario_id?: string | null; is_current?: boolean; html_content: string; vault_path?: string | null; vault_url?: string | null; generated_by: string }
        Update: { is_current?: boolean; vault_path?: string | null; vault_url?: string | null }
        Relationships: []
      }
      feature_conversations: {
        Row: { id: string; feature_id: string; status: 'in_progress' | 'complete'; created_at: string }
        Insert: { id?: string; feature_id: string; status?: 'in_progress' | 'complete' }
        Update: { status?: 'in_progress' | 'complete' }
        Relationships: []
      }
      feature_messages: {
        Row: { id: string; conversation_id: string; role: 'assistant' | 'user'; content: string; created_at: string }
        Insert: { id?: string; conversation_id: string; role: 'assistant' | 'user'; content: string }
        Update: never
        Relationships: []
      }
```

- [ ] **Step 2: Verify types compile**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/supabase/types.ts
git commit -m "feat: add feature prototype builder TypeScript types"
```

---

## Task 3: Feature & User Story CRUD Libs

**Files:**
- Create: `lib/features/client.ts`
- Create: `lib/user-stories/client.ts`
- Create: `__tests__/lib/features/client.test.ts`
- Create: `__tests__/lib/user-stories/client.test.ts`

- [ ] **Step 1: Write the failing tests for Feature CRUD**

```typescript
// __tests__/lib/features/client.test.ts
import { createFeature, getFeature, listFeatures, updateFeature, linkTask, unlinkTask } from '@/lib/features/client'

const mockFrom = jest.fn()
const mockSupabase = { from: mockFrom }
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue(mockSupabase),
}))

function mockChain(returnValue: unknown) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue(returnValue),
    order: jest.fn().mockResolvedValue(returnValue),
  }
  return chain
}

describe('createFeature', () => {
  it('inserts a feature and returns it', async () => {
    const feature = { id: 'f-1', name: 'Login Flow', description: null, status: 'draft', created_at: '' }
    mockFrom.mockReturnValue(mockChain({ data: feature, error: null }))
    const result = await createFeature({ name: 'Login Flow' })
    expect(result).toEqual(feature)
    expect(mockFrom).toHaveBeenCalledWith('features')
  })

  it('throws when Supabase returns an error', async () => {
    mockFrom.mockReturnValue(mockChain({ data: null, error: { message: 'db error' } }))
    await expect(createFeature({ name: 'x' })).rejects.toThrow('db error')
  })
})

describe('linkTask', () => {
  it('inserts into feature_tasks', async () => {
    const chain = mockChain({ data: null, error: null })
    mockFrom.mockReturnValue(chain)
    await linkTask('f-1', 'task-1')
    expect(mockFrom).toHaveBeenCalledWith('feature_tasks')
    expect(chain.insert).toHaveBeenCalledWith({ feature_id: 'f-1', task_id: 'task-1' })
  })
})

describe('unlinkTask', () => {
  it('deletes from feature_tasks', async () => {
    const chain = mockChain({ data: null, error: null })
    chain.delete = jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) }) })
    mockFrom.mockReturnValue(chain)
    await unlinkTask('f-1', 'task-1')
    expect(mockFrom).toHaveBeenCalledWith('feature_tasks')
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx jest __tests__/lib/features/client.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/features/client'`

- [ ] **Step 3: Write `lib/features/client.ts`**

```typescript
// lib/features/client.ts
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import type { Tables, InsertDto, UpdateDto } from '@/lib/supabase/types'

export type Feature = Tables<'features'>
export type FeatureInsert = InsertDto<'features'>
export type FeatureUpdate = UpdateDto<'features'>

export async function createFeature(data: FeatureInsert): Promise<Feature> {
  const db = await getSupabaseServiceClient()
  const { data: row, error } = await db.from('features').insert(data).select().single()
  if (error) throw new Error(error.message)
  return row
}

export async function getFeature(id: string): Promise<Feature | null> {
  const db = await getSupabaseServiceClient()
  const { data, error } = await db.from('features').select().eq('id', id).single()
  if (error) return null
  return data
}

export async function listFeatures(query?: string): Promise<Feature[]> {
  const db = await getSupabaseServiceClient()
  let q = db.from('features').select()
  if (query) q = q.ilike('name', `%${query}%`)
  const { data, error } = await q.order('created_at', { ascending: false })
  if (error) return []
  return data ?? []
}

export async function updateFeature(id: string, data: FeatureUpdate): Promise<Feature> {
  const db = await getSupabaseServiceClient()
  const { data: row, error } = await db.from('features').update(data).eq('id', id).select().single()
  if (error) throw new Error(error.message)
  return row
}

export async function linkTask(featureId: string, taskId: string): Promise<void> {
  const db = await getSupabaseServiceClient()
  const { error } = await db.from('feature_tasks').insert({ feature_id: featureId, task_id: taskId })
  if (error && !error.message.includes('duplicate')) throw new Error(error.message)
}

export async function unlinkTask(featureId: string, taskId: string): Promise<void> {
  const db = await getSupabaseServiceClient()
  const { error } = await db.from('feature_tasks').delete().eq('feature_id', featureId).eq('task_id', taskId)
  if (error) throw new Error(error.message)
}

export async function getTaskFeatures(taskId: string): Promise<Feature[]> {
  const db = await getSupabaseServiceClient()
  const { data, error } = await db
    .from('feature_tasks')
    .select('features(*)')
    .eq('task_id', taskId)
  if (error || !data) return []
  return data.flatMap((r: { features: Feature | Feature[] | null }) =>
    r.features ? (Array.isArray(r.features) ? r.features : [r.features]) : []
  )
}
```

- [ ] **Step 4: Write failing tests for User Story CRUD**

```typescript
// __tests__/lib/user-stories/client.test.ts
import { createUserStory, updateUserStory, linkStory, unlinkStory, forkStory, getStoryFeatureCount } from '@/lib/user-stories/client'

const mockFrom = jest.fn()
const mockSupabase = { from: mockFrom }
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue(mockSupabase),
}))

function chain(ret: unknown) {
  return {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue(ret),
    count: jest.fn().mockReturnThis(),
  }
}

describe('createUserStory', () => {
  it('inserts and returns the story', async () => {
    const story = { id: 's-1', title: 'T', as_a: 'PM', i_want: 'x', so_that: 'y', created_at: '' }
    mockFrom.mockReturnValue(chain({ data: story, error: null }))
    const result = await createUserStory({ title: 'T', as_a: 'PM', i_want: 'x', so_that: 'y' })
    expect(result).toEqual(story)
  })
})

describe('forkStory', () => {
  it('creates a copy with the same fields', async () => {
    const original = { id: 's-1', title: 'T', as_a: 'PM', i_want: 'x', so_that: 'y', created_at: '' }
    const forked = { ...original, id: 's-2' }
    mockFrom
      .mockReturnValueOnce(chain({ data: original, error: null })) // getStory
      .mockReturnValueOnce(chain({ data: forked, error: null }))   // insert fork
      .mockReturnValueOnce(chain({ data: null, error: null }))     // link fork to feature
    const result = await forkStory('s-1', 'f-1')
    expect(result.id).toBe('s-2')
  })
})
```

- [ ] **Step 5: Write `lib/user-stories/client.ts`**

```typescript
// lib/user-stories/client.ts
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import type { Tables, InsertDto, UpdateDto } from '@/lib/supabase/types'

export type UserStory = Tables<'user_stories'>

export async function createUserStory(data: InsertDto<'user_stories'>): Promise<UserStory> {
  const db = await getSupabaseServiceClient()
  const { data: row, error } = await db.from('user_stories').insert(data).select().single()
  if (error) throw new Error(error.message)
  return row
}

export async function updateUserStory(id: string, data: UpdateDto<'user_stories'>): Promise<UserStory> {
  const db = await getSupabaseServiceClient()
  const { data: row, error } = await db.from('user_stories').update(data).eq('id', id).select().single()
  if (error) throw new Error(error.message)
  return row
}

export async function linkStory(featureId: string, storyId: string, displayOrder = 0): Promise<void> {
  const db = await getSupabaseServiceClient()
  const { error } = await db
    .from('feature_user_stories')
    .insert({ feature_id: featureId, user_story_id: storyId, display_order: displayOrder })
  if (error && !error.message.includes('duplicate')) throw new Error(error.message)
}

export async function unlinkStory(featureId: string, storyId: string): Promise<void> {
  const db = await getSupabaseServiceClient()
  const { error } = await db
    .from('feature_user_stories')
    .delete()
    .eq('feature_id', featureId)
    .eq('user_story_id', storyId)
  if (error) throw new Error(error.message)
}

export async function getStoryFeatureCount(storyId: string): Promise<number> {
  const db = await getSupabaseServiceClient()
  const { count, error } = await db
    .from('feature_user_stories')
    .select('*', { count: 'exact', head: true })
    .eq('user_story_id', storyId)
  if (error) return 0
  return count ?? 0
}

export async function forkStory(storyId: string, targetFeatureId: string): Promise<UserStory> {
  const db = await getSupabaseServiceClient()
  const { data: original, error: fetchErr } = await db
    .from('user_stories').select().eq('id', storyId).single()
  if (fetchErr || !original) throw new Error('Story not found')
  const { id: _id, created_at: _ca, ...fields } = original
  const { data: forked, error: insertErr } = await db
    .from('user_stories').insert(fields).select().single()
  if (insertErr || !forked) throw new Error('Fork failed')
  await linkStory(targetFeatureId, forked.id, 0)
  return forked
}

export async function getFeatureStories(featureId: string): Promise<UserStory[]> {
  const db = await getSupabaseServiceClient()
  const { data, error } = await db
    .from('feature_user_stories')
    .select('user_stories(*), display_order')
    .eq('feature_id', featureId)
    .order('display_order')
  if (error || !data) return []
  return data.flatMap((r: { user_stories: UserStory | UserStory[] | null }) =>
    r.user_stories ? (Array.isArray(r.user_stories) ? r.user_stories : [r.user_stories]) : []
  )
}
```

- [ ] **Step 6: Run all tests**

```bash
npx jest __tests__/lib/features/client.test.ts __tests__/lib/user-stories/client.test.ts --no-coverage
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/features/client.ts lib/user-stories/client.ts __tests__/lib/features/client.test.ts __tests__/lib/user-stories/client.test.ts
git commit -m "feat: add feature and user story CRUD libs"
```

---

## Task 4: Scenarios & Steps CRUD Lib

**Files:**
- Create: `lib/scenarios/client.ts`
- Create: `__tests__/lib/scenarios/client.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// __tests__/lib/scenarios/client.test.ts
import { createScenario, updateScenario, createStep, updateStep, deleteStep, getScenarioSteps } from '@/lib/scenarios/client'

const mockFrom = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({ from: mockFrom }),
}))

function chain(ret: unknown) {
  return { select: jest.fn().mockReturnThis(), insert: jest.fn().mockReturnThis(), update: jest.fn().mockReturnThis(), delete: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), single: jest.fn().mockResolvedValue(ret), order: jest.fn().mockResolvedValue(ret) }
}

describe('createScenario', () => {
  it('inserts a scenario', async () => {
    const scenario = { id: 'sc-1', user_story_id: 's-1', title: 'Happy Path', description: null, display_order: 0 }
    mockFrom.mockReturnValue(chain({ data: scenario, error: null }))
    const result = await createScenario({ user_story_id: 's-1', title: 'Happy Path' })
    expect(result).toEqual(scenario)
  })
})

describe('createStep', () => {
  it('inserts a step', async () => {
    const step = { id: 'st-1', scenario_id: 'sc-1', title: 'Landing', description: null, figma_url: null, figma_frame_id: null, figma_thumbnail_url: null, display_order: 0 }
    mockFrom.mockReturnValue(chain({ data: step, error: null }))
    const result = await createStep({ scenario_id: 'sc-1', title: 'Landing' })
    expect(result).toEqual(step)
  })
})

describe('deleteStep', () => {
  it('deletes a step by id', async () => {
    const c = chain({ error: null })
    c.delete = jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) })
    mockFrom.mockReturnValue(c)
    await expect(deleteStep('st-1')).resolves.not.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx jest __tests__/lib/scenarios/client.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/scenarios/client'`

- [ ] **Step 3: Write `lib/scenarios/client.ts`**

```typescript
// lib/scenarios/client.ts
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { parseFigmaUrl } from '@/lib/figma/client'
import type { Tables, InsertDto, UpdateDto } from '@/lib/supabase/types'

export type Scenario = Tables<'scenarios'>
export type Step = Tables<'steps'>

export async function createScenario(data: InsertDto<'scenarios'>): Promise<Scenario> {
  const db = await getSupabaseServiceClient()
  const { data: row, error } = await db.from('scenarios').insert(data).select().single()
  if (error) throw new Error(error.message)
  return row
}

export async function updateScenario(id: string, data: UpdateDto<'scenarios'>): Promise<Scenario> {
  const db = await getSupabaseServiceClient()
  const { data: row, error } = await db.from('scenarios').update(data).eq('id', id).select().single()
  if (error) throw new Error(error.message)
  return row
}

export async function createStep(data: InsertDto<'steps'>): Promise<Step> {
  const db = await getSupabaseServiceClient()
  const enriched = enrichStepWithFigmaId(data)
  const { data: row, error } = await db.from('steps').insert(enriched).select().single()
  if (error) throw new Error(error.message)
  return row
}

export async function updateStep(id: string, data: UpdateDto<'steps'>): Promise<Step> {
  const db = await getSupabaseServiceClient()
  const enriched = enrichStepWithFigmaId(data)
  const { data: row, error } = await db.from('steps').update(enriched).eq('id', id).select().single()
  if (error) throw new Error(error.message)
  return row
}

export async function deleteStep(id: string): Promise<void> {
  const db = await getSupabaseServiceClient()
  const { error } = await db.from('steps').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export async function getScenarioSteps(scenarioId: string): Promise<Step[]> {
  const db = await getSupabaseServiceClient()
  const { data, error } = await db
    .from('steps').select().eq('scenario_id', scenarioId).order('display_order')
  if (error) return []
  return data ?? []
}

export async function getStoryScenarios(storyId: string): Promise<Scenario[]> {
  const db = await getSupabaseServiceClient()
  const { data, error } = await db
    .from('scenarios').select().eq('user_story_id', storyId).order('display_order')
  if (error) return []
  return data ?? []
}

function enrichStepWithFigmaId<T extends { figma_url?: string | null }>(data: T): T {
  if (!data.figma_url) return data
  const parsed = parseFigmaUrl(data.figma_url)
  if (!parsed) return data
  return { ...data, figma_frame_id: parsed.nodeId ?? null }
}
```

- [ ] **Step 4: Run tests**

```bash
npx jest __tests__/lib/scenarios/client.test.ts --no-coverage
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/scenarios/client.ts __tests__/lib/scenarios/client.test.ts
git commit -m "feat: add scenarios and steps CRUD lib"
```

---

## Task 5: Figma Image Permanence Pipeline

**Files:**
- Create: `lib/prototypes/storage.ts`
- Create: `__tests__/lib/prototypes/storage.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// __tests__/lib/prototypes/storage.test.ts
import { ensureStepImages } from '@/lib/prototypes/storage'

const mockStorage = {
  from: jest.fn().mockReturnThis(),
  upload: jest.fn(),
  getPublicUrl: jest.fn(),
}
const mockUpdate = jest.fn()
const mockFrom = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({
    storage: mockStorage,
    from: mockFrom,
  }),
}))

describe('ensureStepImages', () => {
  const supabaseUrl = 'https://proj.supabase.co/storage/v1/object/public/prototype-assets'

  beforeEach(() => {
    jest.clearAllMocks()
    ;(global.fetch as jest.Mock) = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    })
    mockStorage.from.mockReturnThis()
    mockStorage.upload.mockResolvedValue({ data: { path: 'steps/st-1.png' }, error: null })
    mockStorage.getPublicUrl.mockReturnValue({ data: { publicUrl: `${supabaseUrl}/steps/st-1.png` } })
    const chain = { update: mockUpdate, eq: jest.fn().mockReturnThis() }
    mockUpdate.mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) })
    mockFrom.mockReturnValue(chain)
  })

  it('skips steps that already have a Supabase Storage URL', async () => {
    const steps = [{ id: 'st-1', figma_thumbnail_url: `${supabaseUrl}/steps/st-1.png`, figma_url: 'https://figma.com/design/abc' } as Parameters<typeof ensureStepImages>[0][0]]
    await ensureStepImages(steps)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('fetches and uploads steps with Figma CDN URLs', async () => {
    const steps = [{ id: 'st-1', figma_thumbnail_url: 'https://s3.figma.com/temp/img.png', figma_url: 'https://figma.com/design/abc' } as Parameters<typeof ensureStepImages>[0][0]]
    const result = await ensureStepImages(steps)
    expect(global.fetch).toHaveBeenCalledWith('https://s3.figma.com/temp/img.png')
    expect(mockStorage.upload).toHaveBeenCalled()
    expect(result[0].figma_thumbnail_url).toContain(supabaseUrl)
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx jest __tests__/lib/prototypes/storage.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/prototypes/storage'`

- [ ] **Step 3: Write `lib/prototypes/storage.ts`**

```typescript
// lib/prototypes/storage.ts
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import type { Step } from '@/lib/scenarios/client'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const BUCKET = 'prototype-assets'

function isSupabaseUrl(url: string): boolean {
  return url.startsWith(SUPABASE_URL)
}

async function uploadFigmaImage(stepId: string, figmaUrl: string): Promise<string | null> {
  const db = await getSupabaseServiceClient()
  let imageData: ArrayBuffer
  try {
    const res = await fetch(figmaUrl)
    if (!res.ok) return null
    imageData = await res.arrayBuffer()
  } catch {
    return null
  }

  const path = `steps/${stepId}.png`
  const { error } = await db.storage
    .from(BUCKET)
    .upload(path, imageData, { contentType: 'image/png', upsert: true })
  if (error) return null

  const { data } = db.storage.from(BUCKET).getPublicUrl(path)
  return data.publicUrl
}

export async function ensureStepImages(steps: Pick<Step, 'id' | 'figma_thumbnail_url' | 'figma_url'>[]): Promise<Pick<Step, 'id' | 'figma_thumbnail_url' | 'figma_url'>[]> {
  const db = await getSupabaseServiceClient()
  return Promise.all(steps.map(async (step) => {
    if (!step.figma_thumbnail_url || isSupabaseUrl(step.figma_thumbnail_url)) return step
    const permanentUrl = await uploadFigmaImage(step.id, step.figma_thumbnail_url)
    if (!permanentUrl) return step
    await db.from('steps').update({ figma_thumbnail_url: permanentUrl }).eq('id', step.id)
    return { ...step, figma_thumbnail_url: permanentUrl }
  }))
}
```

- [ ] **Step 4: Run tests**

```bash
npx jest __tests__/lib/prototypes/storage.test.ts --no-coverage
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/prototypes/storage.ts __tests__/lib/prototypes/storage.test.ts
git commit -m "feat: add Figma image permanence pipeline to Supabase Storage"
```

---

## Task 6: Feature Context Builder

**Files:**
- Create: `lib/features/context.ts`
- Create: `__tests__/lib/features/context.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// __tests__/lib/features/context.test.ts
import { buildFeatureContext } from '@/lib/features/context'

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({
    from: jest.fn().mockImplementation((table: string) => {
      if (table === 'features') return { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), single: jest.fn().mockResolvedValue({ data: { id: 'f-1', name: 'Login', description: 'Auth flow', status: 'draft' }, error: null }) }
      if (table === 'feature_user_stories') return { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), order: jest.fn().mockResolvedValue({ data: [{ user_stories: { id: 's-1', title: 'T', as_a: 'PM', i_want: 'log in', so_that: 'access app' }, display_order: 0 }], error: null }) }
      if (table === 'scenarios') return { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), order: jest.fn().mockResolvedValue({ data: [{ id: 'sc-1', title: 'Happy Path', description: null, display_order: 0 }], error: null }) }
      if (table === 'steps') return { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), order: jest.fn().mockResolvedValue({ data: [{ id: 'st-1', title: 'Landing', description: 'User arrives', figma_url: 'https://figma.com/design/abc', figma_thumbnail_url: 'https://proj.supabase.co/img.png', display_order: 0 }], error: null }) }
      return { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), single: jest.fn().mockResolvedValue({ data: null, error: null }) }
    }),
  }),
}))

describe('buildFeatureContext', () => {
  it('includes feature name and status', async () => {
    const ctx = await buildFeatureContext('f-1')
    expect(ctx).toContain('Feature: Login')
    expect(ctx).toContain('Status: draft')
  })

  it('includes user story in as_a/i_want/so_that format', async () => {
    const ctx = await buildFeatureContext('f-1')
    expect(ctx).toContain('As a PM, I want log in so that access app')
  })

  it('includes scenario and step with image reference', async () => {
    const ctx = await buildFeatureContext('f-1')
    expect(ctx).toContain('Scenario: Happy Path')
    expect(ctx).toContain('Step 1: Landing')
    expect(ctx).toContain('https://proj.supabase.co/img.png')
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx jest __tests__/lib/features/context.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/features/context'`

- [ ] **Step 3: Write `lib/features/context.ts`**

```typescript
// lib/features/context.ts
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export async function buildFeatureContext(featureId: string): Promise<string> {
  const db = await getSupabaseServiceClient()

  const { data: feature } = await db.from('features').select().eq('id', featureId).single()
  if (!feature) return ''

  const { data: fus } = await db
    .from('feature_user_stories')
    .select('user_stories(*), display_order')
    .eq('feature_id', featureId)
    .order('display_order')

  const lines: string[] = [
    `Feature: ${feature.name}`,
    `Status: ${feature.status}`,
    feature.description ? `Description: ${feature.description}` : '',
    '',
  ]

  for (const fu of fus ?? []) {
    const story = fu.user_stories as { id: string; as_a: string; i_want: string; so_that: string } | null
    if (!story) continue
    lines.push(`User Story: As a ${story.as_a}, I want ${story.i_want} so that ${story.so_that}`)

    const { data: scenarios } = await db
      .from('scenarios').select().eq('user_story_id', story.id).order('display_order')

    for (const scenario of scenarios ?? []) {
      lines.push(`  Scenario: ${scenario.title}${scenario.description ? ` — ${scenario.description}` : ''}`)

      const { data: steps } = await db
        .from('steps').select().eq('scenario_id', scenario.id).order('display_order')

      let stepNum = 1
      for (const step of steps ?? []) {
        const img = step.figma_thumbnail_url ? ` [image: ${step.figma_thumbnail_url}]` : ' [no image]'
        const figmaLink = step.figma_url ? ` [figma: ${step.figma_url}]` : ''
        lines.push(`    Step ${stepNum}: ${step.title}${step.description ? ` — ${step.description}` : ''}${img}${figmaLink}`)
        stepNum++
      }
    }
    lines.push('')
  }

  return lines.filter((l) => l !== undefined).join('\n')
}

export async function buildAllFeaturesContext(featureIds?: string[]): Promise<string> {
  const db = await getSupabaseServiceClient()
  let q = db.from('features').select('id').eq('status', 'active')
  if (featureIds?.length) q = db.from('features').select('id').in('id', featureIds)
  const { data } = await q
  const ids: string[] = (data ?? []).map((f: { id: string }) => f.id)
  const blocks = await Promise.all(ids.map(buildFeatureContext))
  return blocks.join('\n---\n')
}
```

- [ ] **Step 4: Run tests**

```bash
npx jest __tests__/lib/features/context.test.ts --no-coverage
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/features/context.ts __tests__/lib/features/context.test.ts
git commit -m "feat: add feature context builder for Claude prompts"
```

---

## Task 7: Prototype Generator

**Files:**
- Create: `lib/prototypes/generator.ts`
- Create: `lib/prototypes/vault.ts`
- Create: `__tests__/lib/prototypes/generator.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// __tests__/lib/prototypes/generator.test.ts
import { generatePrototypeHtml } from '@/lib/prototypes/generator'

const mockCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () => ({
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}))

describe('generatePrototypeHtml', () => {
  const featureContext = `Feature: Login\nStatus: draft\nUser Story: As a PM...\n  Scenario: Happy Path\n    Step 1: Landing — User arrives [image: https://proj.supabase.co/img.png] [figma: https://figma.com/design/abc]`

  it('returns HTML string from Claude response', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '<html><body>prototype</body></html>' }],
    })
    const html = await generatePrototypeHtml(featureContext, 'Happy Path')
    expect(html).toContain('<html>')
    expect(html).toContain('prototype')
  })

  it('throws if Claude returns empty', async () => {
    mockCreate.mockResolvedValue({ content: [] })
    await expect(generatePrototypeHtml(featureContext, 'Happy Path')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx jest __tests__/lib/prototypes/generator.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/prototypes/generator'`

- [ ] **Step 3: Write `lib/prototypes/generator.ts`**

```typescript
// lib/prototypes/generator.ts
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const GENERATION_SYSTEM = `You are a prototype HTML generator. You receive a feature context describing user stories, scenarios, and steps — each step has a title, narration text, and an image URL.

Generate a complete, self-contained HTML slideshow prototype. Requirements:
- One slide per step
- Each slide shows: step title, narration text, and the step image via <img src="[image url]">
- A "View in Figma" anchor using the figma URL for that step (open in new tab)
- Previous / Next navigation buttons
- Scenario title and "Step X of Y" counter in the header
- Hotspot detection: if a step's description mentions navigating to another step (e.g. "Clicking Save goes to step 3", "Tapping X proceeds to the confirmation"), wrap that text in a <button> with onclick="goToSlide(N-1)" where N is the target step number
- Dark-mode aware styling using CSS prefers-color-scheme
- All CSS and JavaScript must be inline — no external dependencies, no CDN links
- The output must be a complete working HTML document

Output ONLY the HTML. No explanation, no markdown fences.`

export async function generatePrototypeHtml(
  featureContext: string,
  scenarioTitle: string
): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: GENERATION_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Generate the prototype for scenario "${scenarioTitle}".\n\n${featureContext}`,
      },
    ],
  })

  const block = response.content.find((b) => b.type === 'text')
  if (!block || block.type !== 'text' || !block.text) throw new Error('Claude returned no HTML')
  return block.text.trim()
}
```

- [ ] **Step 4: Write `lib/prototypes/vault.ts`**

```typescript
// lib/prototypes/vault.ts
import { writeVaultFile } from '@/lib/github/vault'

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
}

export async function pushPrototypeToVault(
  token: string,
  featureId: string,
  featureName: string,
  scenarioTitle: string | null,
  html: string
): Promise<{ vaultPath: string; vaultUrl: string } | null> {
  const featureSlug = slugify(featureName)
  const fileName = scenarioTitle ? `${slugify(scenarioTitle)}.html` : 'all.html'
  const vaultPath = `prototypes/features/${featureId}/${fileName}`

  const result = await writeVaultFile(
    token,
    vaultPath,
    html,
    `prototype: ${featureName}${scenarioTitle ? ` — ${scenarioTitle}` : ''}`
  )
  if (!result) return null
  return { vaultPath, vaultUrl: result.url }
}
```

- [ ] **Step 5: Run generator tests**

```bash
npx jest __tests__/lib/prototypes/generator.test.ts --no-coverage
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/prototypes/generator.ts lib/prototypes/vault.ts __tests__/lib/prototypes/generator.test.ts
git commit -m "feat: add prototype HTML generator and vault push"
```

---

## Task 8: Feature Conversation Lib

**Files:**
- Create: `lib/features/conversation.ts`
- Create: `__tests__/lib/features/conversation.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// __tests__/lib/features/conversation.test.ts
import { getOrCreateConversation, addMessage, sendFeatureMessage } from '@/lib/features/conversation'

const mockFrom = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({ from: mockFrom }),
}))
jest.mock('@/lib/features/context', () => ({
  buildFeatureContext: jest.fn().mockResolvedValue('Feature: Login\nStatus: draft'),
}))
const mockCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () => ({
  default: jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })),
}))

function chain(ret: unknown) {
  return { select: jest.fn().mockReturnThis(), insert: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), single: jest.fn().mockResolvedValue(ret), order: jest.fn().mockResolvedValue(ret) }
}

describe('getOrCreateConversation', () => {
  it('returns existing conversation if found', async () => {
    const conv = { id: 'c-1', feature_id: 'f-1', status: 'in_progress', created_at: '' }
    mockFrom.mockReturnValue(chain({ data: conv, error: null }))
    const result = await getOrCreateConversation('f-1')
    expect(result.id).toBe('c-1')
  })

  it('creates a new conversation when none exists', async () => {
    const conv = { id: 'c-new', feature_id: 'f-1', status: 'in_progress', created_at: '' }
    mockFrom
      .mockReturnValueOnce(chain({ data: null, error: { message: 'not found' } }))
      .mockReturnValueOnce(chain({ data: conv, error: null }))
    const result = await getOrCreateConversation('f-1')
    expect(result.id).toBe('c-new')
  })
})

describe('sendFeatureMessage', () => {
  it('returns assistant content and saves both messages', async () => {
    const conv = { id: 'c-1', feature_id: 'f-1', status: 'in_progress', created_at: '' }
    mockFrom
      .mockReturnValueOnce(chain({ data: conv, error: null }))  // getOrCreate
      .mockReturnValueOnce(chain({ data: [], error: null }))    // getMessages history
      .mockReturnValueOnce(chain({ data: null, error: null }))  // insert user message
      .mockReturnValueOnce(chain({ data: null, error: null }))  // insert assistant message
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Great flow!' }] })
    const { content } = await sendFeatureMessage('f-1', 'What do you think?')
    expect(content).toBe('Great flow!')
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx jest __tests__/lib/features/conversation.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/features/conversation'`

- [ ] **Step 3: Write `lib/features/conversation.ts`**

```typescript
// lib/features/conversation.ts
import Anthropic from '@anthropic-ai/sdk'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildFeatureContext } from '@/lib/features/context'
import type { Tables } from '@/lib/supabase/types'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export type FeatureConversation = Tables<'feature_conversations'>
export type FeatureMessage = Tables<'feature_messages'>

const CONVERSATION_SYSTEM = `You are a product design assistant helping a PM refine a feature's user stories, scenarios, and steps.

You have full context of the feature's current state. You can:
- Suggest new steps (format as: **[SUGGESTED STEP]** Title: "..." | Description: "...")
- Critique scenario completeness
- Annotate or improve step descriptions
- Generate an HTML prototype when asked (return ONLY the HTML, no markdown fences)
- Help identify UX gaps

Be concise and actionable.`

export async function getOrCreateConversation(featureId: string): Promise<FeatureConversation> {
  const db = await getSupabaseServiceClient()
  const { data: existing } = await db
    .from('feature_conversations').select().eq('feature_id', featureId).single()
  if (existing) return existing
  const { data: created, error } = await db
    .from('feature_conversations').insert({ feature_id: featureId }).select().single()
  if (error || !created) throw new Error('Failed to create conversation')
  return created
}

export async function addMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string
): Promise<FeatureMessage> {
  const db = await getSupabaseServiceClient()
  const { data, error } = await db
    .from('feature_messages').insert({ conversation_id: conversationId, role, content }).select().single()
  if (error || !data) throw new Error('Failed to save message')
  return data
}

export async function getMessages(conversationId: string): Promise<FeatureMessage[]> {
  const db = await getSupabaseServiceClient()
  const { data } = await db
    .from('feature_messages').select().eq('conversation_id', conversationId).order('created_at')
  return data ?? []
}

export async function sendFeatureMessage(
  featureId: string,
  userContent: string
): Promise<{ content: string; suggestedStep: { title: string; description: string } | null }> {
  const conversation = await getOrCreateConversation(featureId)
  const history = await getMessages(conversation.id)
  const featureContext = await buildFeatureContext(featureId)

  await addMessage(conversation.id, 'user', userContent)

  const messages = [
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user' as const, content: userContent },
  ]

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: `${CONVERSATION_SYSTEM}\n\n--- Current Feature State ---\n${featureContext}`,
    messages,
  })

  const block = response.content.find((b) => b.type === 'text')
  const assistantContent = block?.type === 'text' ? block.text : ''
  await addMessage(conversation.id, 'assistant', assistantContent)

  const suggestedStep = parseSuggestedStep(assistantContent)
  return { content: assistantContent, suggestedStep }
}

function parseSuggestedStep(text: string): { title: string; description: string } | null {
  const match = text.match(/\*\*\[SUGGESTED STEP\]\*\*\s+Title:\s*"([^"]+)"\s*\|\s*Description:\s*"([^"]+)"/)
  if (!match) return null
  return { title: match[1], description: match[2] }
}
```

- [ ] **Step 4: Run tests**

```bash
npx jest __tests__/lib/features/conversation.test.ts --no-coverage
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/features/conversation.ts __tests__/lib/features/conversation.test.ts
git commit -m "feat: add feature conversation lib with Claude chat and suggested-step detection"
```

---

## Task 9: API Routes — Features, User Stories, Scenarios, Steps

**Files:**
- Create: all API routes listed in the File Map above
- Create: `__tests__/api/features/route.test.ts`

- [ ] **Step 1: Write the failing tests for the features route**

```typescript
// __tests__/api/features/route.test.ts
import { GET, POST } from '@/app/api/features/route'
import { NextRequest } from 'next/server'

jest.mock('@/lib/features/client', () => ({
  listFeatures: jest.fn().mockResolvedValue([{ id: 'f-1', name: 'Login', status: 'draft' }]),
  createFeature: jest.fn().mockResolvedValue({ id: 'f-2', name: 'New', status: 'draft' }),
}))
jest.mock('@/lib/auth', () => ({
  getSessionUser: jest.fn().mockResolvedValue({ email: 'pm@test.com' }),
}))

describe('GET /api/features', () => {
  it('returns feature list', async () => {
    const req = new NextRequest('http://localhost/api/features')
    const res = await GET(req)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toHaveLength(1)
    expect(json[0].id).toBe('f-1')
  })
})

describe('POST /api/features', () => {
  it('creates a feature', async () => {
    const req = new NextRequest('http://localhost/api/features', {
      method: 'POST',
      body: JSON.stringify({ name: 'New' }),
    })
    const res = await POST(req)
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.id).toBe('f-2')
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx jest __tests__/api/features/route.test.ts --no-coverage
```

Expected: FAIL.

- [ ] **Step 3: Create `app/api/features/route.ts`**

```typescript
// app/api/features/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { listFeatures, createFeature } from '@/lib/features/client'
import { getSessionUser } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') ?? undefined
  const features = await listFeatures(q)
  return NextResponse.json(features)
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json()
  if (!body.name) return NextResponse.json({ error: 'name required' }, { status: 400 })
  const feature = await createFeature({ name: body.name, description: body.description ?? null })
  return NextResponse.json(feature, { status: 201 })
}
```

- [ ] **Step 4: Create remaining feature API routes**

Create `app/api/features/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getFeature, updateFeature } from '@/lib/features/client'
import { getFeatureStories } from '@/lib/user-stories/client'
import { getStoryScenarios, getScenarioSteps } from '@/lib/scenarios/client'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const feature = await getFeature(id)
  if (!feature) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const stories = await getFeatureStories(id)
  const storiesWithScenarios = await Promise.all(stories.map(async (story) => {
    const scenarios = await getStoryScenarios(story.id)
    const scenariosWithSteps = await Promise.all(scenarios.map(async (scenario) => ({
      ...scenario,
      steps: await getScenarioSteps(scenario.id),
    })))
    return { ...story, scenarios: scenariosWithSteps }
  }))
  return NextResponse.json({ ...feature, stories: storiesWithScenarios })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const feature = await updateFeature(id, body)
  return NextResponse.json(feature)
}
```

Create `app/api/features/[id]/tasks/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { linkTask } from '@/lib/features/client'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { task_id } = await req.json()
  if (!task_id) return NextResponse.json({ error: 'task_id required' }, { status: 400 })
  await linkTask(id, task_id)
  return NextResponse.json({ ok: true })
}
```

Create `app/api/features/[id]/tasks/[taskId]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { unlinkTask } from '@/lib/features/client'

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  const { id, taskId } = await params
  await unlinkTask(id, taskId)
  return NextResponse.json({ ok: true })
}
```

Create `app/api/features/[id]/stories/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { createUserStory, linkStory, getFeatureStories, getStoryFeatureCount } from '@/lib/user-stories/client'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const stories = await getFeatureStories(id)
  const storiesWithCount = await Promise.all(stories.map(async (s) => ({
    ...s,
    featureCount: await getStoryFeatureCount(s.id),
  })))
  return NextResponse.json(storiesWithCount)
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  if (body.story_id) {
    await linkStory(id, body.story_id, body.display_order ?? 0)
    return NextResponse.json({ ok: true })
  }
  if (!body.as_a || !body.i_want || !body.so_that) {
    return NextResponse.json({ error: 'as_a, i_want, so_that required' }, { status: 400 })
  }
  const story = await createUserStory({ title: body.title ?? body.as_a, as_a: body.as_a, i_want: body.i_want, so_that: body.so_that })
  await linkStory(id, story.id, body.display_order ?? 0)
  return NextResponse.json(story, { status: 201 })
}
```

Create `app/api/features/[id]/stories/[storyId]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { unlinkStory } from '@/lib/user-stories/client'

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; storyId: string }> }) {
  const { id, storyId } = await params
  await unlinkStory(id, storyId)
  return NextResponse.json({ ok: true })
}
```

Create `app/api/user-stories/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { createUserStory } from '@/lib/user-stories/client'

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (!body.as_a || !body.i_want || !body.so_that) {
    return NextResponse.json({ error: 'as_a, i_want, so_that required' }, { status: 400 })
  }
  const story = await createUserStory({ title: body.title ?? body.as_a, as_a: body.as_a, i_want: body.i_want, so_that: body.so_that })
  return NextResponse.json(story, { status: 201 })
}
```

Create `app/api/user-stories/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { updateUserStory } from '@/lib/user-stories/client'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const story = await updateUserStory(id, body)
  return NextResponse.json(story)
}
```

Create `app/api/user-stories/[id]/fork/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { forkStory } from '@/lib/user-stories/client'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { target_feature_id } = await req.json()
  if (!target_feature_id) return NextResponse.json({ error: 'target_feature_id required' }, { status: 400 })
  const forked = await forkStory(id, target_feature_id)
  return NextResponse.json(forked, { status: 201 })
}
```

Create `app/api/scenarios/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { createScenario } from '@/lib/scenarios/client'

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (!body.user_story_id || !body.title) return NextResponse.json({ error: 'user_story_id and title required' }, { status: 400 })
  const scenario = await createScenario(body)
  return NextResponse.json(scenario, { status: 201 })
}
```

Create `app/api/scenarios/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { updateScenario } from '@/lib/scenarios/client'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const scenario = await updateScenario(id, body)
  return NextResponse.json(scenario)
}
```

Create `app/api/steps/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { createStep } from '@/lib/scenarios/client'

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (!body.scenario_id || !body.title) return NextResponse.json({ error: 'scenario_id and title required' }, { status: 400 })
  const step = await createStep(body)
  return NextResponse.json(step, { status: 201 })
}
```

Create `app/api/steps/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { updateStep, deleteStep } from '@/lib/scenarios/client'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const step = await updateStep(id, body)
  return NextResponse.json(step)
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await deleteStep(id)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 5: Run the route tests**

```bash
npx jest __tests__/api/features/route.test.ts --no-coverage
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add app/api/features app/api/user-stories app/api/scenarios app/api/steps __tests__/api/features/route.test.ts
git commit -m "feat: add CRUD API routes for features, user stories, scenarios, and steps"
```

---

## Task 10: Prototype & Conversation API Routes

**Files:**
- Create: `app/api/features/[id]/prototype/route.ts`
- Create: `app/api/features/[id]/conversation/route.ts`
- Create: `app/api/features/[id]/conversation/message/route.ts`
- Create: `__tests__/api/features/prototype.test.ts`
- Create: `__tests__/api/features/conversation.test.ts`

- [ ] **Step 1: Write failing tests for the prototype route**

```typescript
// __tests__/api/features/prototype.test.ts
import { POST } from '@/app/api/features/[id]/prototype/route'
import { NextRequest } from 'next/server'

jest.mock('@/lib/auth', () => ({ getSessionUser: jest.fn().mockResolvedValue({ email: 'pm@test.com' }) }))
jest.mock('@/lib/features/context', () => ({ buildFeatureContext: jest.fn().mockResolvedValue('Feature: Login') }))
jest.mock('@/lib/prototypes/storage', () => ({ ensureStepImages: jest.fn().mockImplementation((s) => Promise.resolve(s)) }))
jest.mock('@/lib/prototypes/generator', () => ({ generatePrototypeHtml: jest.fn().mockResolvedValue('<html>prototype</html>') }))
jest.mock('@/lib/prototypes/vault', () => ({ pushPrototypeToVault: jest.fn().mockResolvedValue({ vaultPath: 'prototypes/features/f-1/happy-path.html', vaultUrl: 'https://github.com/...' }) }))

const mockFrom = jest.fn()
jest.mock('@/lib/supabase/server', () => ({ getSupabaseServiceClient: jest.fn().mockResolvedValue({ from: mockFrom }) }))
jest.mock('@/lib/scenarios/client', () => ({ getScenarioSteps: jest.fn().mockResolvedValue([]) }))
jest.mock('@/lib/features/client', () => ({ getFeature: jest.fn().mockResolvedValue({ id: 'f-1', name: 'Login', status: 'draft' }) }))

describe('POST /api/features/[id]/prototype', () => {
  it('returns 201 with prototype record', async () => {
    const fakeProto = { id: 'p-1', feature_id: 'f-1', scenario_id: 'sc-1', is_current: true, html_content: '<html>prototype</html>', vault_url: 'https://github.com/...' }
    const chain = { update: jest.fn().mockReturnThis(), insert: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), single: jest.fn().mockResolvedValue({ data: fakeProto, error: null }) }
    mockFrom.mockReturnValue(chain)
    chain.update.mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) })

    const req = new NextRequest('http://localhost/api/features/f-1/prototype', {
      method: 'POST',
      body: JSON.stringify({ scenario_id: 'sc-1', scenario_title: 'Happy Path' }),
    })
    const res = await POST(req, { params: Promise.resolve({ id: 'f-1' }) })
    expect(res.status).toBe(201)
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx jest __tests__/api/features/prototype.test.ts --no-coverage
```

Expected: FAIL.

- [ ] **Step 3: Create `app/api/features/[id]/prototype/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getFeature } from '@/lib/features/client'
import { buildFeatureContext } from '@/lib/features/context'
import { ensureStepImages } from '@/lib/prototypes/storage'
import { generatePrototypeHtml } from '@/lib/prototypes/generator'
import { pushPrototypeToVault } from '@/lib/prototypes/vault'
import { getScenarioSteps } from '@/lib/scenarios/client'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id: featureId } = await params
  const { scenario_id, scenario_title } = await req.json()

  const feature = await getFeature(featureId)
  if (!feature) return NextResponse.json({ error: 'Feature not found' }, { status: 404 })

  if (scenario_id) {
    const steps = await getScenarioSteps(scenario_id)
    await ensureStepImages(steps)
  }

  const featureContext = await buildFeatureContext(featureId)
  const html = await generatePrototypeHtml(featureContext, scenario_title ?? 'All Scenarios')

  const db = await getSupabaseServiceClient()
  await db.from('feature_prototypes').update({ is_current: false })
    .eq('feature_id', featureId)
    .eq('scenario_id', scenario_id ?? null)

  const githubToken = process.env.GITHUB_TOKEN ?? ''
  const vaultResult = await pushPrototypeToVault(githubToken, featureId, feature.name, scenario_title ?? null, html)

  const { data: proto, error } = await db.from('feature_prototypes').insert({
    feature_id: featureId,
    scenario_id: scenario_id ?? null,
    is_current: true,
    html_content: html,
    vault_path: vaultResult?.vaultPath ?? null,
    vault_url: vaultResult?.vaultUrl ?? null,
    generated_by: user.email ?? '',
  }).select().single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(proto, { status: 201 })
}
```

- [ ] **Step 4: Create conversation routes**

Create `app/api/features/[id]/conversation/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getOrCreateConversation, getMessages } from '@/lib/features/conversation'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const conversation = await getOrCreateConversation(id)
  const messages = await getMessages(conversation.id)
  return NextResponse.json({ conversation, messages })
}
```

Create `app/api/features/[id]/conversation/message/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { sendFeatureMessage } from '@/lib/features/conversation'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { content } = await req.json()
  if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 })
  const result = await sendFeatureMessage(id, content)
  return NextResponse.json(result)
}
```

- [ ] **Step 5: Run tests**

```bash
npx jest __tests__/api/features/prototype.test.ts --no-coverage
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add app/api/features/[id]/prototype app/api/features/[id]/conversation __tests__/api/features/prototype.test.ts __tests__/api/features/conversation.test.ts
git commit -m "feat: add prototype generation and conversation API routes"
```

---

## Task 11: App-wide Review API

**Files:**
- Create: `lib/features/review.ts`
- Create: `app/api/features/review/route.ts`
- Create: `__tests__/lib/features/review.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// __tests__/lib/features/review.test.ts
import { runUxReview } from '@/lib/features/review'

jest.mock('@/lib/features/context', () => ({
  buildAllFeaturesContext: jest.fn().mockResolvedValue('Feature: A\n---\nFeature: B'),
}))
const mockCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () => ({
  default: jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })),
}))

describe('runUxReview', () => {
  it('returns structured findings from Claude', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify([{ type: 'overlap', title: 'Duplicate login flows', description: 'Feature A and B both describe login', featureIds: ['f-1', 'f-2'] }]) }],
    })
    const findings = await runUxReview([])
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe('overlap')
  })

  it('returns empty array if Claude response is not valid JSON', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'No issues found.' }] })
    const findings = await runUxReview([])
    expect(findings).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx jest __tests__/lib/features/review.test.ts --no-coverage
```

Expected: FAIL.

- [ ] **Step 3: Write `lib/features/review.ts`**

```typescript
// lib/features/review.ts
import Anthropic from '@anthropic-ai/sdk'
import { buildAllFeaturesContext } from '@/lib/features/context'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface ReviewFinding {
  type: 'overlap' | 'consolidation' | 'missing_edge_case' | 'contradiction'
  title: string
  description: string
  featureIds: string[]
}

const REVIEW_SYSTEM = `You are a product design reviewer analyzing a PM's feature set for UX quality issues.

You will receive a context block containing multiple features, their user stories, scenarios, and steps.

Return a JSON array of findings. Each finding must have:
- type: one of "overlap" | "consolidation" | "missing_edge_case" | "contradiction"
- title: short summary (under 10 words)
- description: 1-2 sentences explaining the issue
- featureIds: array of feature IDs involved

Focus strictly on UX/product-level issues:
- "overlap": two features describe the same user journey
- "consolidation": user stories that could be merged without losing specificity
- "missing_edge_case": a scenario has no error or failure path
- "contradiction": same entry point or trigger leads to different outcomes across features

Output ONLY the JSON array. No explanation, no markdown fences.`

export async function runUxReview(featureIds: string[]): Promise<ReviewFinding[]> {
  const context = await buildAllFeaturesContext(featureIds.length ? featureIds : undefined)
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: REVIEW_SYSTEM,
    messages: [{ role: 'user', content: context }],
  })
  const block = response.content.find((b) => b.type === 'text')
  if (!block || block.type !== 'text') return []
  try {
    return JSON.parse(block.text) as ReviewFinding[]
  } catch {
    return []
  }
}
```

- [ ] **Step 4: Create `app/api/features/review/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { runUxReview } from '@/lib/features/review'
import { getSessionUser } from '@/lib/auth'

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { feature_ids } = await req.json()
  const findings = await runUxReview(feature_ids ?? [])
  return NextResponse.json(findings)
}
```

- [ ] **Step 5: Run tests**

```bash
npx jest __tests__/lib/features/review.test.ts --no-coverage
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/features/review.ts app/api/features/review __tests__/lib/features/review.test.ts
git commit -m "feat: add app-wide UX review API"
```

---

## Task 12: Task Panel Features Tab

**Files:**
- Create: `components/FeaturesTab.tsx`
- Modify: `app/sprint/page.tsx` — add Features tab

- [ ] **Step 1: Create `components/FeaturesTab.tsx`**

```tsx
// components/FeaturesTab.tsx
'use client'
import { useEffect, useState } from 'react'
import { Button, List, Tag, Input, Spin, Typography, Space } from 'antd'
import { apiFetch } from '@/lib/fetch'
import Link from 'next/link'

interface Feature {
  id: string
  name: string
  status: 'draft' | 'active' | 'archived'
  storyCount?: number
  hasPrototype?: boolean
}

interface Props { taskId: string }

export function FeaturesTab({ taskId }: Props) {
  const [features, setFeatures] = useState<Feature[]>([])
  const [loading, setLoading] = useState(true)
  const [linking, setLinking] = useState(false)
  const [newName, setNewName] = useState('')
  const [searchResults, setSearchResults] = useState<Feature[]>([])
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    apiFetch<Feature[]>(`/api/tasks/${taskId}/features`)
      .then((data) => { if (data) setFeatures(data) })
      .finally(() => setLoading(false))
  }, [taskId])

  async function createAndLink() {
    if (!newName.trim()) return
    setLinking(true)
    const feature = await apiFetch<Feature>('/api/features', { method: 'POST', body: JSON.stringify({ name: newName }) })
    if (feature) {
      await apiFetch(`/api/features/${feature.id}/tasks`, { method: 'POST', body: JSON.stringify({ task_id: taskId }) })
      setFeatures((prev) => [...prev, feature])
      setNewName('')
    }
    setLinking(false)
  }

  async function linkExisting(featureId: string) {
    await apiFetch(`/api/features/${featureId}/tasks`, { method: 'POST', body: JSON.stringify({ task_id: taskId }) })
    const linked = searchResults.find((f) => f.id === featureId)
    if (linked) setFeatures((prev) => [...prev, linked])
    setSearchResults([])
    setSearchQuery('')
  }

  async function onSearch(q: string) {
    setSearchQuery(q)
    if (!q.trim()) { setSearchResults([]); return }
    const results = await apiFetch<Feature[]>(`/api/features?q=${encodeURIComponent(q)}`)
    setSearchResults(results ?? [])
  }

  if (loading) return <Spin />

  return (
    <div style={{ padding: 8 }}>
      <List
        dataSource={features}
        locale={{ emptyText: 'No features linked yet' }}
        renderItem={(f) => (
          <List.Item>
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              <Space>
                <Typography.Text strong>{f.name}</Typography.Text>
                <Tag color={f.status === 'active' ? 'blue' : 'default'}>{f.status}</Tag>
                {f.hasPrototype && <Tag color="green">Prototype ready</Tag>}
              </Space>
              <Link href={`/features/${f.id}`}>
                <Typography.Link>Open Feature Editor →</Typography.Link>
              </Link>
            </Space>
          </List.Item>
        )}
      />
      <div style={{ marginTop: 12 }}>
        <Input.Search
          placeholder="Link existing feature..."
          value={searchQuery}
          onChange={(e) => onSearch(e.target.value)}
          style={{ marginBottom: 6 }}
        />
        {searchResults.length > 0 && (
          <List
            bordered
            size="small"
            dataSource={searchResults}
            renderItem={(f) => (
              <List.Item>
                <Button type="link" size="small" onClick={() => linkExisting(f.id)}>{f.name}</Button>
              </List.Item>
            )}
          />
        )}
        <Space.Compact style={{ width: '100%', marginTop: 6 }}>
          <Input placeholder="New feature name..." value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Button loading={linking} onClick={createAndLink}>+ New</Button>
        </Space.Compact>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add a task features route**

Create `app/api/tasks/[id]/features/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getTaskFeatures } from '@/lib/features/client'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const features = await getTaskFeatures(id)
  return NextResponse.json(features)
}
```

- [ ] **Step 3: Add the Features tab to `app/sprint/page.tsx`**

Find the existing tab definitions in `app/sprint/page.tsx` (look for the `<Tabs>` component or tab items array) and add a Features tab. The exact location depends on current markup — search for `Assess` or `Bundle` in the tabs list and add:

```tsx
// Add this import at the top of app/sprint/page.tsx
import { FeaturesTab } from '@/components/FeaturesTab'

// Add this tab item alongside the existing Assess/Bundle/Checklist tabs:
{
  key: 'features',
  label: 'Features',
  children: selectedTask ? <FeaturesTab taskId={selectedTask.id} /> : null,
}
```

- [ ] **Step 4: Start dev server and verify the Features tab appears**

```bash
npm run dev
```

Open http://localhost:3000/sprint, click a task to open the detail panel, confirm a "Features" tab appears alongside Assess/Bundle/Checklist.

- [ ] **Step 5: Commit**

```bash
git add components/FeaturesTab.tsx app/api/tasks/[id]/features app/sprint/page.tsx
git commit -m "feat: add Features tab to task detail panel"
```

---

## Task 13: Full-Page Feature Editor

**Files:**
- Create: `app/features/[id]/page.tsx`
- Create: `app/features/[id]/components/UserStoriesPanel.tsx`
- Create: `app/features/[id]/components/ScenariosPanel.tsx`
- Create: `app/features/[id]/components/StepRow.tsx`
- Create: `app/features/[id]/components/ClaudePanel.tsx`

- [ ] **Step 1: Create the page shell `app/features/[id]/page.tsx`**

```tsx
// app/features/[id]/page.tsx
'use client'
import { useEffect, useState } from 'react'
import { Layout, Typography, Spin, Tag, Select, Button, Space } from 'antd'
import { useParams, useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/fetch'
import { UserStoriesPanel } from './components/UserStoriesPanel'
import { ScenariosPanel } from './components/ScenariosPanel'
import { ClaudePanel } from './components/ClaudePanel'

const { Header, Sider, Content } = Layout

export interface Step {
  id: string; scenario_id: string; title: string; description: string | null
  figma_url: string | null; figma_frame_id: string | null; figma_thumbnail_url: string | null; display_order: number
}
export interface Scenario { id: string; user_story_id: string; title: string; description: string | null; display_order: number; steps: Step[] }
export interface UserStory { id: string; title: string; as_a: string; i_want: string; so_that: string; scenarios: Scenario[]; featureCount: number }
export interface Feature { id: string; name: string; description: string | null; status: string; stories: UserStory[] }

export default function FeatureEditorPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [feature, setFeature] = useState<Feature | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeStoryId, setActiveStoryId] = useState<string | null>(null)

  async function reload() {
    const data = await apiFetch<Feature>(`/api/features/${id}`)
    if (data) {
      setFeature(data)
      if (!activeStoryId && data.stories.length > 0) setActiveStoryId(data.stories[0].id)
    }
    setLoading(false)
  }

  useEffect(() => { reload() }, [id])

  if (loading) return <div style={{ padding: 32 }}><Spin size="large" /></div>
  if (!feature) return <div style={{ padding: 32 }}>Feature not found.</div>

  const activeStory = feature.stories.find((s) => s.id === activeStoryId) ?? null

  async function updateStatus(status: string) {
    await apiFetch(`/api/features/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) })
    reload()
  }

  return (
    <Layout style={{ height: '100vh' }}>
      <Header style={{ background: '#141414', borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', gap: 16, padding: '0 20px' }}>
        <Button type="text" onClick={() => router.back()}>← Back</Button>
        <Typography.Title level={5} style={{ margin: 0, color: '#fff' }}>{feature.name}</Typography.Title>
        <Select value={feature.status} onChange={updateStatus} style={{ marginLeft: 'auto' }} size="small"
          options={[{ value: 'draft', label: 'draft' }, { value: 'active', label: 'active' }, { value: 'archived', label: 'archived' }]} />
      </Header>
      <Layout>
        <Sider width={240} style={{ background: '#1a1a1a', borderRight: '1px solid #333', overflow: 'auto' }}>
          <UserStoriesPanel featureId={id} stories={feature.stories} activeStoryId={activeStoryId} onSelect={setActiveStoryId} onUpdate={reload} />
        </Sider>
        <Content style={{ overflow: 'auto', background: '#141414' }}>
          <ScenariosPanel featureId={id} featureName={feature.name} story={activeStory} onUpdate={reload} />
        </Content>
        <Sider width={320} style={{ background: '#1a1a1a', borderLeft: '1px solid #333', display: 'flex', flexDirection: 'column' }}>
          <ClaudePanel featureId={id} onSyncStep={(title, description) => {
            if (!activeStory?.scenarios[0]) return
            apiFetch('/api/steps', { method: 'POST', body: JSON.stringify({ scenario_id: activeStory.scenarios[0].id, title, description }) }).then(reload)
          }} />
        </Sider>
      </Layout>
    </Layout>
  )
}
```

- [ ] **Step 2: Create `UserStoriesPanel.tsx`**

```tsx
// app/features/[id]/components/UserStoriesPanel.tsx
'use client'
import { useState } from 'react'
import { Button, Form, Input, List, Typography, Space, Tooltip, Badge } from 'antd'
import { apiFetch } from '@/lib/fetch'
import type { UserStory } from '../page'

interface Props {
  featureId: string; stories: UserStory[]; activeStoryId: string | null
  onSelect: (id: string) => void; onUpdate: () => void
}

export function UserStoriesPanel({ featureId, stories, activeStoryId, onSelect, onUpdate }: Props) {
  const [adding, setAdding] = useState(false)
  const [form] = Form.useForm()

  async function addStory(values: { title: string; as_a: string; i_want: string; so_that: string }) {
    await apiFetch(`/api/features/${featureId}/stories`, {
      method: 'POST',
      body: JSON.stringify(values),
    })
    form.resetFields()
    setAdding(false)
    onUpdate()
  }

  async function forkStory(storyId: string) {
    await apiFetch(`/api/user-stories/${storyId}/fork`, {
      method: 'POST',
      body: JSON.stringify({ target_feature_id: featureId }),
    })
    onUpdate()
  }

  return (
    <div style={{ padding: 12 }}>
      <Typography.Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>User Stories</Typography.Text>
      <List
        style={{ marginTop: 8 }}
        dataSource={stories}
        renderItem={(story) => {
          const isActive = story.id === activeStoryId
          const isShared = story.featureCount > 1
          return (
            <List.Item
              style={{ cursor: 'pointer', background: isActive ? '#2a2050' : 'transparent', borderRadius: 4, padding: '8px', border: isActive ? '1px solid #7c6af7' : '1px solid transparent', marginBottom: 4 }}
              onClick={() => onSelect(story.id)}
            >
              <Space direction="vertical" size={2}>
                <Space>
                  <Typography.Text strong style={{ fontSize: 12 }}>{story.title || `As a ${story.as_a}`}</Typography.Text>
                  {isShared && (
                    <Tooltip title={`Shared across ${story.featureCount} features. Fork to edit independently.`}>
                      <Badge count={story.featureCount} style={{ backgroundColor: '#555' }} />
                    </Tooltip>
                  )}
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>{story.scenarios.length} scenario{story.scenarios.length !== 1 ? 's' : ''}</Typography.Text>
                {isShared && isActive && (
                  <Button size="small" type="dashed" onClick={(e) => { e.stopPropagation(); forkStory(story.id) }}>Fork to edit</Button>
                )}
              </Space>
            </List.Item>
          )
        }}
      />
      {adding ? (
        <Form form={form} layout="vertical" onFinish={addStory} style={{ marginTop: 8 }}>
          <Form.Item name="title" label="Title" rules={[{ required: true }]}><Input placeholder="Short label" /></Form.Item>
          <Form.Item name="as_a" label="As a..." rules={[{ required: true }]}><Input placeholder="PM, end user..." /></Form.Item>
          <Form.Item name="i_want" label="I want..." rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="so_that" label="So that..." rules={[{ required: true }]}><Input /></Form.Item>
          <Space>
            <Button htmlType="submit" type="primary" size="small">Add</Button>
            <Button size="small" onClick={() => setAdding(false)}>Cancel</Button>
          </Space>
        </Form>
      ) : (
        <Button block type="dashed" size="small" style={{ marginTop: 8 }} onClick={() => setAdding(true)}>+ Add story</Button>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Create `StepRow.tsx`**

```tsx
// app/features/[id]/components/StepRow.tsx
'use client'
import { useState } from 'react'
import { Input, Typography, Space, Button, Image, Tooltip } from 'antd'
import { DeleteOutlined, DragOutlined } from '@ant-design/icons'
import { apiFetch } from '@/lib/fetch'
import { parseFigmaUrl } from '@/lib/figma/client'
import type { Step } from '../page'

interface Props { step: Step; index: number; onUpdate: () => void; onDelete: () => void }

export function StepRow({ step, index, onUpdate, onDelete }: Props) {
  const [figmaUrl, setFigmaUrl] = useState(step.figma_url ?? '')
  const [fetching, setFetching] = useState(false)

  async function onFigmaUrlChange(url: string) {
    setFigmaUrl(url)
    const parsed = parseFigmaUrl(url)
    if (!parsed) return
    setFetching(true)
    await apiFetch(`/api/steps/${step.id}`, { method: 'PATCH', body: JSON.stringify({ figma_url: url }) })
    const res = await apiFetch<Step>(`/api/steps/${step.id}/thumbnail`, { method: 'POST' })
    if (res) onUpdate()
    setFetching(false)
  }

  async function onDescriptionBlur(description: string) {
    await apiFetch(`/api/steps/${step.id}`, { method: 'PATCH', body: JSON.stringify({ description }) })
  }

  async function onTitleBlur(title: string) {
    await apiFetch(`/api/steps/${step.id}`, { method: 'PATCH', body: JSON.stringify({ title }) })
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 0' }}>
      <DragOutlined style={{ color: '#555', cursor: 'grab', marginTop: 8 }} />
      <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#7c6af7', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0, marginTop: 4 }}>
        {index + 1}
      </div>
      <Space direction="vertical" size={4} style={{ flex: 1 }}>
        <Input defaultValue={step.title} placeholder="Step title" onBlur={(e) => onTitleBlur(e.target.value)} />
        <Input.TextArea defaultValue={step.description ?? ''} placeholder='Narration (e.g. "Clicking Save goes to step 3")' autoSize={{ minRows: 1, maxRows: 4 }} onBlur={(e) => onDescriptionBlur(e.target.value)} />
        <Space>
          <Input value={figmaUrl} onChange={(e) => setFigmaUrl(e.target.value)} onBlur={(e) => onFigmaUrlChange(e.target.value)} placeholder="Paste Figma URL..." style={{ width: 260 }} />
          {step.figma_url && <Typography.Link href={step.figma_url} target="_blank" style={{ fontSize: 11 }}>View in Figma ↗</Typography.Link>}
        </Space>
        {fetching && <Typography.Text type="secondary" style={{ fontSize: 11 }}>Fetching thumbnail...</Typography.Text>}
        {step.figma_thumbnail_url && !fetching && <Image src={step.figma_thumbnail_url} width={120} preview={false} style={{ borderRadius: 4 }} />}
      </Space>
      <Tooltip title="Delete step">
        <Button type="text" icon={<DeleteOutlined />} danger size="small" onClick={onDelete} />
      </Tooltip>
    </div>
  )
}
```

- [ ] **Step 4: Create `ScenariosPanel.tsx`**

```tsx
// app/features/[id]/components/ScenariosPanel.tsx
'use client'
import { useState } from 'react'
import { Tabs, Button, Space, Typography, Divider, Spin } from 'antd'
import { apiFetch } from '@/lib/fetch'
import { StepRow } from './StepRow'
import type { UserStory, Scenario } from '../page'

interface Props { featureId: string; featureName: string; story: UserStory | null; onUpdate: () => void }

export function ScenariosPanel({ featureId, featureName, story, onUpdate }: Props) {
  const [generating, setGenerating] = useState<string | null>(null)

  if (!story) return <div style={{ padding: 32, color: '#555' }}>Select a user story to view scenarios.</div>

  async function addStep(scenarioId: string) {
    await apiFetch('/api/steps', { method: 'POST', body: JSON.stringify({ scenario_id: scenarioId, title: 'New step' }) })
    onUpdate()
  }

  async function deleteStep(stepId: string) {
    await apiFetch(`/api/steps/${stepId}`, { method: 'DELETE' })
    onUpdate()
  }

  async function addScenario() {
    await apiFetch('/api/scenarios', { method: 'POST', body: JSON.stringify({ user_story_id: story.id, title: 'New scenario', display_order: story.scenarios.length }) })
    onUpdate()
  }

  async function generatePrototype(scenario: Scenario) {
    setGenerating(scenario.id)
    await apiFetch(`/api/features/${featureId}/prototype`, {
      method: 'POST',
      body: JSON.stringify({ scenario_id: scenario.id, scenario_title: scenario.title }),
    })
    setGenerating(null)
    onUpdate()
  }

  async function generateAll() {
    setGenerating('all')
    await apiFetch(`/api/features/${featureId}/prototype`, {
      method: 'POST',
      body: JSON.stringify({ scenario_title: null }),
    })
    setGenerating(null)
    onUpdate()
  }

  const tabItems = story.scenarios.map((scenario) => ({
    key: scenario.id,
    label: scenario.title,
    children: (
      <div style={{ padding: '12px 20px' }}>
        <Divider style={{ margin: '8px 0 16px' }} />
        {scenario.steps.map((step, i) => (
          <StepRow key={step.id} step={step} index={i} onUpdate={onUpdate} onDelete={() => deleteStep(step.id)} />
        ))}
        <Space style={{ marginTop: 12 }}>
          <Button size="small" type="dashed" onClick={() => addStep(scenario.id)}>+ Add step</Button>
          <Button size="small" type="primary" loading={generating === scenario.id} onClick={() => generatePrototype(scenario)}>
            Generate Prototype
          </Button>
        </Space>
      </div>
    ),
  }))

  return (
    <div style={{ padding: '12px 20px' }}>
      <Space style={{ marginBottom: 8, width: '100%', justifyContent: 'space-between' }}>
        <Typography.Text strong>{`As a ${story.as_a}, I want ${story.i_want}`}</Typography.Text>
        <Space>
          <Button size="small" loading={generating === 'all'} onClick={generateAll}>Generate All</Button>
          <Button size="small" type="dashed" onClick={addScenario}>+ Add scenario</Button>
        </Space>
      </Space>
      {story.scenarios.length === 0
        ? <div style={{ color: '#555', padding: 16 }}>No scenarios yet. Add one above.</div>
        : <Tabs items={tabItems} />}
    </div>
  )
}
```

- [ ] **Step 5: Create `ClaudePanel.tsx`**

```tsx
// app/features/[id]/components/ClaudePanel.tsx
'use client'
import { useEffect, useRef, useState } from 'react'
import { Input, Button, Space, Typography, Spin, Alert } from 'antd'
import { apiFetch } from '@/lib/fetch'

interface Message { role: 'user' | 'assistant'; content: string; suggestedStep?: { title: string; description: string } | null }
interface Props { featureId: string; onSyncStep: (title: string, description: string) => void }

export function ClaudePanel({ featureId, onSyncStep }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [reviewFindings, setReviewFindings] = useState<Array<{ type: string; title: string; description: string }> | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    apiFetch<{ messages: Array<{ role: 'user' | 'assistant'; content: string }> }>(`/api/features/${featureId}/conversation`)
      .then((data) => { if (data?.messages) setMessages(data.messages) })
  }, [featureId])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function send() {
    if (!input.trim()) return
    const userMsg: Message = { role: 'user', content: input }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setSending(true)
    const res = await apiFetch<{ content: string; suggestedStep: { title: string; description: string } | null }>(
      `/api/features/${featureId}/conversation/message`,
      { method: 'POST', body: JSON.stringify({ content: input }) }
    )
    if (res) setMessages((prev) => [...prev, { role: 'assistant', content: res.content, suggestedStep: res.suggestedStep }])
    setSending(false)
  }

  async function runReview() {
    setReviewing(true)
    const findings = await apiFetch<Array<{ type: string; title: string; description: string }>>('/api/features/review', {
      method: 'POST',
      body: JSON.stringify({ feature_ids: [featureId] }),
    })
    setReviewFindings(findings ?? [])
    setReviewing(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography.Text strong>Claude</Typography.Text>
        <Button size="small" loading={reviewing} onClick={runReview}>App-wide Review</Button>
      </div>
      {reviewFindings && (
        <div style={{ padding: 8, borderBottom: '1px solid #333' }}>
          {reviewFindings.length === 0
            ? <Alert message="No UX issues found" type="success" showIcon />
            : reviewFindings.map((f, i) => (
              <Alert key={i} type={f.type === 'contradiction' ? 'error' : 'warning'} message={f.title} description={f.description} showIcon closable style={{ marginBottom: 6 }} />
            ))}
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '90%' }}>
            <div style={{ background: m.role === 'user' ? '#1f2a1f' : '#2a2050', borderRadius: 6, padding: '6px 10px', fontSize: 12, color: '#ccc', whiteSpace: 'pre-wrap' }}>
              {m.content}
            </div>
            {m.suggestedStep && (
              <Button size="small" type="dashed" style={{ marginTop: 4, fontSize: 11 }} onClick={() => onSyncStep(m.suggestedStep!.title, m.suggestedStep!.description)}>
                + Sync to Steps: "{m.suggestedStep.title}"
              </Button>
            )}
          </div>
        ))}
        {sending && <Spin size="small" style={{ alignSelf: 'flex-start' }} />}
        <div ref={bottomRef} />
      </div>
      <div style={{ padding: 8, borderTop: '1px solid #333' }}>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPressEnter={send}
            placeholder="Message Claude..."
            disabled={sending}
          />
          <Button type="primary" onClick={send} loading={sending}>→</Button>
        </Space.Compact>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Add thumbnail fetch route**

Create `app/api/steps/[id]/thumbnail/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { fetchFigmaFrames, parseFigmaUrl } from '@/lib/figma/client'
import { ensureStepImages } from '@/lib/prototypes/storage'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = await getSupabaseServiceClient()
  const { data: step } = await db.from('steps').select().eq('id', id).single()
  if (!step?.figma_url) return NextResponse.json({ error: 'No figma_url' }, { status: 400 })

  const parsed = parseFigmaUrl(step.figma_url)
  if (!parsed) return NextResponse.json({ error: 'Invalid figma_url' }, { status: 400 })

  const token = process.env.FIGMA_ACCESS_TOKEN ?? ''
  const { frames } = await fetchFigmaFrames(token, parsed.fileKey, parsed.nodeId)
  if (frames.length === 0) return NextResponse.json({ error: 'No frames found' }, { status: 404 })

  const frame = frames[0]
  await db.from('steps').update({ figma_thumbnail_url: frame.thumbnailUrl }).eq('id', id)
  const updated = await ensureStepImages([{ id, figma_thumbnail_url: frame.thumbnailUrl, figma_url: step.figma_url }])
  return NextResponse.json({ figma_thumbnail_url: updated[0].figma_thumbnail_url })
}
```

- [ ] **Step 7: Start dev server and verify the feature editor**

```bash
npm run dev
```

Navigate to `/features/[any-feature-id]` from the task panel. Verify:
- Three-panel layout renders
- User stories panel shows stories and the "Fork to edit" warning for shared stories
- Steps panel shows steps with Figma URL input and thumbnail preview
- Claude panel shows message history

- [ ] **Step 8: Commit**

```bash
git add app/features app/api/steps/[id]/thumbnail
git commit -m "feat: add full-page feature editor (user stories, scenarios, steps, Claude chat)"
```

---

## Task 14: Run Full Test Suite & Verify

- [ ] **Step 1: Run all tests**

```bash
npx jest --no-coverage
```

Expected: all passing. Fix any failures before proceeding.

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: address type errors and test failures from integration"
```

---

## Known Simplifications (v1)

**Step drag-and-drop reordering:** `StepRow` renders a `<DragOutlined>` handle visually but no DnD library is wired up. In v1, `display_order` is set at creation time and steps can be reordered by deleting and re-adding. Full drag-and-drop with optimistic UI (react-dnd or @dnd-kit) is a v2 improvement.

**App-wide Review scope selector:** The spec describes a scope selector (filter by status, linked task list, name search). In v1, the "App-wide Review" button in `ClaudePanel` sends only the current feature's ID. A full scope selector UI with multi-feature selection is a v2 improvement. The API already accepts `feature_ids: string[]` so the backend is ready.

**Export Summary for App-wide Review:** The spec says the review panel should have an "Export Summary" button that pushes undismissed findings to the vault as `reviews/[date]-ux-review.md`. In v1, findings are in-app only. Add this in v2 by calling `writeVaultFile` with a markdown-formatted findings list.

---

## Done

After Task 14 passes, the Feature Prototype Builder is fully implemented:

- ✅ 8 new Supabase tables with correct relationships
- ✅ Figma images permanently stored in Supabase Storage at generation time
- ✅ Prototype HTML generated by Claude with hotspots and "View in Figma" links
- ✅ Prototypes versioned (`is_current`) and pushed to vault
- ✅ Shared user story fork/warning in UI
- ✅ App-wide UX review with scoped findings
- ✅ Features tab in existing task detail panel
- ✅ Full-page 3-panel editor: stories · scenarios/steps · Claude chat
- ✅ "Sync to Steps" for Claude-suggested steps

# PM App Experiment Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken webhook handler, update the trigger config UI, and build the full experiment loop — sprint feedback collection, bundle prompt versioning, and VIDF git hook with CI enforcement.

**Architecture:** Six sequential workstreams, each shipping as an independent PR. Workstream 1 (webhook fix + seed) deploys atomically — the seed script must run before the updated webhook goes live. Workstreams 3–5 build the experiment loop on top of two new DB tables. Workstreams 6–7 are standalone scripts/CI with no Next.js dependencies.

**Tech Stack:** Next.js App Router, Supabase (postgres + JS client), Jest + ts-jest, Node `crypto` (HMAC tokens), Ant Design, shell scripts, GitHub Actions

---

## File Map

### Workstream 1: Webhook Fix + Seed
- Modify: `supabase/migrations/014_trigger_configs_list_routing.sql` *(new)*
- Modify: `app/api/webhooks/clickup/route.ts`
- Create: `scripts/seed-trigger-configs.ts`
- Modify: `__tests__/api/webhooks/clickup.test.ts`

### Workstream 2: Trigger Config UI
- Modify: `app/triggers/config/page.tsx`
- Modify: `components/TriggerConfigTable.tsx`
- Modify: `__tests__/components/TriggerConfigTable.test.tsx` *(new)*

### Workstream 3: DB Migrations (experiment loop tables)
- Create: `supabase/migrations/016_bundle_feedback.sql`
- Create: `supabase/migrations/017_bundle_prompt_versions.sql`

### Workstream 4: Sprint Feedback UI
- Create: `lib/feedback/token.ts`
- Create: `app/feedback/page.tsx`
- Create: `components/FeedbackForm.tsx`
- Create: `app/api/feedback/bundle/route.ts`
- Create: `__tests__/lib/feedback/token.test.ts`
- Create: `__tests__/api/feedback/bundle.test.ts`

### Workstream 5: Bundle Prompt Versioning
- Create: `app/experiments/prompt-versions/page.tsx`
- Create: `components/FeedbackSummaryPanel.tsx`
- Create: `components/ProposedPromptPanel.tsx`
- Create: `app/api/experiments/propose-prompt/route.ts`
- Create: `app/api/experiments/approve-prompt/route.ts`
- Create: `app/api/experiments/reject-prompt/route.ts`

### Workstream 6: Developer Experiment API
- Create: `app/api/developers/[email]/experiment/route.ts`
- Create: `__tests__/api/developers/experiment.test.ts`

### Workstream 7: VIDF Git Hook + GitHub Action
- Create: `scripts/vidf-hook/commit-msg`
- Create: `scripts/vidf-hook/install-git-hook.sh`
- Create: `.github/workflows/vidf-validate.yml`

---

## Task 1: Migration 014 — Add destination_list_id to trigger_configs

**Files:**
- Create: `supabase/migrations/014_trigger_configs_list_routing.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- supabase/migrations/014_trigger_configs_list_routing.sql

ALTER TABLE trigger_configs
  ADD COLUMN IF NOT EXISTS destination_list_id UUID REFERENCES lists(id);

ALTER TABLE trigger_configs
  ALTER COLUMN to_status DROP NOT NULL;

-- Unique: each destination list has at most one list-based trigger config
CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_configs_destination_list_unique
  ON trigger_configs(destination_list_id)
  WHERE destination_list_id IS NOT NULL;
```

- [ ] **Step 2: Apply the migration to your Supabase project**

In the Supabase dashboard → SQL Editor, paste and run the migration. Then regenerate TypeScript types:

```bash
npx supabase gen types typescript --project-id <YOUR_PROJECT_ID> > lib/supabase/types.ts
```

(Project ID is in Supabase dashboard → Settings → General → Reference ID.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/014_trigger_configs_list_routing.sql lib/supabase/types.ts
git commit -m "feat(db): add destination_list_id to trigger_configs for list-based routing"
```

---

## Task 2: Webhook Handler — Route taskMoved by Destination List

**Files:**
- Modify: `app/api/webhooks/clickup/route.ts`
- Modify: `__tests__/api/webhooks/clickup.test.ts`

- [ ] **Step 1: Add failing tests for taskMoved list-based routing**

Add these test cases to `__tests__/api/webhooks/clickup.test.ts` (after the existing tests):

```typescript
// Add these env vars at the top of the file alongside existing ones:
process.env.CLICKUP_ACTIVE_LIST_ID = 'list-active'
process.env.CLICKUP_PLANNING_LIST_ID = 'list-planning'

// Add these test cases inside the describe block:

it('taskMoved: updates task list_id and enqueues trigger when destination list is subscribed', async () => {
  const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')

  const insertTriggerQueue = jest.fn().mockResolvedValue({ data: null, error: null })

  const supabaseMock = {
    from: jest.fn().mockImplementation((table: string) => {
      const base = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        insert: jest.fn().mockResolvedValue({ data: null, error: null }),
        single: jest.fn().mockResolvedValue({ data: null }),
        not: jest.fn().mockReturnThis(),
      }
      if (table === 'lists') {
        return { ...base, single: jest.fn().mockResolvedValue({ data: { id: 'db-list-active' } }) }
      }
      if (table === 'tasks') {
        return { ...base, single: jest.fn().mockResolvedValue({ data: { id: 'db-task-1', list_id: 'db-list-planning', status: 'in_progress' } }) }
      }
      if (table === 'trigger_configs') {
        return { ...base, single: jest.fn().mockResolvedValue({ data: null }), ...{ data: [{ id: 'cfg-1' }] } }
      }
      if (table === 'trigger_queue') {
        return { ...base, insert: insertTriggerQueue }
      }
      return base
    }),
  }

  // trigger_configs returns array (not single)
  supabaseMock.from.mockImplementation((table: string) => {
    const chain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null }),
      insert: jest.fn().mockResolvedValue({ data: null, error: null }),
    }
    if (table === 'lists') {
      return { ...chain, single: jest.fn().mockResolvedValue({ data: { id: 'db-list-active' } }) }
    }
    if (table === 'tasks') {
      return { ...chain, single: jest.fn().mockResolvedValue({ data: { id: 'db-task-1', list_id: 'db-list-planning', status: 'in_progress' } }) }
    }
    if (table === 'trigger_configs') {
      // .select().eq() returns a promise resolving to { data: [...] }
      const eqFn = jest.fn().mockResolvedValue({ data: [{ id: 'cfg-1' }] })
      return { ...chain, eq: eqFn }
    }
    if (table === 'trigger_queue') {
      return { ...chain, insert: insertTriggerQueue }
    }
    if (table === 'slack_issues') {
      return { ...chain, single: jest.fn().mockResolvedValue({ data: null }) }
    }
    return chain
  })

  getSupabaseServiceClient.mockResolvedValue(supabaseMock)

  const req = makeRequest({
    event: 'taskMoved',
    task_id: 'cu-task-1',
    history_items: [{ field: 'section_moved', after: { list: { id: 'list-active' } } }],
  })
  const res = await POST(req)
  expect(res.status).toBe(200)
  expect(insertTriggerQueue).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ task_id: 'db-task-1', config_id: 'cfg-1', status: 'pending' })])
  )
})

it('taskMoved: acks silently when destination list is not subscribed', async () => {
  const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')

  supabaseMock_notSubscribed: {
    const chain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null }),
      insert: jest.fn().mockResolvedValue({ data: null }),
      update: jest.fn().mockReturnThis(),
    }
    const mock = { from: jest.fn().mockReturnValue(chain) }
    getSupabaseServiceClient.mockResolvedValue(mock)
  }

  const req = makeRequest({
    event: 'taskMoved',
    task_id: 'cu-task-99',
    history_items: [{ field: 'section_moved', after: { list: { id: 'list-unknown' } } }],
  })
  const res = await POST(req)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.ok).toBe(true)
})

it('taskMoved: preserves existing task status when updating list_id', async () => {
  const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')
  const updateFn = jest.fn().mockReturnThis()
  const eqAfterUpdate = jest.fn().mockResolvedValue({ data: null })

  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    insert: jest.fn().mockResolvedValue({ data: null }),
    update: updateFn,
    single: jest.fn().mockResolvedValue({ data: null }),
  }
  updateFn.mockReturnValue({ eq: eqAfterUpdate })

  const supabaseMock = {
    from: jest.fn().mockImplementation((table: string) => {
      if (table === 'lists') return { ...chain, single: jest.fn().mockResolvedValue({ data: { id: 'db-list-active' } }) }
      if (table === 'tasks') return { ...chain, single: jest.fn().mockResolvedValue({ data: { id: 'db-task-1', list_id: 'db-list-planning', status: 'Architecting' } }) }
      if (table === 'trigger_configs') return { ...chain, eq: jest.fn().mockResolvedValue({ data: [] }) }
      if (table === 'slack_issues') return { ...chain, single: jest.fn().mockResolvedValue({ data: null }) }
      return chain
    }),
  }
  getSupabaseServiceClient.mockResolvedValue(supabaseMock)

  const req = makeRequest({
    event: 'taskMoved',
    task_id: 'cu-task-1',
    history_items: [{ field: 'section_moved', after: { list: { id: 'list-active' } } }],
  })
  await POST(req)

  // update should only set list_id + synced_at — NOT status
  expect(updateFn).toHaveBeenCalledWith(
    expect.not.objectContaining({ status: expect.anything() })
  )
  expect(updateFn).toHaveBeenCalledWith(
    expect.objectContaining({ list_id: 'db-list-active' })
  )
})
```

- [ ] **Step 2: Run the new tests to confirm they fail**

```bash
npx jest __tests__/api/webhooks/clickup.test.ts --no-coverage -t "taskMoved"
```

Expected: FAIL (new test cases reference behavior not yet implemented)

- [ ] **Step 3: Replace the webhook route handler**

Replace the entire contents of `app/api/webhooks/clickup/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { verifyClickUpSignature, parseWebhookEvent } from '@/lib/clickup/webhook'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildClickUpClient } from '@/lib/clickup/client'
import type { Json } from '@/lib/supabase/types'

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const signature = req.headers.get('x-signature') ?? ''

  if (!verifyClickUpSignature(rawBody, signature, process.env.CLICKUP_WEBHOOK_SECRET!)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const payload = JSON.parse(rawBody) as Record<string, unknown>
  const event = parseWebhookEvent(payload)
  if (!event) return NextResponse.json({ ok: true })

  const supabase = await getSupabaseServiceClient()

  if (event.type === 'taskMoved') {
    if (!event.listId) return NextResponse.json({ ok: true })

    // Resolve destination list by ClickUp list ID
    const { data: destList } = await supabase
      .from('lists')
      .select('id')
      .eq('clickup_list_id', event.listId)
      .single()

    if (!destList) {
      await handleSlackHandoff(event.taskId, event.type, event.listId, supabase)
      return NextResponse.json({ ok: true })
    }

    // Find or auto-import the task
    let { data: task } = await supabase
      .from('tasks')
      .select('id, list_id, status')
      .eq('clickup_task_id', event.taskId)
      .single()

    if (!task) {
      const { data: token } = await supabase
        .from('oauth_tokens').select('access_token').eq('provider', 'clickup').limit(1).single()
      if (token) {
        try {
          const cuTask = await buildClickUpClient(token.access_token).getTask(event.taskId)
          const { data: inserted } = await supabase.from('tasks').insert({
            clickup_task_id: cuTask.id,
            list_id: destList.id,
            name: cuTask.name,
            custom_fields: (cuTask.custom_fields ?? []) as unknown as Json,
            synced_at: new Date().toISOString(),
          }).select('id, list_id, status').single()
          task = inserted
        } catch (err) {
          console.warn('[webhook] auto-import failed for task', event.taskId, err)
        }
      }
      if (!task) return NextResponse.json({ ok: true })
    }

    // Update list_id only — preserve status
    await supabase.from('tasks')
      .update({ list_id: destList.id, synced_at: new Date().toISOString() })
      .eq('id', task.id)

    // Find trigger configs for this destination list
    const { data: configs } = await supabase
      .from('trigger_configs')
      .select('*')
      .eq('destination_list_id', destList.id)

    if (configs?.length) {
      await supabase.from('trigger_queue').insert(
        configs.map((config) => ({ task_id: task!.id, config_id: config.id, status: 'pending' as const }))
      )
    }

    await handleSlackHandoff(event.taskId, event.type, event.listId, supabase)
    return NextResponse.json({ ok: true })
  }

  // taskStatusUpdated — existing behavior unchanged
  let { data: task } = await supabase
    .from('tasks')
    .select('id, list_id, status')
    .eq('clickup_task_id', event.taskId)
    .single()

  if (!task) {
    const { data: token } = await supabase
      .from('oauth_tokens').select('access_token').eq('provider', 'clickup').limit(1).single()
    if (token) {
      try {
        const cuTask = await buildClickUpClient(token.access_token).getTask(event.taskId)
        const { data: list } = await supabase
          .from('lists').select('id').eq('clickup_list_id', cuTask.list.id).single()
        if (list) {
          const { data: inserted } = await supabase.from('tasks').insert({
            clickup_task_id: cuTask.id,
            list_id: list.id,
            name: cuTask.name,
            status: event.toStatus,
            custom_fields: (cuTask.custom_fields ?? []) as unknown as Json,
            synced_at: new Date().toISOString(),
          }).select('id, list_id, status').single()
          task = inserted
        }
      } catch (err) {
        console.warn('[webhook] auto-import failed for task', event.taskId, err)
      }
    }
    if (!task) return NextResponse.json({ ok: true })
  }

  const { data: configs } = await supabase
    .from('trigger_configs')
    .select('*')
    .eq('list_id', task.list_id)
    .eq('to_status', event.toStatus)

  await supabase.from('tasks')
    .update({ status: event.toStatus, synced_at: new Date().toISOString() })
    .eq('id', task.id)

  if (configs?.length) {
    const triggers = configs
      .filter((c) => !c.from_status || c.from_status === task!.status)
      .map((config) => ({ task_id: task!.id, config_id: config.id, status: 'pending' as const }))
    if (triggers.length > 0) {
      await supabase.from('trigger_queue').insert(triggers)
    }
  }

  await handleSlackHandoff(event.taskId, event.type, event.listId, supabase)
  return NextResponse.json({ ok: true })
}

async function handleSlackHandoff(
  clickupTaskId: string,
  eventType: string,
  targetListId: string | undefined,
  supabase: Awaited<ReturnType<typeof getSupabaseServiceClient>>,
): Promise<void> {
  const { data: slackIssue } = await supabase
    .from('slack_issues')
    .select('*')
    .eq('clickup_task_id', clickupTaskId)
    .single()

  if (!slackIssue) return

  const newTicketsListId = process.env.CLICKUP_NEW_TICKETS_LIST_ID
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const issue = slackIssue as any
  if (eventType === 'taskMoved' && targetListId === newTicketsListId && issue.handoff_status === 'taken') {
    await supabase.from('slack_issues').update({
      handoff_status: 'returned',
      updated_at: new Date().toISOString(),
    }).eq('clickup_task_id', clickupTaskId)

    const token = process.env.SLACK_BOT_TOKEN
    if (token) {
      const { buildSlackClient } = await import('@/lib/slack/client')
      await buildSlackClient(token).postMessage(
        issue.channel_id,
        "🔄 The dev team needs more information — I'll follow up with some questions.",
        issue.thread_ts,
      )
    }
    return
  }

  if (issue.handoff_status === 'taken') return

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase.from('slack_issues') as any).update({
    handoff_status: 'taken',
    updated_at: new Date().toISOString(),
  }).eq('clickup_task_id', clickupTaskId)

  const token = process.env.SLACK_BOT_TOKEN
  if (!token) return

  const { buildSlackClient } = await import('@/lib/slack/client')
  const slack = buildSlackClient(token)

  await slack.postMessage(
    issue.channel_id,
    '✅ Dev team has claimed this ticket — handing off.',
    issue.thread_ts,
  )
}
```

- [ ] **Step 4: Run the full webhook test suite**

```bash
npx jest __tests__/api/webhooks/clickup.test.ts --no-coverage
```

Expected: All tests pass, including the 3 new taskMoved tests.

- [ ] **Step 5: Commit**

```bash
git add app/api/webhooks/clickup/route.ts __tests__/api/webhooks/clickup.test.ts
git commit -m "feat(webhook): route taskMoved by destination list ID"
```

---

## Task 3: Seed Script — Trigger Configs

**Files:**
- Create: `scripts/seed-trigger-configs.ts`

- [ ] **Step 1: Add missing env vars to `.env.local`**

Add these three entries (the fourth, `CLICKUP_PLANNING_LIST_ID`, already exists):

```
CLICKUP_ACTIVE_LIST_ID=<your_active_list_clickup_id>
CLICKUP_NEXT_RELEASE_LIST_ID=<your_next_release_list_clickup_id>
CLICKUP_ARCHIVE_LIST_ID=<your_archive_list_clickup_id>
```

Find the IDs in ClickUp: open each list → URL contains `.../v/li/<LIST_ID>`.

Also add to Vercel environment variables (Dashboard → Project → Settings → Environment Variables) for production.

- [ ] **Step 2: Create the seed script**

```typescript
// scripts/seed-trigger-configs.ts
import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.join(__dirname, '../.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const LIST_CONFIGS = [
  { env: 'CLICKUP_PLANNING_LIST_ID', action: 'noop', label: 'Planning' },
  { env: 'CLICKUP_ACTIVE_LIST_ID', action: 'cherry_pick_bundle_and_post_kickoff', label: 'Active' },
  { env: 'CLICKUP_NEXT_RELEASE_LIST_ID', action: 'archive_active_branch', label: 'Next Release' },
  { env: 'CLICKUP_ARCHIVE_LIST_ID', action: 'close_vault_branch', label: 'Archive' },
] as const

async function main() {
  console.log('Seeding trigger configs...\n')

  for (const { env, action, label } of LIST_CONFIGS) {
    const clickupListId = process.env[env]
    if (!clickupListId) {
      console.warn(`⚠  Skipping ${label}: ${env} not set`)
      continue
    }

    const { data: list, error: listErr } = await supabase
      .from('lists')
      .select('id')
      .eq('clickup_list_id', clickupListId)
      .single()

    if (listErr || !list) {
      console.warn(`⚠  Skipping ${label}: no list row found for clickup_list_id=${clickupListId}`)
      console.warn('   Run Setup → Subscribe to Lists first.')
      continue
    }

    const { error } = await supabase
      .from('trigger_configs')
      .upsert(
        {
          list_id: list.id,
          destination_list_id: list.id,
          pm_agent_action: action,
          write_back_order: [],
          write_back_config: {},
          on_failure: 'continue',
        },
        { onConflict: 'destination_list_id' },
      )

    if (error) {
      console.error(`✗  ${label}:`, error.message)
    } else {
      console.log(`✓  ${label} → ${action}`)
    }
  }

  console.log('\nDone.')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 3: Run the seed script**

```bash
npx tsx scripts/seed-trigger-configs.ts
```

Expected output:
```
Seeding trigger configs...

✓  Planning → noop
✓  Active → cherry_pick_bundle_and_post_kickoff
✓  Next Release → archive_active_branch
✓  Archive → close_vault_branch

Done.
```

- [ ] **Step 4: Verify in Supabase dashboard**

Open Supabase → Table Editor → `trigger_configs`. Confirm 4 rows exist with non-null `destination_list_id` values.

- [ ] **Step 5: Commit**

```bash
git add scripts/seed-trigger-configs.ts .env.local
git commit -m "feat(seed): add trigger config seed script for list-based routing"
```

> ⚠ **Deploy now.** Migration 014 + seed must be live before the updated webhook handler goes live. Merge and deploy Tasks 1–3 as a unit before continuing.

---

## Task 4: Trigger Config UI — List-Based Display

**Files:**
- Modify: `app/triggers/config/page.tsx`
- Modify: `components/TriggerConfigTable.tsx`
- Create: `__tests__/components/TriggerConfigTable.test.tsx`

- [ ] **Step 1: Write failing component test**

Create `__tests__/components/TriggerConfigTable.test.tsx`:

```tsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import { TriggerConfigTable } from '@/components/TriggerConfigTable'

const mockConfigs = [
  {
    id: 'cfg-1',
    list_id: 'list-1',
    destination_list_id: 'list-1',
    pm_agent_action: 'cherry_pick_bundle_and_post_kickoff',
    list_name: 'Active',
    to_status: null,
    from_status: null,
    write_back_order: [],
    write_back_config: {},
    on_failure: 'continue' as const,
    created_at: '2026-06-01T00:00:00Z',
  },
  {
    id: 'cfg-2',
    list_id: 'list-2',
    destination_list_id: 'list-2',
    pm_agent_action: 'archive_active_branch',
    list_name: 'Next Release',
    to_status: null,
    from_status: null,
    write_back_order: [],
    write_back_config: {},
    on_failure: 'continue' as const,
    created_at: '2026-06-01T00:00:00Z',
  },
]

describe('TriggerConfigTable', () => {
  it('renders list names instead of status columns', () => {
    render(<TriggerConfigTable configs={mockConfigs} />)
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByText('Next Release')).toBeInTheDocument()
  })

  it('renders pm_agent_action as human-readable label', () => {
    render(<TriggerConfigTable configs={mockConfigs} />)
    expect(screen.getByText('Cherry-pick bundle & post kickoff')).toBeInTheDocument()
    expect(screen.getByText('Archive active branch')).toBeInTheDocument()
  })

  it('does not render old status-based columns', () => {
    render(<TriggerConfigTable configs={mockConfigs} />)
    expect(screen.queryByText('Write-backs')).not.toBeInTheDocument()
    expect(screen.queryByText('On Failure')).not.toBeInTheDocument()
  })

  it('shows empty state message when no configs', () => {
    render(<TriggerConfigTable configs={[]} />)
    expect(screen.getByText(/seed-trigger-configs/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx jest __tests__/components/TriggerConfigTable.test.tsx --no-coverage
```

Expected: FAIL — old columns still present, no list_name rendering.

- [ ] **Step 3: Update TriggerConfigTable**

Replace the entire contents of `components/TriggerConfigTable.tsx`:

```tsx
'use client'
import { Table, Tag, Typography } from 'antd'
import type { Tables } from '@/lib/supabase/types'

type Config = Tables<'trigger_configs'> & { list_name: string }

const ACTION_LABELS: Record<string, string> = {
  noop: 'No action',
  cherry_pick_bundle_and_post_kickoff: 'Cherry-pick bundle & post kickoff',
  archive_active_branch: 'Archive active branch',
  close_vault_branch: 'Close vault branch',
}

export function TriggerConfigTable({ configs }: { configs: Config[] }) {
  if (!configs.length) {
    return (
      <Typography.Text style={{ color: '#8b949e' }}>
        No trigger configs found. Run <code>scripts/seed-trigger-configs.ts</code> to populate.
      </Typography.Text>
    )
  }

  return (
    <Table
      dataSource={configs}
      rowKey="id"
      size="small"
      style={{ background: '#0d1117' }}
      columns={[
        {
          title: 'List',
          render: (_: unknown, r: Config) => (
            <Typography.Text style={{ color: '#e6edf3' }}>{r.list_name}</Typography.Text>
          ),
        },
        {
          title: 'Trigger',
          render: () => (
            <Typography.Text style={{ color: '#8b949e' }}>taskMoved → this list</Typography.Text>
          ),
        },
        {
          title: 'Action',
          render: (_: unknown, r: Config) => (
            <Typography.Text style={{ color: '#58a6ff' }}>
              {ACTION_LABELS[r.pm_agent_action] ?? r.pm_agent_action}
            </Typography.Text>
          ),
        },
        {
          title: 'Status',
          render: () => <Tag color="green">active</Tag>,
        },
      ]}
    />
  )
}
```

- [ ] **Step 4: Update the page to join list names**

Replace `app/triggers/config/page.tsx`:

```tsx
import { Layout, Typography } from 'antd'
import { TriggerConfigTable } from '@/components/TriggerConfigTable'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import { auth } from '@/lib/auth'
import type { Tables } from '@/lib/supabase/types'

type ConfigWithListName = Tables<'trigger_configs'> & { list_name: string }

export default async function TriggerConfigPage() {
  const session = await auth()
  const supabase = await getSupabaseServerClient()

  let configs: ConfigWithListName[] = []

  if (session?.user?.email) {
    const { data: user } = await supabase
      .from('users').select('id').eq('email', session.user.email).single()

    if (user) {
      const { data: lists } = await supabase
        .from('lists').select('id, name').eq('user_id', user.id)

      if (lists?.length) {
        const listIds = lists.map((l) => l.id)
        const listNameById = Object.fromEntries(lists.map((l) => [l.id, l.name]))

        const { data: raw } = await supabase
          .from('trigger_configs')
          .select('*')
          .in('destination_list_id', listIds)
          .not('destination_list_id', 'is', null)

        configs = (raw ?? []).map((c) => ({
          ...c,
          list_name: listNameById[c.destination_list_id!] ?? 'Unknown',
        }))
      }
    }
  }

  return (
    <Layout style={{ minHeight: '100vh', background: '#010409', padding: '24px 32px' }}>
      <Typography.Title level={3} style={{ color: '#e6edf3', marginBottom: 4 }}>
        Trigger Config
      </Typography.Title>
      <Typography.Text style={{ color: '#8b949e', display: 'block', marginBottom: 24 }}>
        Automatic actions triggered when tasks are moved between ClickUp lists.
      </Typography.Text>
      <TriggerConfigTable configs={configs} />
    </Layout>
  )
}
```

- [ ] **Step 5: Run tests**

```bash
npx jest __tests__/components/TriggerConfigTable.test.tsx --no-coverage
```

Expected: All 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/triggers/config/page.tsx components/TriggerConfigTable.tsx __tests__/components/TriggerConfigTable.test.tsx
git commit -m "feat(ui): update trigger config table to show list-based transitions"
```

---

## Task 5: DB Migrations — bundle_feedback + bundle_prompt_versions

**Files:**
- Create: `supabase/migrations/016_bundle_feedback.sql`
- Create: `supabase/migrations/017_bundle_prompt_versions.sql`

- [ ] **Step 1: Create migration 016**

```sql
-- supabase/migrations/016_bundle_feedback.sql

CREATE TABLE bundle_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sprint_id UUID REFERENCES sprints(id) ON DELETE SET NULL,
  bundle_version INT NOT NULL,
  developer_email TEXT NOT NULL,
  kickoff_prompt_rating INT NOT NULL CHECK (kickoff_prompt_rating BETWEEN 1 AND 5),
  user_stories_rating INT NOT NULL CHECK (user_stories_rating BETWEEN 1 AND 5),
  dev_skill_rating INT NOT NULL CHECK (dev_skill_rating BETWEEN 1 AND 5),
  comments TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(task_id, developer_email)
);

CREATE INDEX idx_bundle_feedback_sprint ON bundle_feedback(sprint_id);
CREATE INDEX idx_bundle_feedback_bundle_version ON bundle_feedback(bundle_version);
```

- [ ] **Step 2: Create migration 017**

```sql
-- supabase/migrations/017_bundle_prompt_versions.sql

CREATE TABLE bundle_prompt_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INT NOT NULL UNIQUE,
  prompt_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  proposed_prompt_text TEXT,
  change_summary TEXT,
  activated_at TIMESTAMPTZ,
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enforce single active version at the DB level
CREATE UNIQUE INDEX idx_bundle_prompt_versions_single_active
  ON bundle_prompt_versions(status)
  WHERE status = 'active';

-- Stamp bundle generations with the prompt version that produced them
ALTER TABLE bundle_generations
  ADD COLUMN IF NOT EXISTS prompt_version INT;
```

- [ ] **Step 3: Apply both migrations in Supabase SQL Editor**

Run 016 first, then 017. Then regenerate types:

```bash
npx supabase gen types typescript --project-id <YOUR_PROJECT_ID> > lib/supabase/types.ts
```

- [ ] **Step 4: Seed the first bundle_prompt_versions row**

In Supabase SQL Editor, insert the initial active version using the current bundle-generation prompt text. Open the existing bundle generation code to find the current prompt, then:

```sql
INSERT INTO bundle_prompt_versions (version, prompt_text, status, activated_at, approved_by)
VALUES (1, '<paste current prompt text here>', 'active', NOW(), 'initial seed');
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/016_bundle_feedback.sql supabase/migrations/017_bundle_prompt_versions.sql lib/supabase/types.ts
git commit -m "feat(db): add bundle_feedback and bundle_prompt_versions tables"
```

---

## Task 6: Feedback Token Library

**Files:**
- Create: `lib/feedback/token.ts`
- Create: `__tests__/lib/feedback/token.test.ts`

- [ ] **Step 1: Write failing tests**

Create `__tests__/lib/feedback/token.test.ts`:

```typescript
import { generateFeedbackToken, verifyFeedbackToken } from '@/lib/feedback/token'

const SECRET = 'test-secret-32-chars-minimum-ok!'
beforeEach(() => {
  process.env.FEEDBACK_TOKEN_SECRET = SECRET
})

describe('generateFeedbackToken / verifyFeedbackToken', () => {
  it('round-trips a sprint_id', () => {
    const token = generateFeedbackToken('sprint-abc')
    const payload = verifyFeedbackToken(token)
    expect(payload.sprint_id).toBe('sprint-abc')
  })

  it('includes an expiry ~7 days out', () => {
    const before = Date.now()
    const token = generateFeedbackToken('sprint-abc')
    const payload = verifyFeedbackToken(token)
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    expect(payload.expires_at).toBeGreaterThan(before + sevenDays - 1000)
    expect(payload.expires_at).toBeLessThan(before + sevenDays + 1000)
  })

  it('throws on tampered payload', () => {
    const token = generateFeedbackToken('sprint-abc')
    const [encoded, sig] = token.split('.')
    const tampered = Buffer.from(JSON.stringify({ sprint_id: 'evil', expires_at: Date.now() + 999999 })).toString('base64url')
    expect(() => verifyFeedbackToken(`${tampered}.${sig}`)).toThrow('Invalid token signature')
  })

  it('throws on expired token', () => {
    jest.useFakeTimers()
    const token = generateFeedbackToken('sprint-abc')
    jest.advanceTimersByTime(8 * 24 * 60 * 60 * 1000) // 8 days
    expect(() => verifyFeedbackToken(token)).toThrow('Token expired')
    jest.useRealTimers()
  })

  it('throws on malformed token (no dot separator)', () => {
    expect(() => verifyFeedbackToken('notavalidtoken')).toThrow('Invalid token format')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx jest __tests__/lib/feedback/token.test.ts --no-coverage
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the token library**

Create `lib/feedback/token.ts`:

```typescript
import crypto from 'crypto'

export interface FeedbackTokenPayload {
  sprint_id: string
  expires_at: number
}

function secret(): string {
  const s = process.env.FEEDBACK_TOKEN_SECRET
  if (!s) throw new Error('FEEDBACK_TOKEN_SECRET is not set')
  return s
}

export function generateFeedbackToken(sprintId: string): string {
  const payload: FeedbackTokenPayload = {
    sprint_id: sprintId,
    expires_at: Date.now() + 7 * 24 * 60 * 60 * 1000,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', secret()).update(encoded).digest('hex')
  return `${encoded}.${sig}`
}

export function verifyFeedbackToken(token: string): FeedbackTokenPayload {
  const dotIdx = token.lastIndexOf('.')
  if (dotIdx === -1) throw new Error('Invalid token format')

  const encoded = token.slice(0, dotIdx)
  const sig = token.slice(dotIdx + 1)

  const expected = crypto.createHmac('sha256', secret()).update(encoded).digest('hex')
  const sigBuf = Buffer.from(sig, 'hex')
  const expectedBuf = Buffer.from(expected, 'hex')

  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid token signature')
  }

  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as FeedbackTokenPayload
  if (Date.now() > payload.expires_at) throw new Error('Token expired')

  return payload
}
```

- [ ] **Step 4: Run tests**

```bash
npx jest __tests__/lib/feedback/token.test.ts --no-coverage
```

Expected: All 5 tests pass.

- [ ] **Step 5: Add env var**

Add to `.env.local` and Vercel environment variables:

```
FEEDBACK_TOKEN_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
```

- [ ] **Step 6: Commit**

```bash
git add lib/feedback/token.ts __tests__/lib/feedback/token.test.ts .env.local
git commit -m "feat(feedback): add HMAC token generation and verification"
```

---

## Task 7: Sprint Feedback Page + API Endpoint

**Files:**
- Create: `app/feedback/page.tsx`
- Create: `components/FeedbackForm.tsx`
- Create: `app/api/feedback/bundle/route.ts`
- Create: `__tests__/api/feedback/bundle.test.ts`

- [ ] **Step 1: Write failing API tests**

Create `__tests__/api/feedback/bundle.test.ts`:

```typescript
import { POST } from '@/app/api/feedback/bundle/route'
import { NextRequest } from 'next/server'
import { generateFeedbackToken } from '@/lib/feedback/token'

process.env.FEEDBACK_TOKEN_SECRET = 'test-secret-32-chars-minimum-ok!'

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn(),
}))

function makeSupabaseMock(upsertError: string | null = null) {
  const upsertFn = jest.fn().mockResolvedValue({ error: upsertError ? { message: upsertError } : null })
  return {
    from: jest.fn().mockReturnValue({
      upsert: upsertFn,
    }),
    _upsertFn: upsertFn,
  }
}

function makeRequest(body: object) {
  return new NextRequest('http://localhost/api/feedback/bundle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/feedback/bundle', () => {
  it('returns 400 for missing token', async () => {
    const req = makeRequest({ email: 'dev@example.com', responses: [] })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 401 for invalid token', async () => {
    const req = makeRequest({ token: 'bad.token', email: 'dev@example.com', responses: [] })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('returns 400 when a rating is out of range', async () => {
    const token = generateFeedbackToken('sprint-1')
    const req = makeRequest({
      token,
      email: 'dev@example.com',
      responses: [{
        task_id: 'task-1',
        sprint_id: 'sprint-1',
        bundle_version: 1,
        ratings: { kickoff_prompt: 6, user_stories: 3, dev_skill: 3 },
        comments: '',
      }],
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/rating/)
  })

  it('upserts feedback rows for valid payload', async () => {
    const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')
    const mock = makeSupabaseMock()
    getSupabaseServiceClient.mockResolvedValue(mock)

    const token = generateFeedbackToken('sprint-1')
    const req = makeRequest({
      token,
      email: 'dev@example.com',
      responses: [
        {
          task_id: 'task-1',
          sprint_id: 'sprint-1',
          bundle_version: 1,
          ratings: { kickoff_prompt: 4, user_stories: 3, dev_skill: 5 },
          comments: 'Great kickoff prompt.',
        },
      ],
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mock._upsertFn).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          task_id: 'task-1',
          developer_email: 'dev@example.com',
          kickoff_prompt_rating: 4,
          user_stories_rating: 3,
          dev_skill_rating: 5,
          comments: 'Great kickoff prompt.',
        }),
      ]),
      { onConflict: 'task_id,developer_email' },
    )
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx jest __tests__/api/feedback/bundle.test.ts --no-coverage
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the API endpoint**

Create `app/api/feedback/bundle/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { verifyFeedbackToken } from '@/lib/feedback/token'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

interface FeedbackResponse {
  task_id: string
  sprint_id: string
  bundle_version: number
  ratings: {
    kickoff_prompt: number
    user_stories: number
    dev_skill: number
  }
  comments?: string
}

interface RequestBody {
  token: string
  email: string
  responses: FeedbackResponse[]
}

export async function POST(req: NextRequest) {
  const body = await req.json() as Partial<RequestBody>

  if (!body.token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 })
  }

  try {
    verifyFeedbackToken(body.token)
  } catch {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  }

  if (!body.email || !body.responses?.length) {
    return NextResponse.json({ ok: true }) // Empty submission — ack
  }

  for (const r of body.responses) {
    const { kickoff_prompt, user_stories, dev_skill } = r.ratings ?? {}
    if (
      ![kickoff_prompt, user_stories, dev_skill].every(
        (v) => typeof v === 'number' && v >= 1 && v <= 5,
      )
    ) {
      return NextResponse.json({ error: 'Each rating must be between 1 and 5' }, { status: 400 })
    }
  }

  const supabase = await getSupabaseServiceClient()

  const rows = body.responses.map((r) => ({
    task_id: r.task_id,
    sprint_id: r.sprint_id ?? null,
    bundle_version: r.bundle_version,
    developer_email: body.email!,
    kickoff_prompt_rating: r.ratings.kickoff_prompt,
    user_stories_rating: r.ratings.user_stories,
    dev_skill_rating: r.ratings.dev_skill,
    comments: r.comments ?? null,
  }))

  const { error } = await supabase
    .from('bundle_feedback')
    .upsert(rows, { onConflict: 'task_id,developer_email' })

  if (error) {
    console.error('[feedback/bundle] upsert error:', error.message)
    return NextResponse.json({ error: 'Failed to save feedback' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: Run API tests**

```bash
npx jest __tests__/api/feedback/bundle.test.ts --no-coverage
```

Expected: All 4 tests pass.

- [ ] **Step 5: Create the feedback form component**

Create `components/FeedbackForm.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { Button, Card, Form, Input, Rate, Typography, Space } from 'antd'

interface Task {
  id: string
  name: string
  bundle_version: number
  sprint_id: string
}

interface Props {
  tasks: Task[]
  token: string
}

export function FeedbackForm({ tasks, token }: Props) {
  const [email, setEmail] = useState('')
  const [ratings, setRatings] = useState<Record<string, { kickoff: number; stories: number; skill: number; comments: string }>>({})
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (submitted) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 0' }}>
        <Typography.Title level={4} style={{ color: '#e6edf3' }}>Thanks for your feedback!</Typography.Title>
        <Typography.Text style={{ color: '#8b949e' }}>Your responses have been recorded.</Typography.Text>
      </div>
    )
  }

  const handleSubmit = async () => {
    if (!email.trim()) { setError('Email is required'); return }
    setLoading(true)
    setError(null)

    const responses = tasks.map((t) => ({
      task_id: t.id,
      sprint_id: t.sprint_id,
      bundle_version: t.bundle_version,
      ratings: {
        kickoff_prompt: ratings[t.id]?.kickoff ?? 0,
        user_stories: ratings[t.id]?.stories ?? 0,
        dev_skill: ratings[t.id]?.skill ?? 0,
      },
      comments: ratings[t.id]?.comments ?? '',
    }))

    const res = await fetch('/api/feedback/bundle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, email, responses }),
    })

    setLoading(false)
    if (res.ok) {
      setSubmitted(true)
    } else {
      const body = await res.json()
      setError(body.error ?? 'Submission failed. Please try again.')
    }
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Form.Item label={<Typography.Text style={{ color: '#e6edf3' }}>Your email</Typography.Text>}>
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@viscapmedia.com"
          style={{ background: '#161b22', borderColor: '#30363d', color: '#e6edf3', maxWidth: 320 }}
        />
      </Form.Item>

      {tasks.map((task) => (
        <Card
          key={task.id}
          style={{ background: '#161b22', borderColor: '#30363d' }}
          title={<Typography.Text style={{ color: '#e6edf3' }}>{task.name}</Typography.Text>}
          extra={<Typography.Text style={{ color: '#8b949e' }}>Bundle v{task.bundle_version}</Typography.Text>}
        >
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <Typography.Text style={{ color: '#8b949e' }}>Kickoff Prompt usefulness</Typography.Text>
              <Rate onChange={(v) => setRatings((r) => ({ ...r, [task.id]: { ...r[task.id], kickoff: v } }))} value={ratings[task.id]?.kickoff ?? 0} />
            </div>
            <div>
              <Typography.Text style={{ color: '#8b949e' }}>User Stories accuracy</Typography.Text>
              <Rate onChange={(v) => setRatings((r) => ({ ...r, [task.id]: { ...r[task.id], stories: v } }))} value={ratings[task.id]?.stories ?? 0} />
            </div>
            <div>
              <Typography.Text style={{ color: '#8b949e' }}>Dev Skill relevance</Typography.Text>
              <Rate onChange={(v) => setRatings((r) => ({ ...r, [task.id]: { ...r[task.id], skill: v } }))} value={ratings[task.id]?.skill ?? 0} />
            </div>
            <Input.TextArea
              placeholder="Any other comments? (optional)"
              value={ratings[task.id]?.comments ?? ''}
              onChange={(e) => setRatings((r) => ({ ...r, [task.id]: { ...r[task.id], comments: e.target.value } }))}
              style={{ background: '#0d1117', borderColor: '#30363d', color: '#e6edf3' }}
              rows={2}
            />
          </Space>
        </Card>
      ))}

      {error && <Typography.Text style={{ color: '#f85149' }}>{error}</Typography.Text>}

      <Button type="primary" loading={loading} onClick={handleSubmit}>
        Submit Feedback
      </Button>
    </Space>
  )
}
```

- [ ] **Step 6: Create the feedback page**

Create `app/feedback/page.tsx`:

```tsx
import { Layout, Typography } from 'antd'
import { FeedbackForm } from '@/components/FeedbackForm'
import { verifyFeedbackToken } from '@/lib/feedback/token'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  if (!token) {
    return (
      <Layout style={{ minHeight: '100vh', background: '#010409', padding: '48px 32px' }}>
        <Typography.Text style={{ color: '#f85149' }}>Invalid or expired link.</Typography.Text>
      </Layout>
    )
  }

  let sprintId: string
  try {
    const payload = verifyFeedbackToken(token)
    sprintId = payload.sprint_id
  } catch {
    return (
      <Layout style={{ minHeight: '100vh', background: '#010409', padding: '48px 32px' }}>
        <Typography.Text style={{ color: '#f85149' }}>Invalid or expired link.</Typography.Text>
      </Layout>
    )
  }

  const supabase = await getSupabaseServiceClient()

  // Get tasks in this sprint that have a bundle generation
  const { data: tasks } = await supabase
    .from('tasks')
    .select('id, name, sprint_id, bundle_generations(prompt_version, created_at)')
    .eq('sprint_id', sprintId)
    .not('bundle_generations', 'is', null)

  const formTasks = (tasks ?? [])
    .map((t) => {
      // bundle_generations is an array; take the most recent
      const gens = Array.isArray(t.bundle_generations) ? t.bundle_generations : [t.bundle_generations]
      const latest = gens.sort((a, b) =>
        new Date(b?.created_at ?? 0).getTime() - new Date(a?.created_at ?? 0).getTime()
      )[0]
      return {
        id: t.id,
        name: t.name,
        sprint_id: t.sprint_id ?? sprintId,
        bundle_version: latest?.prompt_version ?? 1,
      }
    })
    .filter((t) => t.bundle_version !== undefined)

  return (
    <Layout style={{ minHeight: '100vh', background: '#010409', padding: '48px 32px', maxWidth: 800 }}>
      <Typography.Title level={3} style={{ color: '#e6edf3', marginBottom: 4 }}>
        Sprint Bundle Feedback
      </Typography.Title>
      <Typography.Text style={{ color: '#8b949e', display: 'block', marginBottom: 32 }}>
        Rate the resource bundles from this sprint. Your feedback improves future bundles.
      </Typography.Text>
      {formTasks.length === 0 ? (
        <Typography.Text style={{ color: '#8b949e' }}>
          No bundled tasks found for this sprint.
        </Typography.Text>
      ) : (
        <FeedbackForm tasks={formTasks} token={token} />
      )}
    </Layout>
  )
}
```

- [ ] **Step 7: Run all tests**

```bash
npx jest --no-coverage
```

Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add app/feedback/page.tsx components/FeedbackForm.tsx app/api/feedback/bundle/route.ts __tests__/api/feedback/bundle.test.ts lib/feedback/token.ts __tests__/lib/feedback/token.test.ts
git commit -m "feat(feedback): add sprint feedback page and bundle feedback API"
```

---

## Task 8: Bundle Prompt Versioning Flow

**Files:**
- Create: `app/experiments/prompt-versions/page.tsx`
- Create: `components/FeedbackSummaryPanel.tsx`
- Create: `components/ProposedPromptPanel.tsx`
- Create: `app/api/experiments/propose-prompt/route.ts`
- Create: `app/api/experiments/approve-prompt/route.ts`
- Create: `app/api/experiments/reject-prompt/route.ts`

- [ ] **Step 1: Create the feedback summary panel component**

Create `components/FeedbackSummaryPanel.tsx`:

```tsx
'use client'
import { Button, Card, Progress, Typography, Space } from 'antd'
import { useState } from 'react'

interface AggregateRatings {
  kickoff_prompt: number
  user_stories: number
  dev_skill: number
  total_responses: number
  comments: string[]
}

interface Props {
  activeVersion: number
  ratings: AggregateRatings
  hasUnreviewed: boolean
  onPropose: () => Promise<void>
}

export function FeedbackSummaryPanel({ activeVersion, ratings, hasUnreviewed, onPropose }: Props) {
  const [loading, setLoading] = useState(false)

  const handlePropose = async () => {
    setLoading(true)
    await onPropose()
    setLoading(false)
  }

  return (
    <Card
      style={{ background: '#161b22', borderColor: '#30363d', height: '100%' }}
      title={
        <Typography.Text style={{ color: '#e6edf3' }}>
          Feedback — Bundle v{activeVersion}
        </Typography.Text>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Typography.Text style={{ color: '#8b949e' }}>
          {ratings.total_responses} response{ratings.total_responses !== 1 ? 's' : ''}
        </Typography.Text>

        {(['kickoff_prompt', 'user_stories', 'dev_skill'] as const).map((key) => (
          <div key={key}>
            <Typography.Text style={{ color: '#8b949e', fontSize: 12 }}>
              {{ kickoff_prompt: 'Kickoff Prompt', user_stories: 'User Stories', dev_skill: 'Dev Skill' }[key]}
            </Typography.Text>
            <Progress
              percent={Math.round((ratings[key] / 5) * 100)}
              format={() => `${ratings[key].toFixed(1)} / 5`}
              strokeColor="#58a6ff"
            />
          </div>
        ))}

        {ratings.comments.length > 0 && (
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {ratings.comments.map((c, i) => (
              <Typography.Paragraph key={i} style={{ color: '#8b949e', fontSize: 12, marginBottom: 4 }}>
                "{c}"
              </Typography.Paragraph>
            ))}
          </div>
        )}

        {hasUnreviewed && (
          <Button type="primary" loading={loading} onClick={handlePropose}>
            Analyze &amp; Propose Changes
          </Button>
        )}
      </Space>
    </Card>
  )
}
```

- [ ] **Step 2: Create the proposed prompt panel component**

Create `components/ProposedPromptPanel.tsx`:

```tsx
'use client'
import { Button, Card, Typography, Space } from 'antd'
import { useState } from 'react'

interface Props {
  proposedText: string | null
  changeSummary: string | null
  onApprove: () => Promise<void>
  onReject: () => Promise<void>
}

export function ProposedPromptPanel({ proposedText, changeSummary, onApprove, onReject }: Props) {
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null)

  const handleApprove = async () => {
    setLoading('approve')
    await onApprove()
    setLoading(null)
  }

  const handleReject = async () => {
    setLoading('reject')
    await onReject()
    setLoading(null)
  }

  if (!proposedText) {
    return (
      <Card style={{ background: '#161b22', borderColor: '#30363d', height: '100%' }}>
        <Typography.Text style={{ color: '#8b949e' }}>
          Click "Analyze &amp; Propose Changes" to generate a proposed prompt update.
        </Typography.Text>
      </Card>
    )
  }

  return (
    <Card
      style={{ background: '#161b22', borderColor: '#30363d', height: '100%' }}
      title={<Typography.Text style={{ color: '#e6edf3' }}>Proposed Update</Typography.Text>}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {changeSummary && (
          <div>
            <Typography.Text style={{ color: '#8b949e', fontSize: 12 }}>What changed</Typography.Text>
            <Typography.Paragraph style={{ color: '#e6edf3', whiteSpace: 'pre-wrap', fontSize: 13 }}>
              {changeSummary}
            </Typography.Paragraph>
          </div>
        )}
        <div>
          <Typography.Text style={{ color: '#8b949e', fontSize: 12 }}>Proposed prompt text</Typography.Text>
          <div
            style={{
              background: '#0d1117',
              border: '1px solid #30363d',
              borderRadius: 6,
              padding: 12,
              maxHeight: 400,
              overflowY: 'auto',
              fontFamily: 'monospace',
              fontSize: 12,
              color: '#e6edf3',
              whiteSpace: 'pre-wrap',
              marginTop: 8,
            }}
          >
            {proposedText}
          </div>
        </div>
        <Space>
          <Button
            type="primary"
            loading={loading === 'approve'}
            onClick={handleApprove}
          >
            Approve
          </Button>
          <Button
            danger
            loading={loading === 'reject'}
            onClick={handleReject}
          >
            Reject
          </Button>
        </Space>
      </Space>
    </Card>
  )
}
```

- [ ] **Step 3: Create the propose-prompt API route**

Create `app/api/experiments/propose-prompt/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'

export async function POST(_req: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()

  const { data: activeVersion } = await supabase
    .from('bundle_prompt_versions')
    .select('id, version, prompt_text')
    .eq('status', 'active')
    .single()

  if (!activeVersion) {
    return NextResponse.json({ error: 'No active prompt version found' }, { status: 404 })
  }

  const { data: feedback } = await supabase
    .from('bundle_feedback')
    .select('kickoff_prompt_rating, user_stories_rating, dev_skill_rating, comments')
    .eq('bundle_version', activeVersion.version)

  if (!feedback?.length) {
    return NextResponse.json({ error: 'No feedback available for analysis' }, { status: 400 })
  }

  const client = new Anthropic()

  const feedbackSummary = feedback.map((f, i) =>
    `Response ${i + 1}: Kickoff=${f.kickoff_prompt_rating}/5, UserStories=${f.user_stories_rating}/5, DevSkill=${f.dev_skill_rating}/5${f.comments ? `, Comments: "${f.comments}"` : ''}`
  ).join('\n')

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: `You are analyzing developer feedback on AI-generated resource bundles to improve the prompt that generates them.
The bundle consists of: spec.md, assessment.md, plan.md, dev-skill.md, qa-skill.md, user-stories.md, help-resources.md, kickoff-prompt.md.
Your job is to propose targeted improvements to the bundle-generation prompt based on the feedback patterns.
Respond with valid JSON only: { "proposed_prompt_text": "...", "change_summary": "..." }
The change_summary should be a bulleted list of specific changes made and the reasoning for each.`,
    messages: [
      {
        role: 'user',
        content: `Current bundle-generation prompt:\n\n${activeVersion.prompt_text}\n\n---\n\nDeveloper feedback (${feedback.length} responses):\n\n${feedbackSummary}\n\nPropose specific, minimal improvements to the prompt. Return JSON only.`,
      },
    ],
  })

  const responseText = message.content[0].type === 'text' ? message.content[0].text : ''
  let parsed: { proposed_prompt_text: string; change_summary: string }

  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/)
    parsed = JSON.parse(jsonMatch?.[0] ?? responseText)
  } catch {
    return NextResponse.json({ error: 'Claude returned unparseable response' }, { status: 500 })
  }

  await supabase
    .from('bundle_prompt_versions')
    .update({
      proposed_prompt_text: parsed.proposed_prompt_text,
      change_summary: parsed.change_summary,
    })
    .eq('id', activeVersion.id)

  return NextResponse.json({
    proposed_prompt_text: parsed.proposed_prompt_text,
    change_summary: parsed.change_summary,
  })
}
```

- [ ] **Step 4: Create the approve-prompt API route**

Create `app/api/experiments/approve-prompt/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export async function POST(_req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()

  const { data: activeVersion } = await supabase
    .from('bundle_prompt_versions')
    .select('id, version, proposed_prompt_text')
    .eq('status', 'active')
    .single()

  if (!activeVersion?.proposed_prompt_text) {
    return NextResponse.json({ error: 'No proposed prompt text to approve' }, { status: 400 })
  }

  // Archive the current active version
  const { error: archiveError } = await supabase
    .from('bundle_prompt_versions')
    .update({
      status: 'archived',
      proposed_prompt_text: null,
      change_summary: null,
    })
    .eq('id', activeVersion.id)

  if (archiveError) {
    return NextResponse.json({ error: 'Failed to archive current version' }, { status: 500 })
  }

  // Insert new active version
  const { error: insertError } = await supabase
    .from('bundle_prompt_versions')
    .insert({
      version: activeVersion.version + 1,
      prompt_text: activeVersion.proposed_prompt_text,
      status: 'active',
      activated_at: new Date().toISOString(),
      approved_by: session.user.email,
    })

  if (insertError) {
    return NextResponse.json({ error: 'Failed to insert new version' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, new_version: activeVersion.version + 1 })
}
```

- [ ] **Step 5: Create the reject-prompt API route**

Create `app/api/experiments/reject-prompt/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export async function POST(_req: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()

  const { error } = await supabase
    .from('bundle_prompt_versions')
    .update({ proposed_prompt_text: null, change_summary: null })
    .eq('status', 'active')

  if (error) {
    return NextResponse.json({ error: 'Failed to clear proposal' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 6: Create the prompt versions page**

Create `app/experiments/prompt-versions/page.tsx`:

```tsx
import { auth } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import { PromptVersionsClient } from './client'

export default async function PromptVersionsPage() {
  const session = await auth()
  if (!session?.user) redirect('/api/auth/signin')

  const supabase = await getSupabaseServerClient()

  const { data: activeVersion } = await supabase
    .from('bundle_prompt_versions')
    .select('id, version, proposed_prompt_text, change_summary')
    .eq('status', 'active')
    .single()

  // Aggregate feedback for the active version
  const { data: feedback } = await supabase
    .from('bundle_feedback')
    .select('kickoff_prompt_rating, user_stories_rating, dev_skill_rating, comments')
    .eq('bundle_version', activeVersion?.version ?? 1)

  const ratings = {
    kickoff_prompt: avg(feedback?.map((f) => f.kickoff_prompt_rating) ?? []),
    user_stories: avg(feedback?.map((f) => f.user_stories_rating) ?? []),
    dev_skill: avg(feedback?.map((f) => f.dev_skill_rating) ?? []),
    total_responses: feedback?.length ?? 0,
    comments: feedback?.map((f) => f.comments).filter(Boolean) as string[],
  }

  return (
    <PromptVersionsClient
      activeVersion={activeVersion?.version ?? 1}
      ratings={ratings}
      initialProposedText={activeVersion?.proposed_prompt_text ?? null}
      initialChangeSummary={activeVersion?.change_summary ?? null}
    />
  )
}

function avg(nums: number[]): number {
  if (!nums.length) return 0
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10
}
```

- [ ] **Step 7: Create the client component**

Create `app/experiments/prompt-versions/client.tsx`:

```tsx
'use client'
import { Layout, Row, Col, Typography } from 'antd'
import { useState } from 'react'
import { FeedbackSummaryPanel } from '@/components/FeedbackSummaryPanel'
import { ProposedPromptPanel } from '@/components/ProposedPromptPanel'

interface Props {
  activeVersion: number
  ratings: {
    kickoff_prompt: number
    user_stories: number
    dev_skill: number
    total_responses: number
    comments: string[]
  }
  initialProposedText: string | null
  initialChangeSummary: string | null
}

export function PromptVersionsClient({ activeVersion, ratings, initialProposedText, initialChangeSummary }: Props) {
  const [proposedText, setProposedText] = useState(initialProposedText)
  const [changeSummary, setChangeSummary] = useState(initialChangeSummary)

  const handlePropose = async () => {
    const res = await fetch('/api/experiments/propose-prompt', { method: 'POST' })
    if (res.ok) {
      const data = await res.json()
      setProposedText(data.proposed_prompt_text)
      setChangeSummary(data.change_summary)
    }
  }

  const handleApprove = async () => {
    const res = await fetch('/api/experiments/approve-prompt', { method: 'POST' })
    if (res.ok) window.location.reload()
  }

  const handleReject = async () => {
    await fetch('/api/experiments/reject-prompt', { method: 'POST' })
    setProposedText(null)
    setChangeSummary(null)
  }

  return (
    <Layout style={{ minHeight: '100vh', background: '#010409', padding: '24px 32px' }}>
      <Typography.Title level={3} style={{ color: '#e6edf3', marginBottom: 24 }}>
        Bundle Prompt Versions
      </Typography.Title>
      <Row gutter={24} style={{ flex: 1 }}>
        <Col span={12}>
          <FeedbackSummaryPanel
            activeVersion={activeVersion}
            ratings={ratings}
            hasUnreviewed={ratings.total_responses > 0 && !proposedText}
            onPropose={handlePropose}
          />
        </Col>
        <Col span={12}>
          <ProposedPromptPanel
            proposedText={proposedText}
            changeSummary={changeSummary}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        </Col>
      </Row>
    </Layout>
  )
}
```

- [ ] **Step 8: Run full test suite**

```bash
npx jest --no-coverage
```

Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
git add app/experiments/prompt-versions/ components/FeedbackSummaryPanel.tsx components/ProposedPromptPanel.tsx app/api/experiments/
git commit -m "feat(experiments): add bundle prompt versioning flow"
```

---

## Task 9: Developer Experiment API Endpoint

**Files:**
- Create: `app/api/developers/[email]/experiment/route.ts`
- Create: `__tests__/api/developers/experiment.test.ts`

- [ ] **Step 1: Write failing tests**

Create `__tests__/api/developers/experiment.test.ts`:

```typescript
import { GET } from '@/app/api/developers/[email]/experiment/route'
import { NextRequest } from 'next/server'

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn(),
}))

function makeRequest(email: string) {
  return new NextRequest(`http://localhost/api/developers/${email}/experiment`)
}

function makeSupabaseMock(overrides: { version?: number; sprint?: string } = {}) {
  return {
    from: jest.fn().mockImplementation((table: string) => {
      const base = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: null }),
      }
      if (table === 'bundle_prompt_versions') {
        return { ...base, single: jest.fn().mockResolvedValue({ data: { version: overrides.version ?? 2 } }) }
      }
      if (table === 'sprints') {
        return { ...base, single: jest.fn().mockResolvedValue({
          data: { clickup_sprint_id: overrides.sprint ?? '2026-07' }
        }) }
      }
      return base
    }),
  }
}

describe('GET /api/developers/[email]/experiment', () => {
  it('returns experiment context with version, bundle_version, and sprint', async () => {
    const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(makeSupabaseMock({ version: 3, sprint: '2026-07' }))

    const req = makeRequest('dev@example.com')
    const res = await GET(req, { params: Promise.resolve({ email: 'dev@example.com' }) })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.version).toBe('v1')
    expect(body.bundle_version).toBe(3)
    expect(body.sprint).toMatch(/^\d{4}-\d{2}$/)
  })

  it('returns defaults when no active version or sprint exists', async () => {
    const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue(makeSupabaseMock())

    const req = makeRequest('dev@example.com')
    const res = await GET(req, { params: Promise.resolve({ email: 'dev@example.com' }) })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.version).toBe('v1')
    expect(typeof body.bundle_version).toBe('number')
    expect(typeof body.sprint).toBe('string')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx jest __tests__/api/developers/experiment.test.ts --no-coverage
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the endpoint**

Create `app/api/developers/[email]/experiment/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

const EXPERIMENT_VERSION = 'v1'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ email: string }> },
) {
  await params // resolve but we don't use email in v1 — tag context is global

  const supabase = await getSupabaseServiceClient()

  const [{ data: activeVersion }, { data: openSprint }] = await Promise.all([
    supabase
      .from('bundle_prompt_versions')
      .select('version')
      .eq('status', 'active')
      .single(),
    supabase
      .from('sprints')
      .select('clickup_sprint_id, starts_at')
      .order('starts_at', { ascending: false })
      .limit(1)
      .single(),
  ])

  // Derive sprint label as YYYY-MM from sprint ID or starts_at
  const sprintLabel = deriveSprintLabel(openSprint?.clickup_sprint_id, openSprint?.starts_at)

  return NextResponse.json({
    version: EXPERIMENT_VERSION,
    bundle_version: activeVersion?.version ?? 1,
    sprint: sprintLabel,
  })
}

function deriveSprintLabel(sprintId: string | undefined, startsAt: string | undefined): string {
  // Try to extract YYYY-MM from sprint ID string if it contains a date
  if (sprintId) {
    const match = sprintId.match(/(\d{4})-(\d{2})/)
    if (match) return `${match[1]}-${match[2]}`
  }
  // Fall back to starts_at date
  if (startsAt) {
    const d = new Date(startsAt)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  }
  // Fall back to current month
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}
```

- [ ] **Step 4: Run tests**

```bash
npx jest __tests__/api/developers/experiment.test.ts --no-coverage
```

Expected: Both tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/api/developers/[email]/experiment/route.ts __tests__/api/developers/experiment.test.ts
git commit -m "feat(api): add developer experiment context endpoint"
```

---

## Task 10: VIDF Git Hook Scripts

**Files:**
- Create: `scripts/vidf-hook/commit-msg`
- Create: `scripts/vidf-hook/install-git-hook.sh`

- [ ] **Step 1: Create the commit-msg hook script**

Create `scripts/vidf-hook/commit-msg`:

```bash
#!/usr/bin/env bash
# VIDF experiment tag hook — appends [vidf:v{N} | bundle:v{N} | sprint:{YYYY-MM}] to commit messages.
# Exits 0 on any failure so it never blocks a commit.

COMMIT_MSG_FILE="$1"
COMMIT_MSG=$(cat "$COMMIT_MSG_FILE")

# Skip if tag already present
if echo "$COMMIT_MSG" | grep -qE '\[vidf:[^ ]+ \| bundle:v[0-9]+ \| sprint:[0-9]{4}-[0-9]{2}\]'; then
  exit 0
fi

EMAIL=$(git config user.email 2>/dev/null)
if [ -z "$EMAIL" ]; then
  exit 0
fi

PM_APP_URL="${VISCAP_PM_APP_URL:-https://pm.viscapmedia.com}"
RESPONSE=$(curl -s --max-time 3 "${PM_APP_URL}/api/developers/${EMAIL}/experiment" 2>/dev/null)

if [ -z "$RESPONSE" ]; then
  exit 0
fi

VERSION=$(echo "$RESPONSE" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
BUNDLE_VERSION=$(echo "$RESPONSE" | grep -o '"bundle_version":[0-9]*' | grep -o '[0-9]*$')
SPRINT=$(echo "$RESPONSE" | grep -o '"sprint":"[^"]*"' | cut -d'"' -f4)

if [ -z "$VERSION" ] || [ -z "$BUNDLE_VERSION" ] || [ -z "$SPRINT" ]; then
  exit 0
fi

TAG="[vidf:${VERSION} | bundle:v${BUNDLE_VERSION} | sprint:${SPRINT}]"

printf "\n%s" "$TAG" >> "$COMMIT_MSG_FILE"

exit 0
```

- [ ] **Step 2: Create the install script**

Create `scripts/vidf-hook/install-git-hook.sh`:

```bash
#!/usr/bin/env bash
# Installs the VIDF commit-msg hook into the current git repository.
# Usage: bash scripts/vidf-hook/install-git-hook.sh [pm-app-url]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)

if [ -z "$GIT_DIR" ]; then
  echo "Error: not in a git repository." >&2
  exit 1
fi

HOOKS_DIR="${GIT_DIR}/hooks"
HOOK_FILE="${HOOKS_DIR}/commit-msg"

mkdir -p "$HOOKS_DIR"
cp "${SCRIPT_DIR}/commit-msg" "$HOOK_FILE"
chmod +x "$HOOK_FILE"

# Optionally set the PM App URL
if [ -n "$1" ]; then
  git config viscap.pmAppUrl "$1"
  echo "PM App URL set to: $1"
fi

echo "✓ VIDF commit-msg hook installed at ${HOOK_FILE}"
echo ""
echo "Every commit will be tagged: [vidf:v1 | bundle:v{N} | sprint:{YYYY-MM}]"
echo "The hook exits silently if the PM App is unreachable — it will never block a commit."
echo ""
echo "To set the PM App URL later:"
echo "  git config viscap.pmAppUrl https://pm.viscapmedia.com"
```

- [ ] **Step 3: Make scripts executable and test locally**

```bash
chmod +x scripts/vidf-hook/commit-msg
chmod +x scripts/vidf-hook/install-git-hook.sh
```

Test the hook manually by installing it in a test repo:

```bash
mkdir /tmp/vidf-test && cd /tmp/vidf-test
git init
bash <path-to-pm-app>/scripts/vidf-hook/install-git-hook.sh
echo "test" > test.txt && git add test.txt
git commit -m "test: verify vidf hook appends tag"
git log --oneline -1
```

Expected: Commit message ends with `[vidf:v1 | bundle:v1 | sprint:YYYY-MM]` (or tag is absent if API unreachable — both are acceptable; hook must not fail).

- [ ] **Step 4: Add `VISCAP_PM_APP_URL` to project README or onboarding doc**

Note in your team's developer setup instructions:
```
VISCAP_PM_APP_URL=https://pm.viscapmedia.com  # used by VIDF commit hook
```

- [ ] **Step 5: Commit**

```bash
cd <pm-app-root>
git add scripts/vidf-hook/
git commit -m "feat(vidf): add commit-msg hook and install script"
```

---

## Task 11: GitHub Action — VIDF Tag Validation

**Files:**
- Create: `.github/workflows/vidf-validate.yml`

- [ ] **Step 1: Create the GitHub Action**

```bash
mkdir -p .github/workflows
```

Create `.github/workflows/vidf-validate.yml`:

```yaml
name: VIDF Tag Validation

on:
  pull_request:
    branches: ['**']

jobs:
  validate-vidf-tags:
    name: Validate VIDF commit tags
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Check for .vidf-enabled
        id: check_enabled
        run: |
          if [ -f ".vidf-enabled" ]; then
            echo "enabled=true" >> "$GITHUB_OUTPUT"
          else
            echo "enabled=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Validate VIDF tags on all feature commits
        if: steps.check_enabled.outputs.enabled == 'true'
        run: |
          MISSING=()
          while IFS= read -r line; do
            SHA="${line%% *}"
            MSG="${line#* }"
            if ! echo "$MSG" | grep -qE '\[vidf:[^ ]+ \| bundle:v[0-9]+ \| sprint:[0-9]{4}-[0-9]{2}\]'; then
              MISSING+=("$SHA: $MSG")
            fi
          done < <(git log origin/${{ github.base_ref }}..HEAD --no-merges --oneline)

          if [ ${#MISSING[@]} -gt 0 ]; then
            echo "::error::The following commits are missing VIDF tags:"
            for item in "${MISSING[@]}"; do
              echo "  $item"
            done
            echo ""
            echo "Expected format: [vidf:v1 | bundle:v3 | sprint:2026-06]"
            echo "Install the VIDF hook: bash scripts/vidf-hook/install-git-hook.sh"
            exit 1
          fi

          echo "✓ All commits contain valid VIDF tags."
```

- [ ] **Step 2: Create the opt-in marker file in repos that should enforce tags**

This file goes in the *feature repo* (e.g., `ViscapMedia/pm-app`), not the docs repo:

```bash
touch .vidf-enabled
git add .vidf-enabled
git commit -m "chore: enable VIDF tag validation"
```

For the PM App itself, skip this unless you want PM App commits tagged too. The hook is primarily for feature repos where developers are writing code that the experiment measures.

- [ ] **Step 3: Push the workflow and verify**

```bash
git add .github/workflows/vidf-validate.yml
git commit -m "feat(ci): add VIDF tag validation GitHub Action"
```

Push to a branch and open a PR. The action should appear in the Checks tab. If `.vidf-enabled` is absent, the validation step is skipped — no failure.

---

## Self-Review Checklist

Spec section → Task coverage:

| Spec Section | Covered By |
|---|---|
| Webhook fix — `taskMoved` routing | Task 2 |
| Webhook fix — preserve `status` on move | Task 2 (test + impl) |
| Webhook fix — auto-import sets `list_id` not `status` | Task 2 |
| Migration 014 — `destination_list_id` + unique index | Task 1 |
| Seed script — 4 list trigger configs | Task 3 |
| New env vars (ACTIVE/NEXT_RELEASE/ARCHIVE list IDs) | Task 3 |
| Trigger Config UI — list names, no hardcoded rows | Task 4 |
| Migration 016 — `bundle_feedback` | Task 5 |
| Migration 017 — `bundle_prompt_versions` + `bundle_generations.prompt_version` | Task 5 |
| Feedback token — HMAC, 7-day expiry, tamper-proof | Task 6 |
| Feedback page — token-gated, sprint tasks | Task 7 |
| Feedback API — validate ratings, upsert | Task 7 |
| Propose-prompt API — Claude full-text replace | Task 8 |
| Approve-prompt API — archive + insert new version | Task 8 |
| Reject-prompt API — clear proposal | Task 8 |
| Prompt versions page — two-panel layout | Task 8 |
| Developer experiment API — version + bundle + sprint | Task 9 |
| Idempotency guards on trigger queue processor | ⚠ Not in this plan — see note below |
| VIDF commit-msg hook script | Task 10 |
| VIDF install script | Task 10 |
| GitHub Action — `git log origin/main..HEAD --no-merges` | Task 11 |
| `.vidf-enabled` opt-in | Task 11 |

> ⚠ **Out of scope — separate ticket:** The idempotency guards on the trigger queue processor (`cherry_pick_bundle_and_post_kickoff` and `archive_active_branch`) require changes to the queue processor worker, which is not part of this plan. File a separate ticket: "Add pre-condition checks to trigger queue processor to prevent duplicate branch operations."

> ⚠ **Atomic deploy reminder:** Tasks 1–3 (migration 014, webhook fix, seed) must be deployed as a unit. Do not merge Task 2 without first applying the migration and running the seed script.

# Slack Bot Workflow Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current gather-then-create Slack bot workflow with a create-first flow that immediately opens a ClickUp ticket, enriches it through conversation, uses a database-stored SOP that the bot can propose changes to, and collects dual-channel feedback for self-improvement.

**Architecture:** Three deployment phases — Foundation (DB + SOP infrastructure), Core Workflow (behavior changes), Intelligence Layer (analysis cron + PM approval). Each phase is independently deployable and testable. Phase A must ship before Phase B; Phase B before Phase C.

**Tech Stack:** Next.js App Router, Supabase (Postgres), Anthropic Claude SDK (`claude-opus-4-6`), Slack Events API + Block Kit, ClickUp API v2, Jest + ts-jest

---

## Spec reference

`docs/superpowers/specs/2026-05-05-slack-bot-workflow-redesign.md`

---

## File Map

### Phase A — Foundation

| Action | Path |
|---|---|
| Create | `supabase/migrations/012_bot_sops.sql` |
| Create | `supabase/migrations/013_seed_initial_sop.sql` |
| Modify | `lib/issue-triage/types.ts` |
| Create | `lib/issue-triage/sop.ts` |
| Create | `lib/issue-triage/observations.ts` |
| Create | `__tests__/lib/issue-triage/sop.test.ts` |
| Create | `__tests__/lib/issue-triage/observations.test.ts` |

### Phase B — Core Workflow

| Action | Path |
|---|---|
| Create | `lib/issue-triage/media.ts` |
| Modify | `lib/issue-triage/conversation.ts` |
| Modify | `lib/issue-triage/duplicate-detection.ts` |
| Modify | `lib/issue-triage/router.ts` |
| Modify | `app/api/webhooks/slack/route.ts` |
| Modify | `app/api/webhooks/clickup/route.ts` |
| Create | `__tests__/lib/issue-triage/media.test.ts` |
| Modify | `__tests__/api/webhooks/slack.test.ts` |
| Modify | `__tests__/api/webhooks/clickup.test.ts` |

### Phase C — Intelligence Layer

| Action | Path |
|---|---|
| Create | `app/api/cron/sop-analysis/route.ts` |
| Create | `__tests__/api/cron/sop-analysis.test.ts` |

---

## PHASE A — Foundation

---

### Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/012_bot_sops.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/012_bot_sops.sql

-- Add sop_version to slack_issues
ALTER TABLE slack_issues ADD COLUMN sop_version INTEGER;

-- Add 'passive' status (confirmed duplicate — thread alive, bot appends to parent)
ALTER TYPE slack_issue_status ADD VALUE IF NOT EXISTS 'passive';

-- bot_sops: versioned behavioral rules for the bot
CREATE TABLE bot_sops (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version              INTEGER UNIQUE NOT NULL,
  intake_prompt        TEXT NOT NULL,
  escalation_rules     JSONB NOT NULL DEFAULT '{}',
  duplicate_thresholds JSONB NOT NULL DEFAULT '{}',
  manual_directives    JSONB NOT NULL DEFAULT '[]',
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  change_summary       TEXT,
  approved_by          TEXT,
  approved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Exactly one active SOP at any time
CREATE UNIQUE INDEX idx_bot_sops_single_active ON bot_sops(status) WHERE status = 'active';

-- bot_observations: structured outcome log for every bot action
CREATE TABLE bot_observations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_ts        TEXT REFERENCES slack_issues(thread_ts) ON DELETE CASCADE,
  clickup_task_id  TEXT,
  sop_version      INTEGER,
  event_type       TEXT NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bot_obs_thread     ON bot_observations(thread_ts);
CREATE INDEX idx_bot_obs_sop        ON bot_observations(sop_version);
CREATE INDEX idx_bot_obs_event_type ON bot_observations(event_type);
CREATE INDEX idx_bot_obs_created_at ON bot_observations(created_at);

-- sop_proposals: bot-generated improvement proposals awaiting PM review
CREATE TABLE sop_proposals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sop_version       INTEGER NOT NULL,
  proposed_changes  JSONB NOT NULL DEFAULT '{}',
  pattern_summary   TEXT NOT NULL,
  supporting_data   JSONB NOT NULL DEFAULT '{}',
  rejection_history JSONB NOT NULL DEFAULT '[]',
  claude_confidence FLOAT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending_review'
                    CHECK (status IN ('pending_review', 'approved', 'rejected')),
  pm_response       TEXT,
  resolved_by       TEXT,
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sop_proposals_status ON sop_proposals(status);
```

- [ ] **Step 2: Apply migration**

```bash
npx supabase db push
```

Expected: migration applied with no errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/012_bot_sops.sql
git commit -m "feat: add bot_sops, bot_observations, sop_proposals tables; add sop_version to slack_issues"
```

---

### Task 2: TypeScript Types

**Files:**
- Modify: `lib/issue-triage/types.ts`

- [ ] **Step 1: Add new types to the end of `lib/issue-triage/types.ts`**

```typescript
// ---- SOP types ----

export interface EscalationRules {
  maxTurns: number
  disengagementThreshold: number
  minConfidenceMovementPerTurn: number
}

export interface DuplicateThresholds {
  possible: number
  confirmed: number
  collisionWindowHours: number
  collisionCount: number
}

export interface ManualDirective {
  trigger: 'contains_word' | 'always'
  value?: string
  action: string
  added_by: string
  added_at: string
}

export interface BotSop {
  id: string
  version: number
  intake_prompt: string
  escalation_rules: EscalationRules
  duplicate_thresholds: DuplicateThresholds
  manual_directives: ManualDirective[]
  status: 'active' | 'archived'
  change_summary: string | null
  approved_by: string | null
  approved_at: string | null
  created_at: string
}

// ---- Observation types ----

export type ObservationEventType =
  | 'ticket_created'
  | 'enrichment_turn'
  | 'duplicate_flagged'
  | 'duplicate_confirmed'
  | 'duplicate_overridden'
  | 'priority_bump'
  | 'team_correction'
  | 'escalation_triggered'
  | 'reporter_disengaged'
  | 'handoff_complete'
  | 'human_feedback'

// ---- Update SlackIssueStatus to include 'passive' ----
```

- [ ] **Step 2: Replace `SlackIssueStatus` to include the new `passive` value**

Find this block in `lib/issue-triage/types.ts`:

```typescript
export type SlackIssueStatus =
  | 'gathering'
  | 'confirming'
  | 'triaging'
  | 'complete'
  | 'human_takeover'
```

Replace with:

```typescript
export type SlackIssueStatus =
  | 'gathering'
  | 'confirming'
  | 'triaging'
  | 'passive'
  | 'complete'
  | 'human_takeover'
```

- [ ] **Step 3: Verify TypeScript**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/issue-triage/types.ts
git commit -m "feat: add BotSop, EscalationRules, DuplicateThresholds, ObservationEventType types; add passive status"
```

---

### Task 3: SOP Loader

**Files:**
- Create: `lib/issue-triage/sop.ts`
- Create: `__tests__/lib/issue-triage/sop.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/lib/issue-triage/sop.test.ts
import type { BotSop } from '@/lib/issue-triage/types'

const mockSingle = jest.fn()
const mockEq = jest.fn().mockReturnThis()
const mockSelect = jest.fn().mockReturnThis()
const mockFrom = jest.fn().mockReturnValue({ select: mockSelect, eq: mockEq, single: mockSingle })

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({ from: mockFrom }),
}))

const fakeSop: BotSop = {
  id: 'sop-1',
  version: 1,
  intake_prompt: 'You are a helpful bot.',
  escalation_rules: { maxTurns: 8, disengagementThreshold: 2, minConfidenceMovementPerTurn: 0.05 },
  duplicate_thresholds: { possible: 0.60, confirmed: 0.85, collisionWindowHours: 24, collisionCount: 3 },
  manual_directives: [],
  status: 'active',
  change_summary: null,
  approved_by: null,
  approved_at: null,
  created_at: new Date().toISOString(),
}

describe('getActiveSop', () => {
  beforeEach(() => { jest.resetModules(); mockSingle.mockReset() })

  it('returns the active SOP from Supabase', async () => {
    mockSingle.mockResolvedValue({ data: fakeSop, error: null })
    const { getActiveSop } = await import('@/lib/issue-triage/sop')
    const result = await getActiveSop()
    expect(result.version).toBe(1)
    expect(result.intake_prompt).toBe('You are a helpful bot.')
  })

  it('throws when no active SOP exists', async () => {
    mockSingle.mockResolvedValue({ data: null, error: { message: 'No rows' } })
    const { getActiveSop } = await import('@/lib/issue-triage/sop')
    await expect(getActiveSop()).rejects.toThrow('No active SOP found')
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx jest __tests__/lib/issue-triage/sop.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/issue-triage/sop'`

- [ ] **Step 3: Implement the SOP loader**

```typescript
// lib/issue-triage/sop.ts
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import type { BotSop } from './types'

export async function getActiveSop(): Promise<BotSop> {
  const supabase = await getSupabaseServiceClient()
  const { data, error } = await supabase
    .from('bot_sops')
    .select('*')
    .eq('status', 'active')
    .single()

  if (error || !data) throw new Error('No active SOP found')
  return data as BotSop
}
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
npx jest __tests__/lib/issue-triage/sop.test.ts --no-coverage
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/issue-triage/sop.ts __tests__/lib/issue-triage/sop.test.ts
git commit -m "feat: add getActiveSop helper with tests"
```

---

### Task 4: Observation Helper

**Files:**
- Create: `lib/issue-triage/observations.ts`
- Create: `__tests__/lib/issue-triage/observations.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/lib/issue-triage/observations.test.ts
const mockInsert = jest.fn().mockResolvedValue({ error: null })
const mockFrom = jest.fn().mockReturnValue({ insert: mockInsert })

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({ from: mockFrom }),
}))

describe('recordObservation', () => {
  beforeEach(() => mockInsert.mockClear())

  it('inserts a row into bot_observations', async () => {
    const { recordObservation } = await import('@/lib/issue-triage/observations')
    await recordObservation('1234.0001', 'task-abc', 1, 'ticket_created', { confidence: 0.1 })

    expect(mockFrom).toHaveBeenCalledWith('bot_observations')
    expect(mockInsert).toHaveBeenCalledWith({
      thread_ts: '1234.0001',
      clickup_task_id: 'task-abc',
      sop_version: 1,
      event_type: 'ticket_created',
      payload: { confidence: 0.1 },
    })
  })

  it('accepts null clickup_task_id for tickets not yet created', async () => {
    const { recordObservation } = await import('@/lib/issue-triage/observations')
    await expect(
      recordObservation('1234.0001', null, 1, 'ticket_created', {})
    ).resolves.not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx jest __tests__/lib/issue-triage/observations.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/issue-triage/observations'`

- [ ] **Step 3: Implement the observation helper**

```typescript
// lib/issue-triage/observations.ts
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import type { ObservationEventType } from './types'

export async function recordObservation(
  threadTs: string,
  clickupTaskId: string | null,
  sopVersion: number,
  eventType: ObservationEventType,
  payload: Record<string, unknown>,
): Promise<void> {
  const supabase = await getSupabaseServiceClient()
  const { error } = await supabase.from('bot_observations').insert({
    thread_ts: threadTs,
    clickup_task_id: clickupTaskId,
    sop_version: sopVersion,
    event_type: eventType,
    payload,
  })
  if (error) console.error('[observations] insert failed:', error)
}
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
npx jest __tests__/lib/issue-triage/observations.test.ts --no-coverage
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/issue-triage/observations.ts __tests__/lib/issue-triage/observations.test.ts
git commit -m "feat: add recordObservation helper with tests"
```

---

### Task 5: Seed Initial SOP

**Files:**
- Create: `supabase/migrations/013_seed_initial_sop.sql`

- [ ] **Step 1: Write the seed migration**

This inserts the current hardcoded prompts as SOP v1. No behavior changes on day one.

```sql
-- supabase/migrations/013_seed_initial_sop.sql
INSERT INTO bot_sops (
  version,
  intake_prompt,
  escalation_rules,
  duplicate_thresholds,
  manual_directives,
  status,
  change_summary
) VALUES (
  1,
  'You are a technical support intake specialist for Viscap Media. Your job is to gather a complete bug report through friendly, natural conversation — one question at a time.

Rules:
1. Never ask more than one question per reply.
2. Early in the conversation, ask for the reporter''s email address and whether the affected user is themselves or someone else. If someone else, ask for that person''s email.
3. If the user appears blocked, search for a workaround before asking more questions.
4. Do not accept vague answers. Probe "I don''t know" answers gently before moving on.
5. Once all fields are filled with substantive answers, confirm the ticket is ready for the team.

Only set confidence >= 0.8 when every field has a specific, actionable answer, including both email addresses.

Respond with valid JSON only — no markdown, no explanation:
{
  "updated_schema": { ...complete ticket object matching the schema... },
  "bot_response": "The message to post in Slack",
  "confidence": 0.0
}',
  '{"maxTurns": 8, "disengagementThreshold": 2, "minConfidenceMovementPerTurn": 0.05}',
  '{"possible": 0.60, "confirmed": 0.85, "collisionWindowHours": 24, "collisionCount": 3}',
  '[]',
  'active',
  'Initial SOP seeded from hardcoded prompts'
);
```

- [ ] **Step 2: Apply migration**

```bash
npx supabase db push
```

Expected: seed row inserted. Verify with: `SELECT version, status FROM bot_sops;` — should show 1 row, `status = active`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/013_seed_initial_sop.sql
git commit -m "feat: seed initial SOP v1 from existing hardcoded prompts"
```

---

## PHASE B — Core Workflow

---

### Task 6: Media Handler

**Files:**
- Create: `lib/issue-triage/media.ts`
- Create: `__tests__/lib/issue-triage/media.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// __tests__/lib/issue-triage/media.test.ts
const mockCreate = jest.fn()

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}))

global.fetch = jest.fn()

describe('fetchSlackFile', () => {
  it('fetches a file using the bot token as Bearer auth', async () => {
    const fakeBuffer = Buffer.from('fake-image-data')
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      arrayBuffer: jest.fn().mockResolvedValue(fakeBuffer.buffer),
    })

    const { fetchSlackFile } = await import('@/lib/issue-triage/media')
    const result = await fetchSlackFile('https://files.slack.com/abc', 'xoxb-test')

    expect(global.fetch).toHaveBeenCalledWith('https://files.slack.com/abc', {
      headers: { Authorization: 'Bearer xoxb-test' },
    })
    expect(Buffer.isBuffer(result)).toBe(true)
  })

  it('throws when Slack returns a non-ok response', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 403 })
    const { fetchSlackFile } = await import('@/lib/issue-triage/media')
    await expect(fetchSlackFile('https://files.slack.com/abc', 'bad-token')).rejects.toThrow('Failed to fetch Slack file: 403')
  })
})

describe('generateVisualSummary', () => {
  beforeEach(() => mockCreate.mockReset())

  it('returns a one-line summary for image files', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'User clicking Export — progress bar stuck at 0%' }],
    })

    const { generateVisualSummary } = await import('@/lib/issue-triage/media')
    const result = await generateVisualSummary(
      Buffer.from('fake-png'),
      'image/png',
      'test-api-key'
    )

    expect(result).toBe('User clicking Export — progress bar stuck at 0%')
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-4-6' })
    )
  })

  it('returns null for non-image mimetypes', async () => {
    const { generateVisualSummary } = await import('@/lib/issue-triage/media')
    const result = await generateVisualSummary(Buffer.from('video'), 'video/quicktime', 'key')
    expect(result).toBeNull()
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx jest __tests__/lib/issue-triage/media.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/issue-triage/media'`

- [ ] **Step 3: Implement the media handler**

```typescript
// lib/issue-triage/media.ts
import Anthropic from '@anthropic-ai/sdk'

export interface SlackFile {
  id: string
  name: string
  url_private: string
  mimetype: string
}

export async function fetchSlackFile(fileUrl: string, botToken: string): Promise<Buffer> {
  const res = await fetch(fileUrl, {
    headers: { Authorization: `Bearer ${botToken}` },
  })
  if (!res.ok) throw new Error(`Failed to fetch Slack file: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

export async function uploadToClickUp(
  taskId: string,
  token: string,
  filename: string,
  data: Buffer,
  mimeType: string,
): Promise<string> {
  const formData = new FormData()
  formData.append('attachment', new Blob([data], { type: mimeType }), filename)

  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/attachment`, {
    method: 'POST',
    headers: { Authorization: token },
    body: formData,
  })
  if (!res.ok) throw new Error(`ClickUp upload failed: ${res.status}`)
  const json = (await res.json()) as { url: string }
  return json.url
}

export async function generateVisualSummary(
  imageData: Buffer,
  mimeType: string,
  apiKey: string,
): Promise<string | null> {
  if (!mimeType.startsWith('image/')) return null

  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: imageData.toString('base64'),
            },
          },
          {
            type: 'text',
            text: 'Describe what the user is doing and what problem is visible in one sentence. Be specific about UI elements and error states.',
          },
        ],
      },
    ],
  })

  return response.content.find((b) => b.type === 'text')?.text ?? null
}
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
npx jest __tests__/lib/issue-triage/media.test.ts --no-coverage
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/issue-triage/media.ts __tests__/lib/issue-triage/media.test.ts
git commit -m "feat: add media handler — Slack file fetch, ClickUp upload, Claude visual triage"
```

---

### Task 7: Update conversation.ts to Read SOP

**Files:**
- Modify: `lib/issue-triage/conversation.ts`
- Modify: `__tests__/lib/issue-triage/conversation.test.ts`

- [ ] **Step 1: Update the test to mock `getActiveSop`**

Add this mock to the top of `__tests__/lib/issue-triage/conversation.test.ts`, after existing imports:

```typescript
import type { BotSop } from '@/lib/issue-triage/types'

const fakeSop: BotSop = {
  id: 'sop-1',
  version: 1,
  intake_prompt: 'You are a helpful bot. Respond with valid JSON only:\n{"updated_schema":{},"bot_response":"","confidence":0.0}',
  escalation_rules: { maxTurns: 8, disengagementThreshold: 2, minConfidenceMovementPerTurn: 0.05 },
  duplicate_thresholds: { possible: 0.60, confirmed: 0.85, collisionWindowHours: 24, collisionCount: 3 },
  manual_directives: [],
  status: 'active',
  change_summary: null,
  approved_by: null,
  approved_at: null,
  created_at: new Date().toISOString(),
}

jest.mock('@/lib/issue-triage/sop', () => ({
  getActiveSop: jest.fn().mockResolvedValue(fakeSop),
}))
```

- [ ] **Step 2: Run existing tests to confirm they still pass before changes**

```bash
npx jest __tests__/lib/issue-triage/conversation.test.ts --no-coverage
```

Expected: PASS (mock is now in place but nothing changed yet)

- [ ] **Step 3: Rewrite `lib/issue-triage/conversation.ts`**

Replace the entire file:

```typescript
// lib/issue-triage/conversation.ts
import Anthropic from '@anthropic-ai/sdk'
import { getActiveSop } from './sop'
import type { SlackIssue, IntakeClaudeResponse, TicketData, BotSop } from './types'
import type { SlackMessage } from '@/lib/slack/client'

const TICKET_SCHEMA: TicketData = {
  issue_summary: '',
  reporter_email: '',
  affected_user_email: '',
  is_blocked: null,
  environment: { platform: '', brand: '', storyboard: '' },
  urls: [],
  reproduction_steps: [],
  expected_result: '',
  actual_result: '',
  last_occurred_at: '',
  is_repeat_issue: null,
  workaround_provided: null,
  documentation_gap: false,
}

function buildSystemPrompt(sop: BotSop): string {
  const directives = sop.manual_directives
    .map((d) => {
      if (d.trigger === 'always') return `ALWAYS: ${d.action}`
      if (d.trigger === 'contains_word') return `IF message contains "${d.value}": ${d.action}`
      return d.action
    })
    .join('\n')

  const directivesBlock = directives
    ? `\n\nMANDATORY RULES (cannot be overridden):\n${directives}`
    : ''

  return sop.intake_prompt + directivesBlock
}

function formatHistory(messages: SlackMessage[]): string {
  return messages
    .map((m) => `${m.bot_id ? '[BOT]' : '[USER]'}: ${m.text}`)
    .join('\n')
}

function parseClaudeJson(text: string): IntakeClaudeResponse {
  try {
    return JSON.parse(text) as IntakeClaudeResponse
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) {
      try { return JSON.parse(match[1].trim()) as IntakeClaudeResponse } catch { /* fall through */ }
    }
    throw new Error(`Intake Claude returned non-JSON output. First 300 chars: ${text.slice(0, 300)}`)
  }
}

export async function runIntakeTurn(
  issue: SlackIssue,
  userMessage: string,
  history: SlackMessage[],
): Promise<IntakeClaudeResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const sop = await getActiveSop()
  const client = new Anthropic({ apiKey })

  const userTurn = [
    `Ticket schema: ${JSON.stringify(TICKET_SCHEMA)}`,
    `Current ticket data: ${JSON.stringify(issue.ticket_data)}`,
    `Conversation history:\n${formatHistory(history)}`,
    `Latest message: ${userMessage}`,
  ].join('\n\n')

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: buildSystemPrompt(sop),
    messages: [{ role: 'user', content: userTurn }],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  return parseClaudeJson(text)
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx jest __tests__/lib/issue-triage/conversation.test.ts --no-coverage
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/issue-triage/conversation.ts __tests__/lib/issue-triage/conversation.test.ts
git commit -m "feat: conversation reads SOP + manual_directives from Supabase at runtime"
```

---

### Task 8: Update duplicate-detection.ts

**Files:**
- Modify: `lib/issue-triage/duplicate-detection.ts`

Key changes: read `duplicate_thresholds` from active SOP; add urgency collision check (3+ reporters of the same parent in 24h).

- [ ] **Step 1: Replace `lib/issue-triage/duplicate-detection.ts`**

```typescript
// lib/issue-triage/duplicate-detection.ts
import Anthropic from '@anthropic-ai/sdk'
import { buildClickUpClient } from '@/lib/clickup/client'
import { getActiveSop } from './sop'
import type { TicketData, TriageClaudeResponse } from './types'

const TRIAGE_SYSTEM_PROMPT = `You are a triage engine. Given a completed bug report and a list of active ClickUp tasks, determine if the bug has already been reported.

Duplicate rules:
- confidence >= confirmed_threshold: this IS a duplicate — set duplicate_task_id to the matching task's ClickUp ID
- possible_threshold–confirmed_threshold: related but distinct — set duplicate_task_id to null, note in routing_reasoning
- < possible_threshold: unrelated — set duplicate_task_id to null

Respond with valid JSON only — no markdown, no explanation:
{
  "duplicate_task_id": "string | null",
  "duplicate_confidence": 0.0,
  "workaround_found": false,
  "workaround_text": null,
  "has_user_facing_docs": false,
  "documentation_gap": false,
  "routing_decision": "known_issues | needs_tutorial | new_tickets_with_workaround | escalate_to_michael",
  "routing_reasoning": "One sentence"
}`

function formatTaskList(tasks: Array<{ id: string; name: string; description: string | null }>): string {
  if (tasks.length === 0) return 'No active tasks found.'
  return tasks.map((t) => `[${t.id}] ${t.name}\n${t.description ?? '(no description)'}`).join('\n\n---\n\n')
}

function parseTriageJson(text: string): TriageClaudeResponse {
  try {
    return JSON.parse(text) as TriageClaudeResponse
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) return JSON.parse(match[1].trim()) as TriageClaudeResponse
    throw new Error(`Triage Claude returned non-JSON output. First 300 chars: ${text.slice(0, 300)}`)
  }
}

export async function detectDuplicate(ticketData: TicketData): Promise<TriageClaudeResponse> {
  const token = process.env.CLICKUP_BOT_TOKEN
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!token) throw new Error('CLICKUP_BOT_TOKEN is not set')
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const sop = await getActiveSop()
  const { possible, confirmed } = sop.duplicate_thresholds

  const listIds = [
    process.env.CLICKUP_NEW_TICKETS_LIST_ID,
    process.env.CLICKUP_KNOWN_ISSUES_LIST_ID,
    process.env.CLICKUP_NEEDS_TUTORIAL_LIST_ID,
    process.env.CLICKUP_PLANNING_LIST_ID,
  ].filter(Boolean) as string[]

  const client = buildClickUpClient(token)
  const taskArrays = await Promise.all(
    listIds.map((listId) => client.getTasks(listId).catch(() => []))
  )
  const allTasks = taskArrays.flat().map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
  }))

  const anthropic = new Anthropic({ apiKey })
  const userTurn = [
    `Possible threshold: ${possible}, Confirmed threshold: ${confirmed}`,
    `Completed ticket:\n${JSON.stringify(ticketData)}`,
    `Active ClickUp tasks (all lists):\n${formatTaskList(allTasks)}`,
  ].join('\n\n')

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: TRIAGE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userTurn }],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  return parseTriageJson(text)
}

/**
 * Check if a parent task has had N+ reporters in the last windowHours.
 * Returns true if the urgency collision threshold is met.
 */
export async function checkUrgencyCollision(
  parentTaskId: string,
  supabase: Awaited<ReturnType<typeof import('@/lib/supabase/server').getSupabaseServiceClient>>,
): Promise<boolean> {
  const sop = await getActiveSop()
  const { collisionWindowHours, collisionCount } = sop.duplicate_thresholds
  const windowStart = new Date(Date.now() - collisionWindowHours * 60 * 60 * 1000).toISOString()

  const { data } = await supabase
    .from('bot_observations')
    .select('id')
    .eq('event_type', 'duplicate_confirmed')
    .gte('created_at', windowStart)
    .filter('payload->>parentTaskId', 'eq', parentTaskId)

  return (data?.length ?? 0) >= collisionCount - 1 // -1 because current reporter hasn't been recorded yet
}
```

- [ ] **Step 2: Run full test suite to check no regressions**

```bash
npx jest --no-coverage
```

Expected: all existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add lib/issue-triage/duplicate-detection.ts
git commit -m "feat: duplicate detection reads thresholds from active SOP; add urgency collision check"
```

---

### Task 9: Simplify router.ts

**Files:**
- Modify: `lib/issue-triage/router.ts`

Removes list routing (ticket stays in New Tickets). Adds `appendToParentTicket` export for confirmed duplicates.

- [ ] **Step 1: Replace `lib/issue-triage/router.ts`**

```typescript
// lib/issue-triage/router.ts
import { buildClickUpClient } from '@/lib/clickup/client'
import { buildSlackClient } from '@/lib/slack/client'
import type { SlackIssue } from './types'

export function buildTaskDescription(issue: SlackIssue, visualSummary?: string | null): string {
  const t = issue.ticket_data
  const slackBase = process.env.SLACK_WORKSPACE_URL ?? 'https://slack.com'
  const threadUrl = `${slackBase}/archives/${issue.channel_id}/p${issue.thread_ts.replace('.', '')}`
  const originalMsgUrl = `${slackBase}/archives/${issue.channel_id}/p${issue.last_msg_ts?.replace('.', '') ?? issue.thread_ts.replace('.', '')}`

  return [
    visualSummary ? `**Visual summary:** ${visualSummary}` : '',
    `**Reporter:** ${t.reporter_email}`,
    `**Affected User:** ${t.affected_user_email}`,
    `**Platform:** ${t.environment.platform} | **Brand:** ${t.environment.brand} | **Storyboard:** ${t.environment.storyboard}`,
    '',
    `**Issue:** ${t.issue_summary}`,
    '',
    `**Reproduction Steps:**\n${t.reproduction_steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
    '',
    `**Expected:** ${t.expected_result}`,
    `**Actual:** ${t.actual_result}`,
    '',
    `**Last occurred:** ${t.last_occurred_at}`,
    t.urls.length > 0 ? `**URLs:** ${t.urls.join(', ')}` : '',
    `**Original Slack message:** ${originalMsgUrl}`,
    `**Slack thread:** ${threadUrl}`,
  ].filter(Boolean).join('\n')
}

/**
 * Create a new ClickUp task in the New Tickets list.
 * Returns the created task id and url.
 */
export async function createTicket(
  issue: SlackIssue,
  visualSummary?: string | null,
): Promise<{ id: string; url: string }> {
  const token = process.env.CLICKUP_BOT_TOKEN
  const listId = process.env.CLICKUP_NEW_TICKETS_LIST_ID
  if (!token) throw new Error('CLICKUP_BOT_TOKEN is not set')
  if (!listId) throw new Error('CLICKUP_NEW_TICKETS_LIST_ID is not set')

  const cu = buildClickUpClient(token)
  return cu.createTask(listId, {
    name: issue.ticket_data.issue_summary || 'New support ticket',
    description: buildTaskDescription(issue, visualSummary),
    priority: 3,
  })
}

/**
 * Update a ClickUp task description with enriched ticket data.
 */
export async function updateTicketDescription(
  taskId: string,
  issue: SlackIssue,
): Promise<void> {
  const token = process.env.CLICKUP_BOT_TOKEN
  if (!token) throw new Error('CLICKUP_BOT_TOKEN is not set')

  const cu = buildClickUpClient(token)
  await cu.updateTask(taskId, {
    description: buildTaskDescription(issue),
    name: issue.ticket_data.issue_summary || undefined,
  })
}

/**
 * Append reporter context as a new comment on a parent (duplicate) ClickUp task.
 */
export async function appendToParentTicket(
  parentTaskId: string,
  issue: SlackIssue,
  additionalText?: string,
): Promise<void> {
  const token = process.env.CLICKUP_BOT_TOKEN
  if (!token) throw new Error('CLICKUP_BOT_TOKEN is not set')

  const slackBase = process.env.SLACK_WORKSPACE_URL ?? 'https://slack.com'
  const threadUrl = `${slackBase}/archives/${issue.channel_id}/p${issue.thread_ts.replace('.', '')}`

  const comment = [
    `📌 Related report via Slack (thread: ${threadUrl})`,
    `Reporter: ${issue.ticket_data.reporter_email || issue.reporter_id}`,
    additionalText ?? '',
    issue.ticket_data.issue_summary ? `Summary: ${issue.ticket_data.issue_summary}` : '',
  ].filter(Boolean).join('\n')

  const cu = buildClickUpClient(token)
  await cu.createTaskComment(parentTaskId, comment)
}

/**
 * Bump an Urgent-colliding parent task and notify the PM channel.
 */
export async function notifyUrgencyCollision(
  parentTaskId: string,
  parentUrl: string,
  reporterCount: number,
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN
  const channel = process.env.SLACK_BOT_IMPROVEMENTS_CHANNEL_ID
  if (!token || !channel) return

  const slack = buildSlackClient(token)
  const cuToken = process.env.CLICKUP_BOT_TOKEN
  if (cuToken) {
    const cu = buildClickUpClient(cuToken)
    await cu.setTaskPriority(parentTaskId, 1) // 1 = Urgent
  }

  await slack.postMessage(
    channel,
    `🚨 ${reporterCount} reports of the same issue in the last 24 hours — priority elevated to Urgent: ${parentUrl}`,
  )
}
```

- [ ] **Step 2: Run full test suite**

```bash
npx jest --no-coverage
```

Expected: all tests pass. (If router tests exist and import removed functions, update them to import `createTicket` / `updateTicketDescription` / `appendToParentTicket`.)

- [ ] **Step 3: Commit**

```bash
git add lib/issue-triage/router.ts
git commit -m "feat: simplify router — create/update/append helpers; remove list routing"
```

---

### Task 10: Refactor Slack Webhook Route

**Files:**
- Modify: `app/api/webhooks/slack/route.ts`
- Modify: `__tests__/api/webhooks/slack.test.ts`

This is the largest change. The webhook now handles four payload types:
1. `url_verification` — unchanged
2. `event_callback` with `event.type === 'message'` — core flow
3. `event_callback` with `event.type === 'reaction_added'` — dev emoji feedback
4. `block_actions` (form-encoded) — reporter survey + SOP Approve/Reject

Requires new env var: `SLACK_BOT_USER_ID` (the bot's own Slack user ID, needed to filter reactions on bot messages). Find it at `api.slack.com/apps → Viscap Support B → Basic Information → App Credentials → Bot User ID`, or call `auth.test` with the bot token.

- [ ] **Step 1: Add env var to `.env.local` and `.env.local.example`**

In `.env.local`, add after `SLACK_WORKSPACE_URL`:
```
SLACK_BOT_USER_ID="U_BOT_USER_ID_FROM_SLACK"
```

In `.env.local.example`, add the same key with a comment:
```
# SLACK_BOT_USER_ID → api.slack.com/apps → Basic Information → App Credentials → Bot User ID
SLACK_BOT_USER_ID=
```

- [ ] **Step 2: Replace `app/api/webhooks/slack/route.ts`**

```typescript
// app/api/webhooks/slack/route.ts
import { NextRequest, NextResponse, after } from 'next/server'
import { verifySlackSignature } from '@/lib/slack/verify'
import { buildSlackClient } from '@/lib/slack/client'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { runIntakeTurn } from '@/lib/issue-triage/conversation'
import { detectDuplicate, checkUrgencyCollision } from '@/lib/issue-triage/duplicate-detection'
import { createTicket, updateTicketDescription, appendToParentTicket, notifyUrgencyCollision } from '@/lib/issue-triage/router'
import { recordObservation } from '@/lib/issue-triage/observations'
import { getActiveSop } from '@/lib/issue-triage/sop'
import { fetchSlackFile, uploadToClickUp, generateVisualSummary } from '@/lib/issue-triage/media'
import { EMPTY_TICKET_DATA } from '@/lib/issue-triage/types'
import type { SlackIssue } from '@/lib/issue-triage/types'

interface SlackFile {
  id: string
  name: string
  url_private: string
  mimetype: string
}

interface SlackEvent {
  type: string
  user?: string
  bot_id?: string
  subtype?: string
  channel: string
  text: string
  ts: string
  thread_ts?: string
  files?: SlackFile[]
}

interface SlackReactionEvent {
  type: 'reaction_added'
  user: string
  reaction: string
  item: { type: string; channel: string; ts: string }
  item_user: string
}

interface SlackPayload {
  type: string
  challenge?: string
  event?: SlackEvent | SlackReactionEvent
}

interface SlackBlockAction {
  type: 'block_actions'
  user: { id: string }
  actions: Array<{ action_id: string; value?: string }>
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const contentType = req.headers.get('content-type') ?? ''
  const rawBody = await req.text()

  // Block Kit interactive payloads are form-encoded
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(rawBody)
    const payloadStr = params.get('payload')
    if (!payloadStr) return NextResponse.json({ ok: true })

    const timestamp = req.headers.get('x-slack-request-timestamp') ?? ''
    const signature = req.headers.get('x-slack-signature') ?? ''
    if (!verifySlackSignature(rawBody, timestamp, signature, process.env.SLACK_SIGNING_SECRET ?? '')) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const action = JSON.parse(payloadStr) as SlackBlockAction
    if (action.type === 'block_actions') {
      after(async () => { await handleBlockAction(action) })
    }
    return NextResponse.json({ ok: true })
  }

  // JSON event callbacks
  let payload: SlackPayload
  try {
    payload = JSON.parse(rawBody) as SlackPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (payload.type === 'url_verification') {
    return NextResponse.json({ challenge: payload.challenge })
  }

  const timestamp = req.headers.get('x-slack-request-timestamp') ?? ''
  const signature = req.headers.get('x-slack-signature') ?? ''
  if (!verifySlackSignature(rawBody, timestamp, signature, process.env.SLACK_SIGNING_SECRET ?? '')) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const event = payload.event
  if (!event) return NextResponse.json({ ok: true })

  const issuesChannel = process.env.SLACK_ISSUES_CHANNEL_ID
  if (!issuesChannel) {
    console.error('[slack-webhook] SLACK_ISSUES_CHANNEL_ID is not set')
    return NextResponse.json({ ok: true })
  }

  // Reaction events
  if (event.type === 'reaction_added') {
    const re = event as SlackReactionEvent
    if (re.item.channel === issuesChannel) {
      after(async () => { await handleReaction(re) })
    }
    return NextResponse.json({ ok: true })
  }

  // Message events
  const msgEvent = event as SlackEvent
  if (msgEvent.bot_id || msgEvent.subtype === 'bot_message') return NextResponse.json({ ok: true })
  if (msgEvent.channel !== issuesChannel) return NextResponse.json({ ok: true })
  if (!msgEvent.user) return NextResponse.json({ ok: true })

  after(async () => {
    try { await processMessageEvent(msgEvent) } catch (err) {
      console.error('[slack-webhook] after() error:', err)
    }
  })

  return NextResponse.json({ ok: true })
}

async function processMessageEvent(event: SlackEvent): Promise<void> {
  const supabase = await getSupabaseServiceClient()
  const slack = buildSlackClient(process.env.SLACK_BOT_TOKEN ?? '')
  const threadTs = event.thread_ts ?? event.ts

  const { data: existing } = await supabase
    .from('slack_issues').select('*').eq('thread_ts', threadTs).single()
  const issue = existing as SlackIssue | null

  if (issue?.human_takeover) return

  // Passive mode: confirmed duplicate — append additional reporter input to parent
  if (issue?.status === 'passive') {
    if (event.user === issue.reporter_id && issue.clickup_task_id) {
      await appendToParentTicket(issue.clickup_task_id, issue, event.text)
    }
    return
  }

  // Team member message: triage feedback
  if (issue && event.user !== issue.reporter_id) {
    await handleTeamFeedback(issue, event, slack, supabase)
    return
  }

  // New thread: create ticket immediately
  if (!issue) {
    await handleNewIssue(event, slack, supabase)
    return
  }

  // Reporter follow-up in existing gathering thread
  if (issue.status === 'gathering') {
    await handleGathering(issue, event, slack, supabase)
  }
}

async function handleNewIssue(
  event: SlackEvent,
  slack: ReturnType<typeof buildSlackClient>,
  supabase: Awaited<ReturnType<typeof getSupabaseServiceClient>>,
): Promise<void> {
  const sop = await getActiveSop()
  const botToken = process.env.SLACK_BOT_TOKEN ?? ''
  const cuToken = process.env.CLICKUP_BOT_TOKEN ?? ''
  const apiKey = process.env.ANTHROPIC_API_KEY ?? ''
  const slackBase = process.env.SLACK_WORKSPACE_URL ?? 'https://slack.com'
  const originalMsgUrl = `${slackBase}/archives/${event.channel}/p${event.ts.replace('.', '')}`

  // Process any media attachments
  let visualSummary: string | null = null
  const mediaUrls: string[] = []

  if (event.files?.length && cuToken) {
    for (const file of event.files) {
      try {
        const data = await fetchSlackFile(file.url_private, botToken)
        if (!visualSummary && apiKey) {
          visualSummary = await generateVisualSummary(data, file.mimetype, apiKey)
        }
        // ClickUp task doesn't exist yet — we'll upload after task creation
        mediaUrls.push(file.url_private) // store for later upload
      } catch (err) {
        console.warn('[slack-webhook] media processing failed:', err)
      }
    }
  }

  // Seed ticket data with initial message
  const seedTicketData = {
    ...EMPTY_TICKET_DATA,
    issue_summary: event.text.slice(0, 200),
  }

  const newIssue: Omit<SlackIssue, 'created_at' | 'updated_at'> = {
    thread_ts: event.ts,
    channel_id: event.channel,
    reporter_id: event.user ?? '',
    status: 'gathering',
    ticket_data: seedTicketData,
    metadata: { logrocket_links: [], file_ids: [], vault_snippets_used: [], triage_reasoning: '' },
    human_takeover: false,
    clickup_task_id: null,
    last_msg_ts: event.ts,
    sop_version: sop.version,
  } as SlackIssue & { sop_version: number }

  const tempIssue: SlackIssue = {
    ...newIssue,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  // Create ClickUp ticket immediately
  const task = await createTicket(tempIssue, visualSummary)

  // Upload media to ClickUp now that we have the task ID
  if (event.files?.length && cuToken) {
    for (const file of event.files) {
      try {
        const data = await fetchSlackFile(file.url_private, botToken)
        await uploadToClickUp(task.id, cuToken, file.name, data, file.mimetype)
      } catch (err) {
        console.warn('[slack-webhook] ClickUp upload failed:', err)
      }
    }
  }

  // Persist to Supabase
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await supabase.from('slack_issues').insert({ ...newIssue, clickup_task_id: task.id } as any)

  const fullIssue: SlackIssue = { ...tempIssue, clickup_task_id: task.id }

  // Quick duplicate detection on initial message
  let dupStatus = '*No related tickets found at this time.*'
  let triageResult
  try {
    triageResult = await detectDuplicate(fullIssue.ticket_data)
    if (triageResult.duplicate_task_id) {
      dupStatus = `⚠️ Possible duplicate of <${triageResult.duplicate_task_id}|existing ticket> — monitoring as we learn more.`
    }
  } catch (err) {
    console.warn('[slack-webhook] initial triage failed:', err)
  }

  // Get first question from Claude
  let firstQuestion = 'Can you tell me a bit more about what happened?'
  try {
    const intakeResult = await runIntakeTurn(fullIssue, event.text, [])
    firstQuestion = intakeResult.bot_response
    await supabase.from('slack_issues')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update({ ticket_data: intakeResult.updated_schema as any, updated_at: new Date().toISOString() })
      .eq('thread_ts', event.ts)
  } catch (err) {
    console.warn('[slack-webhook] initial intake turn failed:', err)
  }

  // Post reply in thread
  await slack.postMessage(
    event.channel,
    `I've opened a ticket for you: <${task.url}|View in ClickUp>\n🔗 <${originalMsgUrl}|Original message>\n\n${dupStatus}\n\n${firstQuestion}`,
    event.ts,
  )

  await recordObservation(event.ts, task.id, sop.version, 'ticket_created', {
    initialTriageConfidence: triageResult?.duplicate_confidence ?? 0,
    possibleDuplicateId: triageResult?.duplicate_task_id ?? null,
    mediaPresent: (event.files?.length ?? 0) > 0,
  })
}

async function handleGathering(
  issue: SlackIssue,
  event: SlackEvent,
  slack: ReturnType<typeof buildSlackClient>,
  supabase: Awaited<ReturnType<typeof getSupabaseServiceClient>>,
): Promise<void> {
  const sop = await getActiveSop()
  const history = await slack.getThreadReplies(event.channel, issue.thread_ts).catch(() => [])
  const result = await runIntakeTurn(issue, event.text, history)

  // Update ClickUp ticket in real-time
  if (issue.clickup_task_id) {
    const updatedIssue = { ...issue, ticket_data: result.updated_schema }
    await updateTicketDescription(issue.clickup_task_id, updatedIssue).catch((err) =>
      console.warn('[slack-webhook] ClickUp update failed:', err)
    )
  }

  // Re-run duplicate detection
  let triageResult
  try {
    triageResult = await detectDuplicate(result.updated_schema)
  } catch (err) {
    console.warn('[slack-webhook] triage re-run failed:', err)
  }

  // Check escalation rules
  const turnCount = history.filter((m) => !m.bot_id).length
  const shouldEscalate =
    turnCount >= sop.escalation_rules.maxTurns ||
    (result.confidence < 0.1 && turnCount >= sop.escalation_rules.disengagementThreshold)

  let newStatus: SlackIssue['status'] = 'gathering'
  let botResponse = result.bot_response

  // Confirmed duplicate: shift to passive mode
  if (triageResult?.duplicate_task_id && triageResult.duplicate_confidence >= sop.duplicate_thresholds.confirmed) {
    newStatus = 'passive'
    const parentTask = await import('@/lib/clickup/client')
      .then(({ buildClickUpClient: bcc }) => bcc(process.env.CLICKUP_BOT_TOKEN ?? '').getTask(triageResult!.duplicate_task_id!))
      .catch(() => null)

    if (issue.clickup_task_id) {
      await appendToParentTicket(triageResult.duplicate_task_id, { ...issue, ticket_data: result.updated_schema }, event.text)
    }

    // Check urgency collision
    const isCollision = await checkUrgencyCollision(triageResult.duplicate_task_id, supabase)
    if (isCollision && parentTask) {
      await notifyUrgencyCollision(triageResult.duplicate_task_id, parentTask.url, sop.duplicate_thresholds.collisionCount)
      await recordObservation(issue.thread_ts, issue.clickup_task_id, sop.version, 'priority_bump', {
        parentTaskId: triageResult.duplicate_task_id,
        collisionCount: sop.duplicate_thresholds.collisionCount,
      })
    }

    botResponse = `This looks like a known issue. Here's the existing ticket: ${parentTask?.url ?? triageResult.duplicate_task_id}. Your context has been added as a comment.${triageResult.workaround_text ? `\n\nWorkaround: ${triageResult.workaround_text}` : ''}`

    await recordObservation(issue.thread_ts, issue.clickup_task_id, sop.version, 'duplicate_confirmed', {
      parentTaskId: triageResult.duplicate_task_id,
      confidence: triageResult.duplicate_confidence,
      turnCount,
    })
  } else if (shouldEscalate) {
    newStatus = 'complete'
    botResponse = "I don't have enough information to help you at this time — support will reach out within 24 hours."
    await recordObservation(issue.thread_ts, issue.clickup_task_id, sop.version, 'escalation_triggered', {
      turnCount,
      lastConfidence: result.confidence,
      reason: turnCount >= sop.escalation_rules.maxTurns ? 'max_turns' : 'low_confidence',
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await supabase.from('slack_issues').update({
    ticket_data: result.updated_schema as any,
    status: newStatus,
    last_msg_ts: event.ts,
    updated_at: new Date().toISOString(),
  }).eq('thread_ts', issue.thread_ts)

  await slack.postMessage(event.channel, botResponse, issue.thread_ts)

  if (newStatus === 'gathering') {
    await recordObservation(issue.thread_ts, issue.clickup_task_id, sop.version, 'enrichment_turn', {
      turnCount,
      confidenceDelta: result.confidence - (triageResult?.duplicate_confidence ?? 0),
      questionAsked: result.bot_response,
    })
  }
}

async function handleTeamFeedback(
  issue: SlackIssue,
  event: SlackEvent,
  slack: ReturnType<typeof buildSlackClient>,
  supabase: Awaited<ReturnType<typeof getSupabaseServiceClient>>,
): Promise<void> {
  const sop = await getActiveSop()
  const text = event.text.toLowerCase()

  // Detect duplicate dispute: "not a duplicate", "not related to", "wrong ticket"
  const isDuplicateDispute = /\b(not a duplicate|not related|wrong ticket|different issue)\b/.test(text)

  if (isDuplicateDispute) {
    await supabase.from('slack_issues')
      .update({ status: 'gathering', updated_at: new Date().toISOString() })
      .eq('thread_ts', issue.thread_ts)
    await slack.postMessage(event.channel, "Got it — removing the duplicate flag. I'll keep gathering information.", issue.thread_ts)
    await recordObservation(issue.thread_ts, issue.clickup_task_id, sop.version, 'duplicate_overridden', {
      overriddenBy: event.user,
    })
    return
  }

  // Generic team feedback acknowledgement
  await slack.postMessage(event.channel, "Thanks for the context — I've noted it.", issue.thread_ts)
  await recordObservation(issue.thread_ts, issue.clickup_task_id, sop.version, 'team_correction', {
    feedback: event.text,
    correctedBy: event.user,
  })
}

async function handleReaction(event: SlackReactionEvent): Promise<void> {
  const botUserId = process.env.SLACK_BOT_USER_ID
  if (!botUserId || event.item_user !== botUserId) return

  const SIGNAL_MAP: Record<string, string> = {
    'white_check_mark': 'positive',
    'warning': 'missed_detail',
    'x': 'misidentified',
  }
  const signal = SIGNAL_MAP[event.reaction]
  if (!signal) return

  const supabase = await getSupabaseServiceClient()
  const { data: issue } = await supabase
    .from('slack_issues').select('*')
    .eq('last_msg_ts', event.item.ts).single()
  if (!issue) return

  const sop = await getActiveSop()
  await recordObservation(
    (issue as SlackIssue).thread_ts,
    (issue as SlackIssue).clickup_task_id,
    sop.version,
    'human_feedback',
    { source: 'dev_team', signal, reaction: event.reaction, reactedBy: event.user },
  )
}

async function handleBlockAction(action: SlackBlockAction): Promise<void> {
  const actionId = action.actions[0]?.action_id
  const userId = action.user.id
  const sop = await getActiveSop()

  // Reporter survey feedback
  if (['survey_helpful', 'survey_neutral', 'survey_not_helpful'].includes(actionId)) {
    const sentimentMap: Record<string, string> = {
      survey_helpful: 'positive',
      survey_neutral: 'neutral',
      survey_not_helpful: 'negative',
    }
    const threadTs = action.actions[0]?.value ?? ''
    await recordObservation(threadTs, null, sop.version, 'human_feedback', {
      source: 'reporter',
      sentiment: sentimentMap[actionId],
      respondedBy: userId,
    })
    return
  }

  // SOP Approve/Reject
  if (actionId === 'sop_approve' || actionId === 'sop_reject') {
    const proposalId = action.actions[0]?.value
    if (!proposalId) return

    const supabase = await getSupabaseServiceClient()
    const slack = buildSlackClient(process.env.SLACK_BOT_TOKEN ?? '')
    const channel = process.env.SLACK_BOT_IMPROVEMENTS_CHANNEL_ID ?? ''

    if (actionId === 'sop_approve') {
      const { data: proposal } = await supabase.from('sop_proposals').select('*').eq('id', proposalId).single()
      if (!proposal) return

      // Archive current SOP
      await supabase.from('bot_sops').update({ status: 'archived' }).eq('status', 'active')

      // Apply proposed changes to create new SOP
      const changes = proposal.proposed_changes as Record<string, { old: unknown; new: unknown }>
      const newSopData: Record<string, unknown> = {
        version: sop.version + 1,
        intake_prompt: sop.intake_prompt,
        escalation_rules: sop.escalation_rules,
        duplicate_thresholds: sop.duplicate_thresholds,
        manual_directives: sop.manual_directives,
        status: 'active',
        change_summary: proposal.pattern_summary,
        approved_by: userId,
        approved_at: new Date().toISOString(),
      }
      for (const [key, change] of Object.entries(changes)) {
        newSopData[key] = change.new
      }
      await supabase.from('bot_sops').insert(newSopData)
      await supabase.from('sop_proposals').update({
        status: 'approved', resolved_by: userId, resolved_at: new Date().toISOString(),
      }).eq('id', proposalId)

      await slack.postMessage(channel, `✅ SOP v${sop.version + 1} is now active.`)
    } else {
      await supabase.from('sop_proposals').update({
        status: 'rejected', resolved_by: userId, resolved_at: new Date().toISOString(),
      }).eq('id', proposalId)
      await slack.postMessage(channel, `SOP proposal rejected. The current SOP remains active.`)
    }
  }
}
```

- [ ] **Step 3: Update `__tests__/api/webhooks/slack.test.ts`**

Replace the mock section at the top to match the new imports, then keep or replace existing tests:

```typescript
// Replace the mock block in __tests__/api/webhooks/slack.test.ts

process.env.SLACK_BOT_USER_ID = 'U_BOT'
process.env.SLACK_BOT_IMPROVEMENTS_CHANNEL_ID = 'C_IMPROVEMENTS'

jest.mock('@/lib/issue-triage/sop', () => ({
  getActiveSop: jest.fn().mockResolvedValue({
    version: 1,
    intake_prompt: 'You are a helpful bot.',
    escalation_rules: { maxTurns: 8, disengagementThreshold: 2, minConfidenceMovementPerTurn: 0.05 },
    duplicate_thresholds: { possible: 0.60, confirmed: 0.85, collisionWindowHours: 24, collisionCount: 3 },
    manual_directives: [],
  }),
}))

jest.mock('@/lib/issue-triage/observations', () => ({
  recordObservation: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/issue-triage/router', () => ({
  createTicket: jest.fn().mockResolvedValue({ id: 'task-123', url: 'https://app.clickup.com/t/task-123' }),
  updateTicketDescription: jest.fn().mockResolvedValue(undefined),
  appendToParentTicket: jest.fn().mockResolvedValue(undefined),
  notifyUrgencyCollision: jest.fn().mockResolvedValue(undefined),
  buildTaskDescription: jest.fn().mockReturnValue('description'),
}))

jest.mock('@/lib/issue-triage/media', () => ({
  fetchSlackFile: jest.fn().mockResolvedValue(Buffer.from('img')),
  uploadToClickUp: jest.fn().mockResolvedValue('https://cdn.clickup.com/attachment'),
  generateVisualSummary: jest.fn().mockResolvedValue(null),
}))

jest.mock('@/lib/issue-triage/duplicate-detection', () => ({
  detectDuplicate: jest.fn().mockResolvedValue({
    duplicate_task_id: null,
    duplicate_confidence: 0,
    routing_decision: 'escalate_to_michael',
  }),
  checkUrgencyCollision: jest.fn().mockResolvedValue(false),
}))
```

Add a key new test:

```typescript
it('creates a ClickUp ticket immediately on first message and posts link in thread', async () => {
  const { createTicket } = await import('@/lib/issue-triage/router')
  const { buildSlackClient } = await import('@/lib/slack/client')
  const postMessage = (buildSlackClient as jest.Mock)().postMessage

  const req = makeSlackRequest({
    type: 'event_callback',
    event: {
      type: 'message',
      user: 'U_REPORTER',
      channel: 'C_ISSUES',
      text: 'The export button is broken',
      ts: '111.001',
    },
  })

  const res = await POST(req)
  expect(res.status).toBe(200)
  expect(createTicket).toHaveBeenCalled()
  expect(postMessage).toHaveBeenCalledWith(
    'C_ISSUES',
    expect.stringContaining('View in ClickUp'),
    '111.001',
  )
})

it('does NOT silence bot when a non-reporter speaks in the thread', async () => {
  const { getSupabaseServiceClient } = await import('@/lib/supabase/server')
  const mockUpdate = jest.fn().mockReturnThis()
  ;(getSupabaseServiceClient as jest.Mock).mockResolvedValue({
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          thread_ts: '111.001', reporter_id: 'U_REPORTER', status: 'gathering',
          human_takeover: false, clickup_task_id: 'task-123', ticket_data: {},
          channel_id: 'C_ISSUES', last_msg_ts: '111.001', sop_version: 1,
        },
        error: null,
      }),
      update: mockUpdate,
      insert: jest.fn().mockResolvedValue({ error: null }),
    }),
  })

  const req = makeSlackRequest({
    type: 'event_callback',
    event: {
      type: 'message',
      user: 'U_TEAM_MEMBER', // not the reporter
      channel: 'C_ISSUES',
      text: 'Looking into this now',
      ts: '111.002',
      thread_ts: '111.001',
    },
  })

  await POST(req)

  // human_takeover must NOT have been set to true
  expect(mockUpdate).not.toHaveBeenCalledWith(
    expect.objectContaining({ human_takeover: true })
  )
})
```

- [ ] **Step 4: Run tests**

```bash
npx jest __tests__/api/webhooks/slack.test.ts --no-coverage
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/api/webhooks/slack/route.ts __tests__/api/webhooks/slack.test.ts .env.local .env.local.example
git commit -m "feat: refactor Slack webhook — create-first flow, team feedback, emoji reactions, block_actions"
```

---

### Task 11: Update ClickUp Webhook Handler

**Files:**
- Modify: `app/api/webhooks/clickup/route.ts`

Add a parallel check: if the task is tracked in `slack_issues`, trigger a handoff and post the reporter survey.

- [ ] **Step 1: Add handoff logic after the existing trigger queue section in `app/api/webhooks/clickup/route.ts`**

Find the line `return NextResponse.json({ ok: true })` at the end and replace the full file's end section (after `await supabase.from('trigger_queue').insert(triggers)`) with:

```typescript
  if (triggers.length > 0) {
    await supabase.from('trigger_queue').insert(triggers)
  }

  // Parallel: check if this task is tracked in slack_issues for bot handoff
  await handleSlackHandoff(event.taskId, supabase)

  return NextResponse.json({ ok: true })
}

async function handleSlackHandoff(
  clickupTaskId: string,
  supabase: Awaited<ReturnType<typeof import('@/lib/supabase/server').getSupabaseServiceClient>>,
): Promise<void> {
  const { data: slackIssue } = await supabase
    .from('slack_issues')
    .select('*')
    .eq('clickup_task_id', clickupTaskId)
    .single()

  if (!slackIssue || slackIssue.human_takeover) return

  await supabase.from('slack_issues').update({
    human_takeover: true,
    updated_at: new Date().toISOString(),
  }).eq('clickup_task_id', clickupTaskId)

  const token = process.env.SLACK_BOT_TOKEN
  if (!token) return

  const { buildSlackClient } = await import('@/lib/slack/client')
  const slack = buildSlackClient(token)

  // Post handoff message
  await slack.postMessage(
    slackIssue.channel_id,
    '✅ Dev team has claimed this ticket — handing off.',
    slackIssue.thread_ts,
  )

  // Post reporter feedback survey
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: slackIssue.channel_id,
      thread_ts: slackIssue.thread_ts,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'How helpful was the support bot during this process?' },
        },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: '🟢 Helpful' }, action_id: 'survey_helpful', value: slackIssue.thread_ts },
            { type: 'button', text: { type: 'plain_text', text: '🟡 Neutral' }, action_id: 'survey_neutral', value: slackIssue.thread_ts },
            { type: 'button', text: { type: 'plain_text', text: '🔴 Not Helpful' }, action_id: 'survey_not_helpful', value: slackIssue.thread_ts },
          ],
        },
      ],
    }),
  })
}
```

- [ ] **Step 2: Run full test suite**

```bash
npx jest --no-coverage
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add app/api/webhooks/clickup/route.ts
git commit -m "feat: ClickUp webhook triggers Slack handoff and reporter survey on task claim"
```

---

## PHASE C — Intelligence Layer

---

### Task 12: SOP Analysis Cron

**Files:**
- Create: `app/api/cron/sop-analysis/route.ts`
- Create: `__tests__/api/cron/sop-analysis.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/api/cron/sop-analysis.test.ts
import { GET } from '@/app/api/cron/sop-analysis/route'
import { NextRequest } from 'next/server'

process.env.VIDF_HOOK_API_KEY = 'test-hook-key'
process.env.ANTHROPIC_API_KEY = 'anth-test'
process.env.SLACK_BOT_TOKEN = 'xoxb-test'
process.env.SLACK_BOT_IMPROVEMENTS_CHANNEL_ID = 'C_IMPROVEMENTS'

const mockCreate = jest.fn()

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })),
}))

const mockFrom = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({ from: mockFrom }),
}))

jest.mock('@/lib/issue-triage/sop', () => ({
  getActiveSop: jest.fn().mockResolvedValue({
    version: 1,
    intake_prompt: 'You are a helpful bot.',
    escalation_rules: { maxTurns: 8, disengagementThreshold: 2, minConfidenceMovementPerTurn: 0.05 },
    duplicate_thresholds: { possible: 0.60, confirmed: 0.85, collisionWindowHours: 24, collisionCount: 3 },
    manual_directives: [],
  }),
}))

jest.mock('@/lib/slack/client', () => ({
  buildSlackClient: jest.fn().mockReturnValue({
    postMessage: jest.fn().mockResolvedValue('ts'),
  }),
}))

function makeRequest() {
  return new NextRequest('http://localhost/api/cron/sop-analysis', {
    headers: { authorization: 'Bearer test-hook-key' },
  })
}

describe('GET /api/cron/sop-analysis', () => {
  beforeEach(() => {
    mockCreate.mockReset()
    mockFrom.mockReset()
  })

  it('returns 401 when authorization header is missing', async () => {
    const req = new NextRequest('http://localhost/api/cron/sop-analysis')
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('returns 200 with no_patterns when insufficient data', async () => {
    mockFrom.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      then: jest.fn().mockResolvedValue({ data: [] }),
    })
    // Supabase chained calls for observations and proposals
    const chainMock = {
      select: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: [] }),
    }
    mockFrom.mockReturnValue(chainMock)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.result).toBe('no_patterns')
  })

  it('creates a proposal when Claude identifies a significant pattern', async () => {
    const observations = Array.from({ length: 15 }, (_, i) => ({
      id: `obs-${i}`,
      event_type: i % 3 === 0 ? 'duplicate_overridden' : 'enrichment_turn',
      payload: {},
      sop_version: 1,
      created_at: new Date().toISOString(),
    }))

    const chainMock = {
      select: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: observations }),
      insert: jest.fn().mockResolvedValue({ error: null }),
    }
    mockFrom.mockReturnValue(chainMock)

    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          has_significant_pattern: true,
          pattern_summary: 'Duplicate override rate is 33% — above 30% threshold',
          proposed_changes: {
            duplicate_thresholds: {
              old: { possible: 0.60, confirmed: 0.85 },
              new: { possible: 0.65, confirmed: 0.90 },
            },
          },
          expected_outcome: 'Fewer false positives',
          confidence: 0.72,
        }),
      }],
    })

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.result).toBe('proposal_created')
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx jest __tests__/api/cron/sop-analysis.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/app/api/cron/sop-analysis/route'`

- [ ] **Step 3: Implement the cron handler**

```typescript
// app/api/cron/sop-analysis/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { getActiveSop } from '@/lib/issue-triage/sop'
import { buildSlackClient } from '@/lib/slack/client'

const ANALYSIS_WINDOW_DAYS = 7
const MIN_OBSERVATIONS = 10
const SIGNIFICANCE_THRESHOLD = 0.30 // 30% anomaly rate

const ANALYSIS_PROMPT = `You are an SOP improvement analyst for a Slack support bot at Viscap Media.

Given a week of structured observations and the last 5 rejected proposals (so you don't repeat them), identify whether there is a significant pattern that warrants an SOP change.

A pattern is significant if it meets ALL of:
1. At least ${MIN_OBSERVATIONS} relevant observations
2. An anomaly rate > ${SIGNIFICANCE_THRESHOLD * 100}% (e.g., override_rate, disengagement_rate, misidentification_rate)
3. Not already proposed and rejected within the last 5 proposals without significantly more data

If significant: propose a specific, testable change to ONE section of the SOP (intake_prompt, escalation_rules, or duplicate_thresholds).
If not significant: respond with has_significant_pattern: false.

Respond with valid JSON only:
{
  "has_significant_pattern": true | false,
  "pattern_summary": "one sentence",
  "proposed_changes": { "sop_field": { "old": ..., "new": ... } },
  "expected_outcome": "one sentence",
  "confidence": 0.0
}`

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.VIDF_HOOK_API_KEY}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = await getSupabaseServiceClient()
  const sop = await getActiveSop()
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 })

  const windowStart = new Date(Date.now() - ANALYSIS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Fetch recent observations
  const { data: observations } = await supabase
    .from('bot_observations')
    .select('id, event_type, payload, sop_version, created_at')
    .gte('created_at', windowStart)
    .limit(500)

  if (!observations || observations.length < MIN_OBSERVATIONS) {
    return NextResponse.json({ result: 'no_patterns', reason: 'insufficient_data', count: observations?.length ?? 0 })
  }

  // Check for existing pending proposal (only one allowed at a time)
  const { data: pending } = await supabase
    .from('sop_proposals')
    .select('id')
    .eq('status', 'pending_review')
    .limit(1)

  if (pending?.length) {
    return NextResponse.json({ result: 'skipped', reason: 'proposal_already_pending' })
  }

  // Fetch last 5 rejected proposals for rejection memory
  const { data: rejectedProposals } = await supabase
    .from('sop_proposals')
    .select('pattern_summary, pm_response, created_at')
    .eq('status', 'rejected')
    .order('created_at', { ascending: false })
    .limit(5)

  // Summarise observations for Claude
  const eventCounts: Record<string, number> = {}
  for (const obs of observations) {
    eventCounts[obs.event_type] = (eventCounts[obs.event_type] ?? 0) + 1
  }

  const anthropic = new Anthropic({ apiKey })
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: ANALYSIS_PROMPT,
    messages: [{
      role: 'user',
      content: JSON.stringify({
        current_sop_version: sop.version,
        observation_window_days: ANALYSIS_WINDOW_DAYS,
        event_counts: eventCounts,
        total_observations: observations.length,
        last_5_rejections: rejectedProposals ?? [],
        current_escalation_rules: sop.escalation_rules,
        current_duplicate_thresholds: sop.duplicate_thresholds,
      }),
    }],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  let analysis: {
    has_significant_pattern: boolean
    pattern_summary?: string
    proposed_changes?: Record<string, unknown>
    expected_outcome?: string
    confidence?: number
  }

  try {
    analysis = JSON.parse(text)
  } catch {
    console.error('[sop-analysis] Claude returned non-JSON:', text.slice(0, 300))
    return NextResponse.json({ result: 'error', reason: 'claude_parse_failure' })
  }

  if (!analysis.has_significant_pattern) {
    return NextResponse.json({ result: 'no_patterns' })
  }

  // Create proposal
  const { data: proposal, error: insertError } = await supabase.from('sop_proposals').insert({
    sop_version: sop.version,
    proposed_changes: analysis.proposed_changes ?? {},
    pattern_summary: analysis.pattern_summary ?? '',
    supporting_data: { event_counts: eventCounts, total: observations.length },
    rejection_history: rejectedProposals ?? [],
    claude_confidence: analysis.confidence ?? 0,
    status: 'pending_review',
  }).select('id').single()

  if (insertError || !proposal) {
    console.error('[sop-analysis] proposal insert failed:', insertError)
    return NextResponse.json({ result: 'error', reason: 'insert_failed' })
  }

  // Notify PM channel
  const slackToken = process.env.SLACK_BOT_TOKEN
  const channel = process.env.SLACK_BOT_IMPROVEMENTS_CHANNEL_ID
  if (slackToken && channel) {
    const slack = buildSlackClient(slackToken)
    const priorRejectionsNote = rejectedProposals?.length
      ? `\nRejection history: ${rejectedProposals.length} prior rejection(s) consulted.`
      : '\nRejection history: No prior rejections on this pattern.'

    await slack.postMessage(
      channel,
      [
        `🤖 *SOP Improvement Proposal — v${sop.version} → v${sop.version + 1}*`,
        '',
        `*Pattern:* ${analysis.pattern_summary}${priorRejectionsNote}`,
        '',
        `*Proposed changes:* ${JSON.stringify(analysis.proposed_changes, null, 2)}`,
        '',
        `*Expected outcome:* ${analysis.expected_outcome}`,
        `*Confidence:* ${((analysis.confidence ?? 0) * 100).toFixed(0)}%`,
        '',
        `_(Reply with Approve or Reject — interactive buttons coming in Phase C UI)_`,
        `Proposal ID: \`${proposal.id}\``,
      ].join('\n'),
    )
  }

  return NextResponse.json({ result: 'proposal_created', proposalId: proposal.id })
}
```

- [ ] **Step 4: Register the cron in `vercel.json` (or `vercel.ts` if present)**

Check if `vercel.json` exists:

```bash
ls /Users/michaelterry/Development/ViscapMedia/pm-app/vercel.json 2>/dev/null || echo "not found"
```

If not found, create it:

```json
{
  "crons": [
    {
      "path": "/api/cron/sop-analysis",
      "schedule": "0 9 * * 1"
    }
  ]
}
```

This schedules the analysis every Monday at 9am UTC.

- [ ] **Step 5: Run tests**

```bash
npx jest __tests__/api/cron/sop-analysis.test.ts --no-coverage
```

Expected: PASS

- [ ] **Step 6: Run full test suite**

```bash
npx jest --no-coverage
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add app/api/cron/sop-analysis/route.ts __tests__/api/cron/sop-analysis.test.ts vercel.json
git commit -m "feat: add SOP analysis cron — weekly pattern detection, rejection memory, PM proposal via Slack"
```

---

## Slack App Configuration Required Before Testing

1. **Enable Interactivity & Shortcuts** at `api.slack.com/apps → Viscap Support B → Interactivity & Shortcuts`
   - Request URL: `https://viscap.edgefixautomation.com/api/webhooks/slack`

2. **Add `reactions:read` scope** at `OAuth & Permissions → Bot Token Scopes`

3. **Reinstall app to workspace** after scope change (button appears at top of OAuth & Permissions page)

4. **Add new env vars to Vercel dashboard** (Settings → Environment Variables):
   - `SLACK_BOT_USER_ID` — from Basic Information → App Credentials
   - `SLACK_BOT_IMPROVEMENTS_CHANNEL_ID` — channel ID of `#bot-improvements`

## Deployment Order

1. Deploy Phase A (migrate DB, add SOP seed) — verify SOP table has one active row
2. Deploy Phase B (workflow changes) — test end-to-end with a message in the issues channel
3. Deploy Phase C (analysis cron) — manually trigger `GET /api/cron/sop-analysis` with the VIDF key to verify it runs

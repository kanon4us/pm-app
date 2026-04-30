# Slack Support Intake & Triage System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an automated Slack bot that conducts structured multi-turn bug intake conversations and routes finished tickets to ClickUp via duplicate detection and vault workaround search.

**Architecture:** A Slack Events API webhook at `/api/webhooks/slack` immediately ACKs Slack then hands all processing to Next.js `after()`. Conversation state lives in a new `slack_issues` Supabase table keyed by `thread_ts`. Claude drives both phases: the multi-turn intake conversation (structured JSON output) and the one-shot triage decision after user confirmation.

**Tech Stack:** Next.js 16 `after()`, Anthropic SDK 0.82 (`claude-opus-4-6`), Supabase service client, ClickUp REST API (existing client extended), GitHub Code Search (`searchVault`), Slack Web API (thin fetch wrapper), Jest/ts-jest.

**Spec:** `docs/superpowers/specs/2026-04-28-slack-support-triage-design.md`

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `supabase/migrations/010_slack_issues.sql` | New table + enum + indexes |
| Create | `lib/issue-triage/types.ts` | Shared interfaces used across all triage files |
| Modify | `lib/clickup/client.ts` | Add `createTask`, `moveTask`, `setTaskPriority`; extend `ClickUpTask` with `priority` and `url` |
| Create | `lib/slack/verify.ts` | HMAC-SHA256 Slack signature verification |
| Create | `lib/slack/client.ts` | Thin Slack Web API wrapper: `postMessage`, `openDM`, `getThreadReplies` |
| Create | `lib/issue-triage/conversation.ts` | Intake phase: calls Claude, updates Supabase, posts next question to Slack |
| Create | `lib/issue-triage/duplicate-detection.ts` | Fetches all active ClickUp tasks, runs triage Claude prompt to find duplicates |
| Create | `lib/issue-triage/workaround-search.ts` | Calls `searchVault`, then Claude to rank results for user-facing workarounds |
| Create | `lib/issue-triage/router.ts` | Executes routing decision: creates/updates ClickUp task, posts final Slack message, DMs Michael |
| Create | `app/api/webhooks/slack/route.ts` | Slack webhook: sig verify, channel guard, bot-echo guard, `after()` dispatch |
| Create | `app/api/cron/slack-stale-check/route.ts` | Hourly cron: nudges stale gathering/confirming threads |
| Modify | `vercel.json` | Add hourly cron entry |
| Create | `__tests__/lib/slack/verify.test.ts` | Tests for signature verification |
| Create | `__tests__/lib/slack/client.test.ts` | Tests for Slack API wrapper |
| Create | `__tests__/lib/clickup/client-triage.test.ts` | Tests for new ClickUp methods |
| Create | `__tests__/lib/issue-triage/conversation.test.ts` | Tests for intake conversation logic |
| Create | `__tests__/lib/issue-triage/duplicate-detection.test.ts` | Tests for duplicate detection |
| Create | `__tests__/lib/issue-triage/workaround-search.test.ts` | Tests for workaround search |
| Create | `__tests__/lib/issue-triage/router.test.ts` | Tests for ticket routing |
| Create | `__tests__/api/webhooks/slack.test.ts` | Tests for webhook handler |
| Create | `__tests__/api/cron/slack-stale-check.test.ts` | Tests for cron handler |

---

## Task 1: Supabase Migration

**Files:**
- Create: `supabase/migrations/010_slack_issues.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/010_slack_issues.sql
CREATE TYPE slack_issue_status AS ENUM (
  'gathering',
  'confirming',
  'triaging',
  'complete',
  'human_takeover'
);

CREATE TABLE slack_issues (
  thread_ts        TEXT PRIMARY KEY,
  channel_id       TEXT NOT NULL,
  reporter_id      TEXT NOT NULL,
  status           slack_issue_status NOT NULL DEFAULT 'gathering',
  ticket_data      JSONB NOT NULL DEFAULT '{}',
  metadata         JSONB NOT NULL DEFAULT '{}',
  human_takeover   BOOLEAN NOT NULL DEFAULT FALSE,
  clickup_task_id  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_msg_ts      TEXT
);

CREATE INDEX idx_slack_issues_status     ON slack_issues(status);
CREATE INDEX idx_slack_issues_updated_at ON slack_issues(updated_at);
```

- [ ] **Step 2: Apply the migration**

```bash
npx supabase db push
```

Expected: migration applied with no errors. Verify in Supabase Studio that `slack_issues` table and `slack_issue_status` enum exist.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/010_slack_issues.sql
git commit -m "feat: add slack_issues table for support triage state"
```

---

## Task 2: Shared Types

**Files:**
- Create: `lib/issue-triage/types.ts`

No unit test needed — pure TypeScript interfaces. Correctness is enforced by the compiler in later tasks.

- [ ] **Step 1: Create types file**

```typescript
// lib/issue-triage/types.ts

export interface TicketEnvironment {
  platform: string
  brand: string
  storyboard: string
}

export interface TicketData {
  issue_summary: string
  reporter_email: string
  affected_user_email: string
  is_blocked: boolean | null
  environment: TicketEnvironment
  urls: string[]
  reproduction_steps: string[]
  expected_result: string
  actual_result: string
  last_occurred_at: string
  is_repeat_issue: boolean | null
  workaround_provided: string | null
  documentation_gap: boolean
}

export const EMPTY_TICKET_DATA: TicketData = {
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

export type SlackIssueStatus =
  | 'gathering'
  | 'confirming'
  | 'triaging'
  | 'complete'
  | 'human_takeover'

export interface SlackIssueMetadata {
  logrocket_links: string[]
  file_ids: string[]
  vault_snippets_used: string[]
  triage_reasoning: string
}

export interface SlackIssue {
  thread_ts: string
  channel_id: string
  reporter_id: string
  status: SlackIssueStatus
  ticket_data: TicketData
  metadata: SlackIssueMetadata
  human_takeover: boolean
  clickup_task_id: string | null
  created_at: string
  updated_at: string
  last_msg_ts: string | null
}

export interface IntakeClaudeResponse {
  updated_schema: TicketData
  bot_response: string
  confidence: number
}

export type RoutingDecision =
  | 'known_issues'
  | 'needs_tutorial'
  | 'new_tickets_with_workaround'
  | 'escalate_to_michael'

export interface TriageClaudeResponse {
  duplicate_task_id: string | null
  duplicate_confidence: number
  workaround_found: boolean
  workaround_text: string | null
  has_user_facing_docs: boolean
  documentation_gap: boolean
  routing_decision: RoutingDecision
  routing_reasoning: string
}
```

- [ ] **Step 2: Confirm TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/issue-triage/types.ts
git commit -m "feat: add shared types for issue triage pipeline"
```

---

## Task 3: ClickUp Client Extensions

**Files:**
- Modify: `lib/clickup/client.ts`
- Create: `__tests__/lib/clickup/client-triage.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// __tests__/lib/clickup/client-triage.test.ts
import { buildClickUpClient } from '@/lib/clickup/client'

const TOKEN = 'test-token'

describe('buildClickUpClient — triage extensions', () => {
  beforeEach(() => {
    global.fetch = jest.fn()
  })

  describe('createTask', () => {
    it('POSTs to /list/{listId}/task and returns id + url', async () => {
      const mockTask = { id: 'task-abc', url: 'https://app.clickup.com/t/task-abc' }
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => mockTask,
        text: async () => '',
      })

      const client = buildClickUpClient(TOKEN)
      const result = await client.createTask('list-123', {
        name: 'CMS crash on save',
        description: 'Detailed bug description',
        priority: 2,
      })

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/list/list-123/task'),
        expect.objectContaining({ method: 'POST' })
      )
      expect(result).toEqual({ id: 'task-abc', url: 'https://app.clickup.com/t/task-abc' })
    })

    it('throws on non-ok response', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
      })
      const client = buildClickUpClient(TOKEN)
      await expect(
        client.createTask('list-123', { name: 'Test', description: '', priority: 3 })
      ).rejects.toThrow('ClickUp API error: 400')
    })
  })

  describe('setTaskPriority', () => {
    it('PUTs to /task/{taskId} with priority in body', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'task-abc' }),
        text: async () => '',
      })

      const client = buildClickUpClient(TOKEN)
      await client.setTaskPriority('task-abc', 1)

      const [url, opts] = (global.fetch as jest.Mock).mock.calls[0]
      expect(url).toContain('/task/task-abc')
      expect(JSON.parse(opts.body)).toMatchObject({ priority: 1 })
    })
  })

  describe('moveTask', () => {
    it('PUTs to /task/{taskId} with list_id in body', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'task-abc' }),
        text: async () => '',
      })

      const client = buildClickUpClient(TOKEN)
      await client.moveTask('task-abc', 'list-dest')

      const [url, opts] = (global.fetch as jest.Mock).mock.calls[0]
      expect(url).toContain('/task/task-abc')
      expect(JSON.parse(opts.body)).toMatchObject({ list_id: 'list-dest' })
    })
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx jest __tests__/lib/clickup/client-triage.test.ts --no-coverage
```

Expected: FAIL — `client.createTask is not a function`, `client.setTaskPriority is not a function`, `client.moveTask is not a function`.

- [ ] **Step 3: Extend `ClickUpTask` interface and add three methods to `lib/clickup/client.ts`**

Add `priority` and `url` to the existing `ClickUpTask` interface:

```typescript
export interface ClickUpTask {
  id: string
  name: string
  description: string | null
  status: { status: string }
  priority: { id: '1' | '2' | '3' | '4'; priority: string } | null
  url: string
  custom_fields: Array<{ id: string; name: string; value: unknown }>
  list: { id: string; name: string }
}
```

Add these three methods inside the `buildClickUpClient` return object (after `deleteWebhook`):

```typescript
    createTask: (listId: string, fields: {
      name: string
      description: string
      priority: 1 | 2 | 3 | 4
    }) =>
      clickupFetch<{ id: string; url: string }>(token, `/list/${listId}/task`, {
        method: 'POST',
        body: JSON.stringify(fields),
      }),

    setTaskPriority: (taskId: string, priority: 1 | 2 | 3 | 4) =>
      clickupFetch<ClickUpTask>(token, `/task/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify({ priority }),
      }),

    // Note: ClickUp v2 accepts list_id in PUT body to move a task to another list.
    // Verify against https://clickup.com/api if this endpoint changes.
    moveTask: (taskId: string, listId: string) =>
      clickupFetch<ClickUpTask>(token, `/task/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify({ list_id: listId }),
      }),
```

- [ ] **Step 4: Run tests to confirm passing**

```bash
npx jest __tests__/lib/clickup/client-triage.test.ts --no-coverage
```

Expected: PASS (3 describe blocks, 4 tests).

- [ ] **Step 5: Confirm no regressions**

```bash
npx jest __tests__/lib/clickup/ --no-coverage
```

Expected: all existing ClickUp tests still pass.

- [ ] **Step 6: Commit**

```bash
git add lib/clickup/client.ts __tests__/lib/clickup/client-triage.test.ts
git commit -m "feat: extend ClickUp client with createTask, moveTask, setTaskPriority"
```

---

## Task 4: Slack Signature Verification

**Files:**
- Create: `lib/slack/verify.ts`
- Create: `__tests__/lib/slack/verify.test.ts`

Slack's signing process: `HMAC-SHA256("v0:{timestamp}:{rawBody}", signingSecret)`, then prefix `v0=`. Also reject timestamps older than 5 minutes (replay attack prevention).

- [ ] **Step 1: Write failing tests**

```typescript
// __tests__/lib/slack/verify.test.ts
import crypto from 'crypto'
import { verifySlackSignature } from '@/lib/slack/verify'

const SECRET = 'test-signing-secret'

function makeSignature(timestamp: string, body: string): string {
  const base = `v0:${timestamp}:${body}`
  return 'v0=' + crypto.createHmac('sha256', SECRET).update(base).digest('hex')
}

describe('verifySlackSignature', () => {
  it('returns true for a valid signature with current timestamp', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const body = '{"type":"event_callback"}'
    expect(verifySlackSignature(body, ts, makeSignature(ts, body), SECRET)).toBe(true)
  })

  it('returns false for a tampered body', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const body = '{"type":"event_callback"}'
    const sig = makeSignature(ts, body)
    expect(verifySlackSignature('{"type":"tampered"}', ts, sig, SECRET)).toBe(false)
  })

  it('returns false for a signature older than 5 minutes', () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 400)
    const body = '{"type":"event_callback"}'
    const sig = makeSignature(staleTs, body)
    expect(verifySlackSignature(body, staleTs, sig, SECRET)).toBe(false)
  })

  it('returns false for a wrong secret', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const body = '{"type":"event_callback"}'
    const sig = makeSignature(ts, body)
    expect(verifySlackSignature(body, ts, sig, 'wrong-secret')).toBe(false)
  })

  it('returns false when signature length mismatches', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    expect(verifySlackSignature('body', ts, 'v0=short', SECRET)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx jest __tests__/lib/slack/verify.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/slack/verify'`.

- [ ] **Step 3: Create `lib/slack/verify.ts`**

```typescript
// lib/slack/verify.ts
import crypto from 'crypto'

/**
 * Verify that an incoming Slack webhook request is authentic.
 * Rejects requests with timestamps older than 5 minutes (replay attack prevention).
 *
 * @param rawBody    Raw request body string (before JSON.parse)
 * @param timestamp  Value of X-Slack-Request-Timestamp header
 * @param signature  Value of X-Slack-Signature header (starts with "v0=")
 * @param signingSecret  SLACK_SIGNING_SECRET env var
 */
export function verifySlackSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  signingSecret: string,
): boolean {
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false

  const baseString = `v0:${timestamp}:${rawBody}`
  const expected = 'v0=' + crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex')

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run tests to confirm passing**

```bash
npx jest __tests__/lib/slack/verify.test.ts --no-coverage
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/slack/verify.ts __tests__/lib/slack/verify.test.ts
git commit -m "feat: add Slack webhook signature verification"
```

---

## Task 5: Slack Client

**Files:**
- Create: `lib/slack/client.ts`
- Create: `__tests__/lib/slack/client.test.ts`

Thin `fetch`-based wrapper matching the ClickUp client pattern. No third-party SDK.

- [ ] **Step 1: Write failing tests**

```typescript
// __tests__/lib/slack/client.test.ts
import { buildSlackClient } from '@/lib/slack/client'

const TOKEN = 'xoxb-test-token'

describe('buildSlackClient', () => {
  beforeEach(() => { global.fetch = jest.fn() })

  describe('postMessage', () => {
    it('posts to chat.postMessage and returns message ts', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, ts: '1234567890.000100' }),
      })

      const client = buildSlackClient(TOKEN)
      const ts = await client.postMessage('C123', 'Hello!')

      const [url, opts] = (global.fetch as jest.Mock).mock.calls[0]
      expect(url).toContain('chat.postMessage')
      expect(JSON.parse(opts.body)).toMatchObject({ channel: 'C123', text: 'Hello!' })
      expect(ts).toBe('1234567890.000100')
    })

    it('posts with thread_ts when provided', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, ts: '1234567890.000200' }),
      })

      const client = buildSlackClient(TOKEN)
      await client.postMessage('C123', 'Reply!', '1234567890.000100')

      const [, opts] = (global.fetch as jest.Mock).mock.calls[0]
      expect(JSON.parse(opts.body)).toMatchObject({ thread_ts: '1234567890.000100' })
    })

    it('throws when Slack returns ok: false', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, error: 'channel_not_found' }),
      })

      const client = buildSlackClient(TOKEN)
      await expect(client.postMessage('C_BAD', 'Hi')).rejects.toThrow('channel_not_found')
    })
  })

  describe('openDM', () => {
    it('opens a DM channel and returns the channel id', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, channel: { id: 'D_MICHAEL' } }),
      })

      const client = buildSlackClient(TOKEN)
      const channelId = await client.openDM('U_MICHAEL')

      expect(channelId).toBe('D_MICHAEL')
      const [, opts] = (global.fetch as jest.Mock).mock.calls[0]
      expect(JSON.parse(opts.body)).toMatchObject({ users: 'U_MICHAEL' })
    })
  })

  describe('getThreadReplies', () => {
    it('fetches thread replies and returns messages array', async () => {
      const messages = [
        { user: 'U001', text: 'CMS crashed', ts: '1234567890.000001' },
        { bot_id: 'B001', text: 'Tell me more', ts: '1234567890.000002' },
      ]
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, messages }),
      })

      const client = buildSlackClient(TOKEN)
      const result = await client.getThreadReplies('C123', '1234567890.000001')

      expect(result).toEqual(messages)
      const [url] = (global.fetch as jest.Mock).mock.calls[0]
      expect(url).toContain('conversations.replies')
    })
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx jest __tests__/lib/slack/client.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/slack/client'`.

- [ ] **Step 3: Create `lib/slack/client.ts`**

```typescript
// lib/slack/client.ts

const SLACK_BASE = 'https://slack.com/api'

export interface SlackMessage {
  user?: string
  bot_id?: string
  text: string
  ts: string
}

async function slackFetch<T>(token: string, method: string, body: object): Promise<T> {
  const res = await fetch(`${SLACK_BASE}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as { ok: boolean; error?: string } & T
  if (!json.ok) throw new Error(json.error ?? `Slack API error on ${method}`)
  return json
}

export function buildSlackClient(token: string) {
  return {
    /** Post a message to a channel, optionally as a thread reply. Returns the new message ts. */
    postMessage: async (channel: string, text: string, threadTs?: string): Promise<string> => {
      const payload: Record<string, string> = { channel, text }
      if (threadTs) payload.thread_ts = threadTs
      const res = await slackFetch<{ ts: string }>(token, 'chat.postMessage', payload)
      return res.ts
    },

    /** Open a DM channel with a user and return the channel ID. */
    openDM: async (userId: string): Promise<string> => {
      const res = await slackFetch<{ channel: { id: string } }>(
        token,
        'conversations.open',
        { users: userId },
      )
      return res.channel.id
    },

    /** Fetch all replies in a thread. Returns the full messages array (index 0 is the parent). */
    getThreadReplies: async (channel: string, threadTs: string): Promise<SlackMessage[]> => {
      const res = await slackFetch<{ messages: SlackMessage[] }>(
        token,
        'conversations.replies',
        { channel, ts: threadTs },
      )
      return res.messages
    },
  }
}
```

- [ ] **Step 4: Run tests to confirm passing**

```bash
npx jest __tests__/lib/slack/client.test.ts --no-coverage
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/slack/client.ts __tests__/lib/slack/client.test.ts
git commit -m "feat: add Slack API client (postMessage, openDM, getThreadReplies)"
```

---

## Task 6: Intake Conversation

**Files:**
- Create: `lib/issue-triage/conversation.ts`
- Create: `__tests__/lib/issue-triage/conversation.test.ts`

This module takes the current `SlackIssue` state and a new user message, calls Claude with the intake prompt, updates Supabase, and posts the bot reply to Slack. It returns the updated issue record.

- [ ] **Step 1: Write failing tests**

```typescript
// __tests__/lib/issue-triage/conversation.test.ts
import { runIntakeTurn } from '@/lib/issue-triage/conversation'
import type { SlackIssue } from '@/lib/issue-triage/types'
import { EMPTY_TICKET_DATA } from '@/lib/issue-triage/types'

const ANTHROPIC_KEY = 'test-key'
process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY

// Mock the Anthropic SDK
jest.mock('@anthropic-ai/sdk', () => ({
  default: jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn(),
    },
  })),
}))

import Anthropic from '@anthropic-ai/sdk'

function makeIssue(overrides: Partial<SlackIssue> = {}): SlackIssue {
  return {
    thread_ts: '1234567890.000001',
    channel_id: 'C_ISSUES',
    reporter_id: 'U_REPORTER',
    status: 'gathering',
    ticket_data: { ...EMPTY_TICKET_DATA },
    metadata: { logrocket_links: [], file_ids: [], vault_snippets_used: [], triage_reasoning: '' },
    human_takeover: false,
    clickup_task_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_msg_ts: null,
    ...overrides,
  }
}

describe('runIntakeTurn', () => {
  let mockCreate: jest.Mock

  beforeEach(() => {
    const instance = new (Anthropic as jest.MockedClass<typeof Anthropic>)({} as never)
    mockCreate = instance.messages.create as jest.Mock
  })

  it('returns updated_schema, bot_response, and confidence from Claude', async () => {
    const claudeOutput = {
      updated_schema: { ...EMPTY_TICKET_DATA, issue_summary: 'CMS crash on save' },
      bot_response: 'Got it. Are you completely blocked right now?',
      confidence: 0.2,
    }
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(claudeOutput) }],
    })

    const issue = makeIssue()
    const history = [{ user: 'U_REPORTER', text: 'CMS is crashing', ts: '1234567890.000001' }]
    const result = await runIntakeTurn(issue, 'CMS is crashing', history)

    expect(result.bot_response).toBe('Got it. Are you completely blocked right now?')
    expect(result.confidence).toBe(0.2)
    expect(result.updated_schema.issue_summary).toBe('CMS crash on save')
  })

  it('handles Claude returning JSON wrapped in markdown fences', async () => {
    const claudeOutput = {
      updated_schema: { ...EMPTY_TICKET_DATA },
      bot_response: 'What platform?',
      confidence: 0.1,
    }
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '```json\n' + JSON.stringify(claudeOutput) + '\n```' }],
    })

    const result = await runIntakeTurn(makeIssue(), 'hi', [])
    expect(result.bot_response).toBe('What platform?')
  })

  it('throws when Claude output cannot be parsed', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Sorry I cannot help with that.' }],
    })

    await expect(runIntakeTurn(makeIssue(), 'hi', [])).rejects.toThrow('Intake Claude returned non-JSON')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx jest __tests__/lib/issue-triage/conversation.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/issue-triage/conversation'`.

- [ ] **Step 3: Create `lib/issue-triage/conversation.ts`**

```typescript
// lib/issue-triage/conversation.ts
import Anthropic from '@anthropic-ai/sdk'
import type { SlackIssue, IntakeClaudeResponse, TicketData } from './types'
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

const INTAKE_SYSTEM_PROMPT = `You are a technical support intake specialist for Viscap Media. Your job is to gather a complete bug report through friendly, natural conversation — one question at a time.

Rules:
1. Never ask more than one question per reply.
2. Early in the conversation, ask for the reporter's email address and whether the affected user is themselves or someone else. If someone else, ask for that person's email.
3. If the user appears blocked, search for a workaround before asking more questions.
4. Do not accept vague answers. Probe "I don't know" answers gently before moving on.
5. Once all fields are filled with substantive answers, summarize and ask: "I have everything I need — does this look right? Ready to submit?"

Only set confidence >= 0.8 when every field has a specific, actionable answer, including both email addresses.

Respond with valid JSON only — no markdown, no explanation:
{
  "updated_schema": { ...complete ticket object matching the schema... },
  "bot_response": "The message to post in Slack",
  "confidence": 0.0
}`

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

/**
 * Call Claude with the current issue state and latest user message.
 * Returns the parsed intake response (updated schema + bot reply + confidence).
 */
export async function runIntakeTurn(
  issue: SlackIssue,
  userMessage: string,
  history: SlackMessage[],
): Promise<IntakeClaudeResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

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
    system: INTAKE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userTurn }],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  return parseClaudeJson(text)
}
```

- [ ] **Step 4: Run tests to confirm passing**

```bash
npx jest __tests__/lib/issue-triage/conversation.test.ts --no-coverage
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/issue-triage/conversation.ts __tests__/lib/issue-triage/conversation.test.ts
git commit -m "feat: add intake conversation Claude call"
```

---

## Task 7: Duplicate Detection

**Files:**
- Create: `lib/issue-triage/duplicate-detection.ts`
- Create: `__tests__/lib/issue-triage/duplicate-detection.test.ts`

Fetches all active tasks from all four ClickUp lists, sends them plus the completed ticket to Claude, returns whether a duplicate was found and at what confidence.

- [ ] **Step 1: Write failing tests**

```typescript
// __tests__/lib/issue-triage/duplicate-detection.test.ts
import { detectDuplicate } from '@/lib/issue-triage/duplicate-detection'
import { EMPTY_TICKET_DATA } from '@/lib/issue-triage/types'

process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.CLICKUP_BOT_TOKEN = 'test-cu-token'
process.env.CLICKUP_NEW_TICKETS_LIST_ID = 'list-new'
process.env.CLICKUP_KNOWN_ISSUES_LIST_ID = 'list-known'
process.env.CLICKUP_NEEDS_TUTORIAL_LIST_ID = 'list-tutorial'
process.env.CLICKUP_PLANNING_LIST_ID = 'list-planning'

jest.mock('@anthropic-ai/sdk', () => ({
  default: jest.fn().mockImplementation(() => ({
    messages: { create: jest.fn() },
  })),
}))
import Anthropic from '@anthropic-ai/sdk'

describe('detectDuplicate', () => {
  let mockCreate: jest.Mock

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tasks: [] }),
      text: async () => '',
    })
    const instance = new (Anthropic as jest.MockedClass<typeof Anthropic>)({} as never)
    mockCreate = instance.messages.create as jest.Mock
  })

  it('returns duplicate_task_id when confidence >= 0.85', async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          duplicate_task_id: 'cu-task-999',
          duplicate_confidence: 0.92,
          workaround_found: false,
          workaround_text: null,
          has_user_facing_docs: false,
          documentation_gap: false,
          routing_decision: 'known_issues',
          routing_reasoning: 'Same CMS crash on save reported last week',
        }),
      }],
    })

    const result = await detectDuplicate({ ...EMPTY_TICKET_DATA, issue_summary: 'CMS crash' })
    expect(result.duplicate_task_id).toBe('cu-task-999')
    expect(result.duplicate_confidence).toBe(0.92)
  })

  it('returns null duplicate_task_id when confidence < 0.85', async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          duplicate_task_id: null,
          duplicate_confidence: 0.4,
          workaround_found: false,
          workaround_text: null,
          has_user_facing_docs: false,
          documentation_gap: false,
          routing_decision: 'escalate_to_michael',
          routing_reasoning: 'No similar issues found',
        }),
      }],
    })

    const result = await detectDuplicate({ ...EMPTY_TICKET_DATA, issue_summary: 'New bug' })
    expect(result.duplicate_task_id).toBeNull()
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx jest __tests__/lib/issue-triage/duplicate-detection.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/issue-triage/duplicate-detection'`.

- [ ] **Step 3: Create `lib/issue-triage/duplicate-detection.ts`**

```typescript
// lib/issue-triage/duplicate-detection.ts
import Anthropic from '@anthropic-ai/sdk'
import { buildClickUpClient } from '@/lib/clickup/client'
import type { TicketData, TriageClaudeResponse } from './types'

const TRIAGE_SYSTEM_PROMPT = `You are a triage engine. Given a completed bug report and a list of active ClickUp tasks, determine if the bug has already been reported.

Duplicate rules:
- confidence >= 0.85: this IS a duplicate — set duplicate_task_id to the matching task's ClickUp ID
- 0.60–0.84: related but distinct — set duplicate_task_id to null, note the related task in routing_reasoning
- < 0.60: unrelated

Respond with valid JSON only — no markdown, no explanation.`

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

  const listIds = [
    process.env.CLICKUP_NEW_TICKETS_LIST_ID,
    process.env.CLICKUP_KNOWN_ISSUES_LIST_ID,
    process.env.CLICKUP_NEEDS_TUTORIAL_LIST_ID,
    process.env.CLICKUP_PLANNING_LIST_ID,
  ].filter(Boolean) as string[]

  const client = buildClickUpClient(token)

  // Fetch tasks from all four lists in parallel; skip lists that fail
  const taskArrays = await Promise.all(
    listIds.map((listId) =>
      client.getTasks(listId).catch(() => [])
    )
  )
  const allTasks = taskArrays.flat().map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
  }))

  const anthropic = new Anthropic({ apiKey })
  const userTurn = [
    `Completed ticket:\n${JSON.stringify(ticketData)}`,
    `Active ClickUp tasks (all lists):\n${formatTaskList(allTasks)}`,
    `Vault search results: (populated by workaround-search step)`,
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
```

- [ ] **Step 4: Run tests to confirm passing**

```bash
npx jest __tests__/lib/issue-triage/duplicate-detection.test.ts --no-coverage
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/issue-triage/duplicate-detection.ts __tests__/lib/issue-triage/duplicate-detection.test.ts
git commit -m "feat: add duplicate detection via Claude + ClickUp task fetch"
```

---

## Task 8: Workaround Search

**Files:**
- Create: `lib/issue-triage/workaround-search.ts`
- Create: `__tests__/lib/issue-triage/workaround-search.test.ts`

Calls `searchVault()` with the issue summary + environment, then Claude to determine whether results contain a user-facing workaround.

- [ ] **Step 1: Write failing tests**

```typescript
// __tests__/lib/issue-triage/workaround-search.test.ts
import { searchForWorkaround } from '@/lib/issue-triage/workaround-search'
import { EMPTY_TICKET_DATA } from '@/lib/issue-triage/types'

process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.GITHUB_TOKEN = 'test-gh-token'

jest.mock('@/lib/github/vault', () => ({
  searchVault: jest.fn(),
}))
jest.mock('@anthropic-ai/sdk', () => ({
  default: jest.fn().mockImplementation(() => ({
    messages: { create: jest.fn() },
  })),
}))

import { searchVault } from '@/lib/github/vault'
import Anthropic from '@anthropic-ai/sdk'

describe('searchForWorkaround', () => {
  let mockCreate: jest.Mock

  beforeEach(() => {
    const instance = new (Anthropic as jest.MockedClass<typeof Anthropic>)({} as never)
    mockCreate = instance.messages.create as jest.Mock
  })

  it('returns workaround found when Claude confirms user-facing docs', async () => {
    ;(searchVault as jest.Mock).mockResolvedValue([
      { path: 'Guides/cms-save.md', snippet: 'To work around: use Ctrl+S instead of the button', score: 0.9 },
    ])
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          workaround_found: true,
          workaround_text: 'Use Ctrl+S to save instead of the Save button.',
          has_user_facing_docs: true,
          documentation_gap: false,
        }),
      }],
    })

    const result = await searchForWorkaround({
      ...EMPTY_TICKET_DATA,
      issue_summary: 'CMS crash on save',
      environment: { platform: 'Web', brand: 'Acme', storyboard: 'Summer' },
    })

    expect(result.found).toBe(true)
    expect(result.hasUserFacingDocs).toBe(true)
    expect(result.text).toContain('Ctrl+S')
  })

  it('returns not found when vault search returns no results', async () => {
    ;(searchVault as jest.Mock).mockResolvedValue([])
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          workaround_found: false,
          workaround_text: null,
          has_user_facing_docs: false,
          documentation_gap: true,
        }),
      }],
    })

    const result = await searchForWorkaround({ ...EMPTY_TICKET_DATA, issue_summary: 'Unknown crash' })
    expect(result.found).toBe(false)
    expect(result.docGap).toBe(true)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx jest __tests__/lib/issue-triage/workaround-search.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/issue-triage/workaround-search'`.

- [ ] **Step 3: Create `lib/issue-triage/workaround-search.ts`**

```typescript
// lib/issue-triage/workaround-search.ts
import Anthropic from '@anthropic-ai/sdk'
import { searchVault } from '@/lib/github/vault'
import type { TicketData } from './types'

export interface WorkaroundResult {
  found: boolean
  text: string | null
  hasUserFacingDocs: boolean
  docGap: boolean
}

const WORKAROUND_SYSTEM_PROMPT = `You are a technical support triage assistant. Given a bug report and documentation search results, determine:

1. Whether there is a workaround a non-technical team member can follow TODAY to unblock themselves.
2. Whether that workaround is documented in user-facing guides (not just internal/technical docs).
3. Whether there is a documentation gap (technical content exists but no user guide).

Respond with valid JSON only — no markdown, no explanation:
{
  "workaround_found": true | false,
  "workaround_text": "Step-by-step summary for the user, or null",
  "has_user_facing_docs": true | false,
  "documentation_gap": true | false
}`

export async function searchForWorkaround(ticketData: TicketData): Promise<WorkaroundResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  const githubToken = process.env.GITHUB_TOKEN
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
  if (!githubToken) throw new Error('GITHUB_TOKEN is not set')

  const query = [ticketData.issue_summary, ticketData.environment.platform].filter(Boolean).join(' ')
  const vaultResults = await searchVault(githubToken, query, 5).catch(() => [])

  const vaultSummary = vaultResults.length > 0
    ? vaultResults.map((r) => `[${r.path}]\n${r.snippet}`).join('\n\n---\n\n')
    : 'No documentation found.'

  const anthropic = new Anthropic({ apiKey })
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 512,
    system: WORKAROUND_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Bug report:\n${JSON.stringify(ticketData)}\n\nVault search results:\n${vaultSummary}`,
    }],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  let parsed: { workaround_found: boolean; workaround_text: string | null; has_user_facing_docs: boolean; documentation_gap: boolean }

  try {
    parsed = JSON.parse(text)
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) parsed = JSON.parse(match[1].trim())
    else throw new Error(`Workaround Claude returned non-JSON. First 300 chars: ${text.slice(0, 300)}`)
  }

  return {
    found: parsed.workaround_found,
    text: parsed.workaround_text,
    hasUserFacingDocs: parsed.has_user_facing_docs,
    docGap: parsed.documentation_gap,
  }
}
```

- [ ] **Step 4: Run tests to confirm passing**

```bash
npx jest __tests__/lib/issue-triage/workaround-search.test.ts --no-coverage
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/issue-triage/workaround-search.ts __tests__/lib/issue-triage/workaround-search.test.ts
git commit -m "feat: add vault workaround search with Claude ranking"
```

---

## Task 9: Ticket Router

**Files:**
- Create: `lib/issue-triage/router.ts`
- Create: `__tests__/lib/issue-triage/router.test.ts`

Executes the routing decision: creates or updates ClickUp tasks, posts final Slack messages, DMs Michael for urgent issues, and handles priority escalation including moving a ticket to Planning when it hits "high".

- [ ] **Step 1: Write failing tests**

```typescript
// __tests__/lib/issue-triage/router.test.ts
import { routeTicket } from '@/lib/issue-triage/router'
import { EMPTY_TICKET_DATA } from '@/lib/issue-triage/types'
import type { SlackIssue, TriageClaudeResponse } from '@/lib/issue-triage/types'

process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.CLICKUP_BOT_TOKEN = 'test-cu-token'
process.env.SLACK_BOT_TOKEN = 'xoxb-test'
process.env.SLACK_MICHAEL_USER_ID = 'U_MICHAEL'
process.env.CLICKUP_NEW_TICKETS_LIST_ID = 'list-new'
process.env.CLICKUP_KNOWN_ISSUES_LIST_ID = 'list-known'
process.env.CLICKUP_NEEDS_TUTORIAL_LIST_ID = 'list-tutorial'
process.env.CLICKUP_PLANNING_LIST_ID = 'list-planning'

// Mock ClickUp client
jest.mock('@/lib/clickup/client', () => ({
  buildClickUpClient: jest.fn().mockReturnValue({
    createTask: jest.fn().mockResolvedValue({ id: 'cu-new', url: 'https://app.clickup.com/t/cu-new' }),
    moveTask: jest.fn().mockResolvedValue(undefined),
    setTaskPriority: jest.fn().mockResolvedValue(undefined),
    getTask: jest.fn().mockResolvedValue({
      id: 'cu-old',
      name: 'CMS crash',
      description: null,
      status: { status: 'open' },
      priority: { id: '3', priority: 'normal' },
      url: 'https://app.clickup.com/t/cu-old',
      custom_fields: [],
      list: { id: 'list-new', name: 'New Tickets' },
    }),
    createTaskComment: jest.fn().mockResolvedValue({ id: 'comment-1' }),
  }),
}))

// Mock Slack client
jest.mock('@/lib/slack/client', () => ({
  buildSlackClient: jest.fn().mockReturnValue({
    postMessage: jest.fn().mockResolvedValue('1234567890.999'),
    openDM: jest.fn().mockResolvedValue('D_MICHAEL'),
  }),
}))

import { buildClickUpClient } from '@/lib/clickup/client'
import { buildSlackClient } from '@/lib/slack/client'

function makeIssue(overrides: Partial<SlackIssue> = {}): SlackIssue {
  return {
    thread_ts: '1234567890.000001',
    channel_id: 'C_ISSUES',
    reporter_id: 'U_REPORTER',
    status: 'triaging',
    ticket_data: { ...EMPTY_TICKET_DATA, issue_summary: 'CMS crash on save' },
    metadata: { logrocket_links: [], file_ids: [], vault_snippets_used: [], triage_reasoning: '' },
    human_takeover: false,
    clickup_task_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_msg_ts: null,
    ...overrides,
  }
}

function makeTriageResponse(overrides: Partial<TriageClaudeResponse> = {}): TriageClaudeResponse {
  return {
    duplicate_task_id: null,
    duplicate_confidence: 0,
    workaround_found: false,
    workaround_text: null,
    has_user_facing_docs: false,
    documentation_gap: false,
    routing_decision: 'escalate_to_michael',
    routing_reasoning: 'No related issues, no workaround',
    ...overrides,
  }
}

describe('routeTicket', () => {
  let cuClient: ReturnType<typeof buildClickUpClient>
  let slackClient: ReturnType<typeof buildSlackClient>

  beforeEach(() => {
    jest.clearAllMocks()
    cuClient = buildClickUpClient('token')
    slackClient = buildSlackClient('token')
  })

  it('creates a new ticket in New Tickets and DMs Michael for escalate_to_michael', async () => {
    const issue = makeIssue()
    const triage = makeTriageResponse({ routing_decision: 'escalate_to_michael' })

    await routeTicket(issue, triage)

    expect(cuClient.createTask).toHaveBeenCalledWith(
      'list-new',
      expect.objectContaining({ priority: 2 })  // HIGH
    )
    expect(slackClient.openDM).toHaveBeenCalledWith('U_MICHAEL')
    expect(slackClient.postMessage).toHaveBeenCalledWith('D_MICHAEL', expect.stringContaining('cu-new'))
  })

  it('creates ticket in Needs Tutorial for needs_tutorial routing', async () => {
    const issue = makeIssue()
    const triage = makeTriageResponse({
      routing_decision: 'needs_tutorial',
      workaround_found: true,
      workaround_text: 'Use Ctrl+S instead',
    })

    await routeTicket(issue, triage)

    expect(cuClient.createTask).toHaveBeenCalledWith(
      'list-tutorial',
      expect.objectContaining({ name: expect.any(String) })
    )
    expect(slackClient.postMessage).toHaveBeenCalledWith(
      'C_ISSUES',
      expect.stringContaining('Ctrl+S'),
      '1234567890.000001'
    )
  })

  it('bumps priority and comments on existing ticket for known_issues routing', async () => {
    const issue = makeIssue()
    const triage = makeTriageResponse({
      routing_decision: 'known_issues',
      duplicate_task_id: 'cu-old',
      duplicate_confidence: 0.95,
    })

    await routeTicket(issue, triage)

    // Priority bumped from normal(3) → high(2)
    expect(cuClient.setTaskPriority).toHaveBeenCalledWith('cu-old', 2)
    // Comment added to old ticket
    expect(cuClient.createTaskComment).toHaveBeenCalledWith('cu-old', expect.any(String))
    // No new ticket created
    expect(cuClient.createTask).not.toHaveBeenCalled()
  })

  it('moves ticket to Planning when priority bump lands on high', async () => {
    // The existing task is already at normal(3), bumping to high(2) triggers Planning move
    const issue = makeIssue()
    const triage = makeTriageResponse({
      routing_decision: 'known_issues',
      duplicate_task_id: 'cu-old',
      duplicate_confidence: 0.9,
    })

    await routeTicket(issue, triage)

    expect(cuClient.setTaskPriority).toHaveBeenCalledWith('cu-old', 2)
    expect(cuClient.moveTask).toHaveBeenCalledWith('cu-old', 'list-planning')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx jest __tests__/lib/issue-triage/router.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/issue-triage/router'`.

- [ ] **Step 3: Create `lib/issue-triage/router.ts`**

```typescript
// lib/issue-triage/router.ts
import { buildClickUpClient } from '@/lib/clickup/client'
import { buildSlackClient } from '@/lib/slack/client'
import type { SlackIssue, TriageClaudeResponse } from './types'

// ClickUp priority: 1=urgent, 2=high, 3=normal, 4=low
const PRIORITY_MAP: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 }

function bumpPriority(currentStr: string | null | undefined): number | 'already_urgent' {
  const current = PRIORITY_MAP[currentStr ?? ''] ?? 4  // default to low
  if (current <= 1) return 'already_urgent'
  return current - 1  // lower number = higher priority
}

function buildTaskDescription(issue: SlackIssue): string {
  const t = issue.ticket_data
  return [
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
    `**Slack thread:** https://slack.com (thread_ts: ${issue.thread_ts})`,
  ].filter(Boolean).join('\n')
}

export async function routeTicket(issue: SlackIssue, triage: TriageClaudeResponse): Promise<void> {
  const cuToken = process.env.CLICKUP_BOT_TOKEN
  const slackToken = process.env.SLACK_BOT_TOKEN
  if (!cuToken) throw new Error('CLICKUP_BOT_TOKEN is not set')
  if (!slackToken) throw new Error('SLACK_BOT_TOKEN is not set')

  const cu = buildClickUpClient(cuToken)
  const slack = buildSlackClient(slackToken)
  const michaelId = process.env.SLACK_MICHAEL_USER_ID

  const listIds = {
    new: process.env.CLICKUP_NEW_TICKETS_LIST_ID!,
    known: process.env.CLICKUP_KNOWN_ISSUES_LIST_ID!,
    tutorial: process.env.CLICKUP_NEEDS_TUTORIAL_LIST_ID!,
    planning: process.env.CLICKUP_PLANNING_LIST_ID!,
  }

  const { routing_decision } = triage

  if (routing_decision === 'known_issues' && triage.duplicate_task_id) {
    // ── DUPLICATE PATH ──────────────────────────────────────────────
    const existing = await cu.getTask(triage.duplicate_task_id)
    const newPriority = bumpPriority(existing.priority?.priority ?? null)

    if (newPriority === 'already_urgent') {
      // Notify Michael + assignees that the issue has hit urgent again
      const comment = `🚨 This issue was reported again. New Slack thread: (thread_ts: ${issue.thread_ts})\nReporter: ${issue.ticket_data.reporter_email}`
      await cu.createTaskComment(triage.duplicate_task_id, comment)
      if (michaelId) {
        const dmChannel = await slack.openDM(michaelId)
        await slack.postMessage(dmChannel, `🚨 Urgent issue reported again: ${existing.url}\nReporter: ${issue.ticket_data.reporter_email}`)
      }
    } else {
      await cu.setTaskPriority(triage.duplicate_task_id, newPriority as 1 | 2 | 3 | 4)
      await cu.createTaskComment(
        triage.duplicate_task_id,
        `📌 Related report (thread_ts: ${issue.thread_ts}) — Reporter: ${issue.ticket_data.reporter_email}`,
      )
      // If bumped to high, move to Planning
      if (newPriority === 2) {
        await cu.moveTask(triage.duplicate_task_id, listIds.planning)
      }
    }

    await slack.postMessage(
      issue.channel_id,
      `✅ This looks like a known issue! I've linked your report to the existing ticket and bumped its priority: ${existing.url}`,
      issue.thread_ts,
    )
    return
  }

  if (routing_decision === 'needs_tutorial') {
    // ── NEEDS TUTORIAL PATH ────────────────────────────────────────
    const task = await cu.createTask(listIds.tutorial, {
      name: issue.ticket_data.issue_summary,
      description: buildTaskDescription(issue),
      priority: 3,  // normal
    })
    const message = triage.workaround_text
      ? `📝 I've created a ticket for the team to document this properly: ${task.url}\n\nIn the meantime, here's a workaround:\n${triage.workaround_text}`
      : `📝 No workaround found yet. I've created a documentation ticket: ${task.url}`
    await slack.postMessage(issue.channel_id, message, issue.thread_ts)
    return
  }

  if (routing_decision === 'new_tickets_with_workaround') {
    // ── NEW TICKET WITH WORKAROUND ─────────────────────────────────
    const task = await cu.createTask(listIds.new, {
      name: issue.ticket_data.issue_summary,
      description: buildTaskDescription(issue),
      priority: 4,  // low — will escalate via future duplicates
    })
    const docsNote = triage.workaround_text
      ? `\n\nWorkaround:\n${triage.workaround_text}`
      : ''
    await slack.postMessage(
      issue.channel_id,
      `✅ Ticket created: ${task.url}${docsNote}`,
      issue.thread_ts,
    )
    return
  }

  // ── ESCALATE TO MICHAEL (no workaround) ────────────────────────
  const task = await cu.createTask(listIds.new, {
    name: issue.ticket_data.issue_summary,
    description: buildTaskDescription(issue),
    priority: 2,  // HIGH
  })
  await slack.postMessage(
    issue.channel_id,
    `🚨 Ticket created at HIGH priority: ${task.url}\nI've notified the team. Someone will follow up shortly.`,
    issue.thread_ts,
  )
  if (michaelId) {
    const dmChannel = await slack.openDM(michaelId)
    await slack.postMessage(
      dmChannel,
      `🚨 New HIGH priority bug — no workaround exists.\nReporter: ${issue.ticket_data.reporter_email}\nAffected user: ${issue.ticket_data.affected_user_email}\nTicket: ${task.url}`,
    )
  }
}
```

- [ ] **Step 4: Run tests to confirm passing**

```bash
npx jest __tests__/lib/issue-triage/router.test.ts --no-coverage
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/issue-triage/router.ts __tests__/lib/issue-triage/router.test.ts
git commit -m "feat: add ticket router with full routing decision tree"
```

---

## Task 10: Slack Webhook Handler

**Files:**
- Create: `app/api/webhooks/slack/route.ts`
- Create: `__tests__/api/webhooks/slack.test.ts`

Verifies Slack signature, handles URL verification challenge, guards against bot echo and off-channel events, then dispatches the full pipeline inside `after()`.

- [ ] **Step 1: Write failing tests**

```typescript
// __tests__/api/webhooks/slack.test.ts
import { POST } from '@/app/api/webhooks/slack/route'
import { NextRequest } from 'next/server'
import crypto from 'crypto'

const SIGNING_SECRET = 'test-signing-secret'
process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET
process.env.SLACK_ISSUES_CHANNEL_ID = 'C_ISSUES'
process.env.SLACK_BOT_TOKEN = 'xoxb-test'
process.env.CLICKUP_BOT_TOKEN = 'cu-test'
process.env.ANTHROPIC_API_KEY = 'anth-test'
process.env.GITHUB_TOKEN = 'gh-test'

// Mock next/server after() so it's a no-op in tests
jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server')
  return { ...actual, after: jest.fn((fn: () => void) => fn()) }
})

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: null }),
      insert: jest.fn().mockResolvedValue({ data: null, error: null }),
      update: jest.fn().mockReturnThis(),
    }),
  }),
}))

jest.mock('@/lib/issue-triage/conversation', () => ({
  runIntakeTurn: jest.fn().mockResolvedValue({
    updated_schema: {},
    bot_response: 'Tell me more',
    confidence: 0.2,
  }),
}))
jest.mock('@/lib/slack/client', () => ({
  buildSlackClient: jest.fn().mockReturnValue({
    postMessage: jest.fn().mockResolvedValue('ts-bot'),
    getThreadReplies: jest.fn().mockResolvedValue([]),
  }),
}))

function makeSlackRequest(body: object, channelOverride?: string): NextRequest {
  const payload = JSON.stringify(body)
  const ts = String(Math.floor(Date.now() / 1000))
  const base = `v0:${ts}:${payload}`
  const sig = 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(base).digest('hex')

  return new NextRequest('http://localhost/api/webhooks/slack', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sig,
    },
    body: payload,
  })
}

describe('POST /api/webhooks/slack', () => {
  it('echoes the URL verification challenge', async () => {
    const req = makeSlackRequest({ type: 'url_verification', challenge: 'xyz-challenge' })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.challenge).toBe('xyz-challenge')
  })

  it('returns 401 for invalid signature', async () => {
    const req = new NextRequest('http://localhost/api/webhooks/slack', {
      method: 'POST',
      headers: {
        'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-slack-signature': 'v0=badsig',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'event_callback' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('returns 200 and ignores bot messages', async () => {
    const req = makeSlackRequest({
      type: 'event_callback',
      event: { type: 'message', bot_id: 'B123', channel: 'C_ISSUES', text: 'bot reply', ts: '1.1' },
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
  })

  it('returns 200 and ignores messages from other channels', async () => {
    const req = makeSlackRequest({
      type: 'event_callback',
      event: { type: 'message', user: 'U001', channel: 'C_OTHER', text: 'off-channel', ts: '1.2' },
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
  })

  it('returns 200 for a valid new issue message', async () => {
    const req = makeSlackRequest({
      type: 'event_callback',
      event: { type: 'message', user: 'U001', channel: 'C_ISSUES', text: 'CMS crashed!', ts: '1234567890.000001' },
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx jest __tests__/api/webhooks/slack.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/app/api/webhooks/slack/route'`.

- [ ] **Step 3: Create `app/api/webhooks/slack/route.ts`**

```typescript
// app/api/webhooks/slack/route.ts
import { NextRequest, NextResponse, after } from 'next/server'
import { verifySlackSignature } from '@/lib/slack/verify'
import { buildSlackClient } from '@/lib/slack/client'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { runIntakeTurn } from '@/lib/issue-triage/conversation'
import { detectDuplicate } from '@/lib/issue-triage/duplicate-detection'
import { searchForWorkaround } from '@/lib/issue-triage/workaround-search'
import { routeTicket } from '@/lib/issue-triage/router'
import { EMPTY_TICKET_DATA } from '@/lib/issue-triage/types'
import type { SlackIssue } from '@/lib/issue-triage/types'

interface SlackEvent {
  type: string
  user?: string
  bot_id?: string
  subtype?: string
  channel: string
  text: string
  ts: string
  thread_ts?: string
}

interface SlackPayload {
  type: string
  challenge?: string
  event?: SlackEvent
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text()
  const timestamp = req.headers.get('x-slack-request-timestamp') ?? ''
  const signature = req.headers.get('x-slack-signature') ?? ''
  const signingSecret = process.env.SLACK_SIGNING_SECRET ?? ''

  // 1. URL verification handshake (Slack setup)
  let payload: SlackPayload
  try {
    payload = JSON.parse(rawBody) as SlackPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (payload.type === 'url_verification') {
    return NextResponse.json({ challenge: payload.challenge })
  }

  // 2. Verify signature for all other requests
  if (!verifySlackSignature(rawBody, timestamp, signature, signingSecret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const event = payload.event
  if (!event) return NextResponse.json({ ok: true })

  // 3. Ignore bot messages and messages from other channels
  const issuesChannel = process.env.SLACK_ISSUES_CHANNEL_ID
  if (event.bot_id || event.subtype === 'bot_message') return NextResponse.json({ ok: true })
  if (event.channel !== issuesChannel) return NextResponse.json({ ok: true })

  // 4. ACK immediately — all work happens in after()
  after(async () => {
    try {
      await processSlackEvent(event)
    } catch (err) {
      console.error('[slack-webhook] after() error:', err)
    }
  })

  return NextResponse.json({ ok: true })
}

async function processSlackEvent(event: SlackEvent): Promise<void> {
  const supabase = await getSupabaseServiceClient()
  const slackToken = process.env.SLACK_BOT_TOKEN ?? ''
  const slack = buildSlackClient(slackToken)

  // The effective thread identifier: replies have thread_ts, new messages use their own ts
  const threadTs = event.thread_ts ?? event.ts

  // Look up existing session
  const { data: existing } = await supabase
    .from('slack_issues')
    .select('*')
    .eq('thread_ts', threadTs)
    .single()

  const issue = existing as SlackIssue | null

  // ── Human takeover guard ──────────────────────────────────────────────────
  if (issue?.human_takeover) return  // bot is silent

  if (issue && event.user !== issue.reporter_id) {
    // Non-reporter spoke in thread — activate human takeover
    await supabase
      .from('slack_issues')
      .update({ human_takeover: true, updated_at: new Date().toISOString() })
      .eq('thread_ts', threadTs)
    return
  }

  // ── New issue (no existing session) ──────────────────────────────────────
  if (!issue) {
    const newIssue: Omit<SlackIssue, 'created_at' | 'updated_at'> = {
      thread_ts: threadTs,
      channel_id: event.channel,
      reporter_id: event.user ?? '',
      status: 'gathering',
      ticket_data: { ...EMPTY_TICKET_DATA },
      metadata: { logrocket_links: [], file_ids: [], vault_snippets_used: [], triage_reasoning: '' },
      human_takeover: false,
      clickup_task_id: null,
      last_msg_ts: event.ts,
    }
    await supabase.from('slack_issues').insert(newIssue)
    await handleGathering(
      { ...newIssue, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      event,
      slack,
      supabase,
    )
    return
  }

  // ── Route by current status ───────────────────────────────────────────────
  if (issue.status === 'gathering') {
    await handleGathering(issue, event, slack, supabase)
  } else if (issue.status === 'confirming') {
    await handleConfirming(issue, event, slack, supabase)
  }
  // 'triaging', 'complete', 'human_takeover' are all silent
}

async function handleGathering(
  issue: SlackIssue,
  event: SlackEvent,
  slack: ReturnType<typeof buildSlackClient>,
  supabase: Awaited<ReturnType<typeof getSupabaseServiceClient>>,
): Promise<void> {
  const history = await slack.getThreadReplies(event.channel, issue.thread_ts).catch(() => [])
  const result = await runIntakeTurn(issue, event.text, history)

  const isReady = result.confidence >= 0.8
  const newStatus = isReady ? 'confirming' : 'gathering'

  await supabase.from('slack_issues').update({
    ticket_data: result.updated_schema,
    status: newStatus,
    last_msg_ts: event.ts,
    updated_at: new Date().toISOString(),
  }).eq('thread_ts', issue.thread_ts)

  await slack.postMessage(event.channel, result.bot_response, issue.thread_ts)
}

async function handleConfirming(
  issue: SlackIssue,
  event: SlackEvent,
  slack: ReturnType<typeof buildSlackClient>,
  supabase: Awaited<ReturnType<typeof getSupabaseServiceClient>>,
): Promise<void> {
  const text = event.text.toLowerCase().trim()
  const isYes = /\b(yes|submit|go ahead|confirm|yep|yeah|sure|ok|okay)\b/.test(text)
  const isNo = /\b(no|wait|hold on|actually|not yet|forgot)\b/.test(text)

  if (isYes) {
    // Transition to triaging and run the pipeline
    await supabase.from('slack_issues').update({
      status: 'triaging',
      updated_at: new Date().toISOString(),
    }).eq('thread_ts', issue.thread_ts)

    await slack.postMessage(
      event.channel,
      '⏳ Got it! Running triage now…',
      issue.thread_ts,
    )

    const [triageResult] = await Promise.all([
      detectDuplicate(issue.ticket_data),
    ])

    if (!triageResult.duplicate_task_id) {
      // Only search for workaround if not a duplicate
      const workaround = await searchForWorkaround(issue.ticket_data)
      triageResult.workaround_found = workaround.found
      triageResult.workaround_text = workaround.text
      triageResult.has_user_facing_docs = workaround.hasUserFacingDocs
      triageResult.documentation_gap = workaround.docGap

      if (workaround.found && workaround.hasUserFacingDocs) {
        triageResult.routing_decision = 'new_tickets_with_workaround'
      } else if (workaround.found && !workaround.hasUserFacingDocs) {
        triageResult.routing_decision = 'needs_tutorial'
      } else {
        triageResult.routing_decision = 'escalate_to_michael'
      }
    }

    await routeTicket(issue, triageResult)

    await supabase.from('slack_issues').update({
      status: 'complete',
      updated_at: new Date().toISOString(),
    }).eq('thread_ts', issue.thread_ts)

  } else if (isNo) {
    // Revert to gathering
    await supabase.from('slack_issues').update({
      status: 'gathering',
      updated_at: new Date().toISOString(),
    }).eq('thread_ts', issue.thread_ts)

    await slack.postMessage(
      event.channel,
      "No problem! What would you like to add or change?",
      issue.thread_ts,
    )
  } else {
    // Treat as a clarification — re-ask the confirmation
    await slack.postMessage(
      event.channel,
      "Just to confirm — are you ready for me to submit this ticket? Reply **Yes** to submit or **No** to make changes.",
      issue.thread_ts,
    )
  }
}
```

- [ ] **Step 4: Run tests to confirm passing**

```bash
npx jest __tests__/api/webhooks/slack.test.ts --no-coverage
```

Expected: PASS (5 tests).

- [ ] **Step 5: Confirm full suite still passes**

```bash
npx jest --no-coverage
```

Expected: all tests pass with no regressions.

- [ ] **Step 6: Commit**

```bash
git add app/api/webhooks/slack/route.ts __tests__/api/webhooks/slack.test.ts
git commit -m "feat: add Slack webhook handler with full intake + triage pipeline"
```

---

## Task 11: Stale-Thread Cron

**Files:**
- Create: `app/api/cron/slack-stale-check/route.ts`
- Create: `__tests__/api/cron/slack-stale-check.test.ts`

Queries for threads in `gathering` or `confirming` status that haven't been updated in over an hour, posts a gentle nudge in each one.

- [ ] **Step 1: Write failing tests**

```typescript
// __tests__/api/cron/slack-stale-check.test.ts
import { GET } from '@/app/api/cron/slack-stale-check/route'
import { NextRequest } from 'next/server'

process.env.SLACK_BOT_TOKEN = 'xoxb-test'

const mockPostMessage = jest.fn().mockResolvedValue('ts-nudge')
jest.mock('@/lib/slack/client', () => ({
  buildSlackClient: jest.fn().mockReturnValue({ postMessage: mockPostMessage }),
}))

const staleIssues = [
  { thread_ts: '111.000', channel_id: 'C_ISSUES', status: 'gathering' },
  { thread_ts: '222.000', channel_id: 'C_ISSUES', status: 'confirming' },
]

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      lt: jest.fn().mockResolvedValue({ data: staleIssues, error: null }),
    }),
  }),
}))

describe('GET /api/cron/slack-stale-check', () => {
  it('returns 200 and reports how many threads were nudged', async () => {
    const req = new NextRequest('http://localhost/api/cron/slack-stale-check')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.nudged).toBe(2)
  })

  it('posts a nudge message to each stale thread', async () => {
    const req = new NextRequest('http://localhost/api/cron/slack-stale-check')
    await GET(req)
    expect(mockPostMessage).toHaveBeenCalledTimes(2)
    expect(mockPostMessage).toHaveBeenCalledWith(
      'C_ISSUES',
      expect.stringContaining('Still there'),
      '111.000',
    )
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx jest __tests__/api/cron/slack-stale-check.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/app/api/cron/slack-stale-check/route'`.

- [ ] **Step 3: Create `app/api/cron/slack-stale-check/route.ts`**

```typescript
// app/api/cron/slack-stale-check/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildSlackClient } from '@/lib/slack/client'

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const supabase = await getSupabaseServiceClient()
  const slackToken = process.env.SLACK_BOT_TOKEN ?? ''
  const slack = buildSlackClient(slackToken)

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

  const { data: stale } = await supabase
    .from('slack_issues')
    .select('thread_ts, channel_id, status')
    .in('status', ['gathering', 'confirming'])
    .lt('updated_at', oneHourAgo)

  if (!stale?.length) return NextResponse.json({ nudged: 0 })

  await Promise.all(
    stale.map((issue) =>
      slack
        .postMessage(
          issue.channel_id,
          "Still there? I'm ready to finish documenting this whenever you are. Just reply to this thread and we'll pick up where we left off.",
          issue.thread_ts,
        )
        .catch((err) => console.error('[stale-check] postMessage failed:', issue.thread_ts, err))
    )
  )

  return NextResponse.json({ nudged: stale.length })
}
```

- [ ] **Step 4: Run tests to confirm passing**

```bash
npx jest __tests__/api/cron/slack-stale-check.test.ts --no-coverage
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/cron/slack-stale-check/route.ts __tests__/api/cron/slack-stale-check.test.ts
git commit -m "feat: add stale-thread cron nudge"
```

---

## Task 12: Vercel Cron Configuration

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Add cron entry to `vercel.json`**

Replace the current contents:

```json
{
  "framework": "nextjs",
  "crons": [
    {
      "path": "/api/cron/slack-stale-check",
      "schedule": "0 * * * *"
    }
  ]
}
```

- [ ] **Step 2: Confirm TypeScript still compiles (no accidental breakage)**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Run full test suite**

```bash
npx jest --no-coverage
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add vercel.json
git commit -m "feat: add hourly cron for stale Slack thread nudge"
```

---

## Task 13: Slack App Setup (Manual — no code)

These steps happen in the Slack developer console and Vercel dashboard. No code is required.

- [ ] **Step 1: Create Slack App**

Go to https://api.slack.com/apps → "Create New App" → "From scratch". Name it "Viscap Support Bot".

- [ ] **Step 2: Configure OAuth scopes**

Under **OAuth & Permissions > Bot Token Scopes**, add:
- `chat:write`
- `im:write`
- `channels:history`

Install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-...`).

- [ ] **Step 3: Enable Event Subscriptions**

Under **Event Subscriptions**:
- Toggle **Enable Events** ON
- Set **Request URL** to `https://your-production-domain.com/api/webhooks/slack`
- Slack will immediately send a verification challenge — the handler echoes it back automatically
- Under **Subscribe to Bot Events**, add: `message.channels`

- [ ] **Step 4: Disable Socket Mode**

Under **Socket Mode**, ensure it is **OFF**.

- [ ] **Step 5: Invite bot to the channel**

In Slack, go to the issues channel → **Integrations** → **Add an App** → select "Viscap Support Bot".

- [ ] **Step 6: Add environment variables**

Run these to add the new env vars to Vercel (fill in actual values):

```bash
vercel env add SLACK_SIGNING_SECRET production
vercel env add SLACK_BOT_TOKEN production
vercel env add SLACK_ISSUES_CHANNEL_ID production
vercel env add SLACK_MICHAEL_USER_ID production
vercel env add CLICKUP_BOT_TOKEN production
vercel env add CLICKUP_NEW_TICKETS_LIST_ID production
vercel env add CLICKUP_KNOWN_ISSUES_LIST_ID production
vercel env add CLICKUP_NEEDS_TUTORIAL_LIST_ID production
vercel env add CLICKUP_PLANNING_LIST_ID production
```

Also add them to `.env.local` for local development.

- [ ] **Step 7: Get your Slack user ID**

In Slack, click your profile picture → **Profile** → the three-dot menu → **Copy member ID**. Use this for `SLACK_MICHAEL_USER_ID`.

- [ ] **Step 8: Get ClickUp list IDs**

In ClickUp, open each list (New Tickets, Known Issues, Needs Tutorial, Planning) and copy the list ID from the URL: `https://app.clickup.com/{team}/{space}/{folder}/{listId}`. Use these for the `CLICKUP_*_LIST_ID` env vars.

- [ ] **Step 9: Get ClickUp personal API token**

In ClickUp → **Profile** → **Apps** → **API Token**. Use this for `CLICKUP_BOT_TOKEN`.

- [ ] **Step 10: Deploy and verify**

```bash
vercel deploy --prod
```

Post a test message in the issues channel. The bot should reply within a few seconds.

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Covered by |
|---|---|
| Slack Events API webhook at `/api/webhooks/slack` | Task 10 |
| Sig verify + channel guard + bot-echo guard | Task 10 |
| `after()` background processing | Task 10 |
| `slack_issues` Supabase table | Task 1 |
| State machine: gathering/confirming/triaging/complete/human_takeover | Task 10 |
| Human takeover detection | Task 10 |
| Multi-turn intake with Claude | Task 6 |
| `confidence >= 0.8` gate to confirming | Task 10 `handleGathering` |
| "Ready to submit?" circuit breaker | Task 10 `handleConfirming` |
| Duplicate detection across all 4 lists | Task 7 |
| Vault workaround search + Claude ranking | Task 8 |
| Routing decision tree (4 paths) | Task 9 |
| Priority escalation + move to Planning at high | Task 9 `routeTicket` |
| DM Michael for urgent/escalated issues | Task 9 |
| Hourly stale-thread cron nudge | Tasks 11 + 12 |
| ClickUp `createTask`, `moveTask`, `setTaskPriority` | Task 3 |
| Slack `postMessage`, `openDM`, `getThreadReplies` | Task 5 |
| `reporter_email` + `affected_user_email` in ticket | Task 2 + Task 6 prompt |
| Vercel cron config | Task 12 |
| All new env vars documented | Task 13 |

All spec requirements are covered. ✅

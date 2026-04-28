# Slack Support Intake & Triage System — Design Spec

**Date:** 2026-04-28
**Status:** Approved — ready for implementation planning

---

## 1. System Overview

An automated support specialist that monitors a dedicated Slack channel for bug reports, conducts a structured multi-turn intake conversation with the reporter, then performs intelligent triage (duplicate detection and workaround search) before routing tickets to the appropriate ClickUp list.

**Guiding principle:** Unblock the user first. Arm the developer second. Never create zombie tickets.

---

## 2. Architecture

### Pattern: Next.js Webhook + `after()`

The system is event-driven and non-blocking, consistent with the existing ClickUp webhook handler pattern in this codebase.

1. **Slack Events API** POSTs to `/api/webhooks/slack` on every message in the issues channel.
2. The handler validates the Slack signature, ignores bot messages and off-channel events, then returns `200 OK` in under 1 second.
3. All intelligence runs inside `after()` — no work happens in the request window.

### Two Phases

**Intake Phase** (`status: gathering | confirming`)
- Claude manages a multi-turn conversation in the Slack thread to fill the structured ticket template.
- One question per reply, probing vague answers.
- When `confidence >= 0.8`, the bot summarizes and asks: "Ready to submit?"
- User confirmation ("Yes") transitions to `triaging`. "No, wait" reverts specific fields and resumes gathering.

**Triage Phase** (`status: triaging`)
- Triggered once by the user's "Yes" confirmation. Runs in sequence:
  1. `detectDuplicate()` — Claude compares the completed ticket against all active tasks across all four lists.
  2. `searchVault()` — GitHub Code Search retrieves snippets; Claude ranks them for user-facing workarounds.
  3. `routeTicket()` — Creates or updates the ClickUp task and posts the final Slack message.
- `status → complete` is written only after the Slack message succeeds, so a Slack API failure leaves the record in `triaging` for the stale-thread cron to catch.

### Human Takeover

Any non-bot message in the thread from a user who is **not** the original reporter sets `human_takeover = true`. The bot stops responding. It resumes only if directly `@mentioned`.

---

## 3. Database Schema

### New table: `slack_issues`

```sql
CREATE TYPE slack_issue_status AS ENUM (
  'gathering', 'confirming', 'triaging', 'complete', 'human_takeover'
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

CREATE INDEX idx_slack_issues_status ON slack_issues(status);
CREATE INDEX idx_slack_issues_updated_at ON slack_issues(updated_at);
```

### `ticket_data` JSONB schema

```json
{
  "issue_summary": "",
  "is_blocked": null,
  "environment": {
    "platform": "",
    "brand": "",
    "storyboard": ""
  },
  "urls": [],
  "reproduction_steps": [],
  "expected_result": "",
  "actual_result": "",
  "last_occurred_at": "",
  "is_repeat_issue": null,
  "workaround_provided": null,
  "documentation_gap": false
}
```

### `metadata` JSONB schema (internal, not shown to user)

```json
{
  "logrocket_links": [],
  "file_ids": [],
  "vault_snippets_used": [],
  "triage_reasoning": ""
}
```

---

## 4. State Machine

| Transition | Trigger |
|---|---|
| `null → gathering` | New top-level message in channel with no existing `thread_ts` record |
| `gathering → gathering` | Reporter replies; Claude updates `ticket_data` and posts next question |
| `gathering → confirming` | Claude `confidence >= 0.8`; bot posts summary + "Ready to submit?" |
| `confirming → gathering` | User says "No, wait…"; bot clears the relevant field and resumes |
| `confirming → triaging` | User confirms "Yes"; triage pipeline triggers inside `after()` |
| `triaging → complete` | Final Slack message posted successfully |
| `any → human_takeover` | Non-reporter, non-bot speaks in thread |
| `human_takeover → (no change)` | Bot `@mentioned` — out of scope v1; bot posts "A human has taken over this thread" and stays silent |

---

## 5. Routing Decision Tree

```
Triage Phase
    │
    ├─ Duplicate found (confidence >= 0.85)?
    │       YES → Move new report to Known Issues list
    │             Bump oldest related ticket priority one level:
    │               none → low → normal → high → urgent
    │             If bumped to urgent:
    │               DM Michael + DM assignees
    │               Comment on old ticket linking new one
    │             Post link to related ticket in Slack thread
    │             STOP — no new ticket created
    │
    └─ No duplicate
            │
            ├─ Workaround found in vault?
            │       YES → Has user-facing documentation?
            │               YES → Send docs to reporter in thread
            │                     Create ticket in New Tickets (low priority)
            │                     Leave to escalate via future duplicates
            │                     When priority hits high → move to Planning
            │                     (NOTE: this move is triggered inside detectDuplicate()
            │                      when bumping the priority of an existing ticket
            │                      causes it to reach "high" — router.ts handles
            │                      the moveTask call at that point)
            │               NO  → Create ticket in Needs Tutorial
            │                     Flag ticket with "doc-gap" tag
            │                     Send workaround summary verbally in thread
            │
            └─ No workaround found
                    → Create ticket in New Tickets
                      Set priority: HIGH
                      DM Michael with link to ticket
                      Post ticket link in Slack thread
```

**Priority escalation scale:** none → low → normal → high → urgent

---

## 6. ClickUp Client Extensions

Three methods must be added to `lib/clickup/client.ts`:

```typescript
createTask(listId: string, fields: {
  name: string
  description: string
  priority: 1 | 2 | 3 | 4  // 1=urgent, 2=high, 3=normal, 4=low
}): Promise<{ id: string; url: string }>

moveTask(taskId: string, listId: string): Promise<void>

setTaskPriority(taskId: string, priority: 1 | 2 | 3 | 4): Promise<void>
```

All three are standard ClickUp REST calls consistent with the existing client structure.

---

## 7. Slack Client

New file: `lib/slack/client.ts`

Required methods:
- `postMessage(channel, text, threadTs?)` — post to channel or reply in thread
- `openDM(userId)` → returns DM channel ID
- `getThreadReplies(channel, threadTs)` → full thread history for Claude context

New file: `lib/slack/verify.ts`
- `verifySlackSignature(rawBody, signature, signingSecret)` — HMAC-SHA256 verification matching the existing `verifyClickUpSignature` pattern

---

## 8. Claude Prompts

### Intake Prompt (gathering / confirming states)

**System:**
```
You are a technical support intake specialist for Viscap Media. Your job is to gather a complete bug report through friendly, natural conversation — one question at a time.

Rules:
1. Never ask more than one question per reply.
2. If the user appears blocked, search for a workaround before asking more questions.
3. Do not accept vague answers. Probe "I don't know" answers gently before moving on.
4. Once all fields are filled with substantive answers, summarize and ask: "I have everything I need — does this look right? Ready to submit?"

Only set confidence >= 0.8 when every field has a specific, actionable answer.
```

**User turn:**
```
Ticket schema: {{JSON_SCHEMA}}
Current ticket data: {{TICKET_DATA}}
Conversation history: {{HISTORY}}
Latest message: {{USER_MESSAGE}}
```

**Output contract:**
```json
{
  "updated_schema": { "...complete ticket object..." },
  "bot_response": "The message to post in Slack",
  "confidence": 0.0
}
```

### Triage Prompt (triaging state — one-shot)

**System:**
```
You are a triage engine. Given a completed bug report and supporting data, make routing decisions.

Duplicate rules: confidence >= 0.85 = duplicate. 0.6–0.85 = related but distinct (create new ticket, mention the related one in the Slack reply).
Workaround rules: only set workaround_found = true if the vault results contain steps a non-technical team member could follow to unblock themselves today.
```

**User turn:**
```
Completed ticket: {{TICKET_DATA}}
Active ClickUp tasks (all lists): {{CLICKUP_TASKS}}
Vault search results: {{VAULT_RESULTS}}
```

**Output contract:**
```json
{
  "duplicate_task_id": "string | null",
  "duplicate_confidence": 0.0,
  "workaround_found": false,
  "workaround_text": "string | null",
  "has_user_facing_docs": false,
  "documentation_gap": false,
  "routing_decision": "known_issues | needs_tutorial | new_tickets_with_workaround | escalate_to_michael",
  "routing_reasoning": "One sentence"
}
```

---

## 9. Environment Variables

### New (must be added to Vercel + `.env.local`)

| Variable | Source | Purpose |
|---|---|---|
| `SLACK_SIGNING_SECRET` | Slack App > Basic Info | Verify incoming webhook signatures |
| `SLACK_BOT_TOKEN` | Slack App > OAuth | Post messages (`xoxb-...`) |
| `SLACK_ISSUES_CHANNEL_ID` | Slack channel settings | Guard: only process events from this channel |
| `SLACK_MICHAEL_USER_ID` | Your Slack profile | Target for urgent DMs |
| `CLICKUP_BOT_TOKEN` | ClickUp personal token | Bot-level ClickUp auth (no session user in webhook context) |
| `CLICKUP_NEW_TICKETS_LIST_ID` | ClickUp list URL | Routing target |
| `CLICKUP_KNOWN_ISSUES_LIST_ID` | ClickUp list URL | Routing target |
| `CLICKUP_NEEDS_TUTORIAL_LIST_ID` | ClickUp list URL | Routing target |
| `CLICKUP_PLANNING_LIST_ID` | ClickUp list URL | Routing target |

### Existing (already present — no action needed)

`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`

### Slack App OAuth Scopes Required

`chat:write`, `im:write`, `channels:history`

---

## 10. Stale-Thread Cron

**Schedule:** Every hour via Vercel Cron (`vercel.json`)
**Route:** `GET /api/cron/slack-stale-check`

**Logic:**
```sql
SELECT * FROM slack_issues
WHERE status IN ('gathering', 'confirming')
AND updated_at < NOW() - INTERVAL '1 hour'
```

For each result, post a single nudge in the thread: *"Still there? I'm ready to finish documenting this whenever you are."* Does not advance state — just re-engages the reporter.

---

## 11. New Files & Changed Files

### New files

| Path | Purpose |
|---|---|
| `app/api/webhooks/slack/route.ts` | Slack event handler — sig verify, echo guard, `after()` dispatch |
| `app/api/cron/slack-stale-check/route.ts` | Hourly stale-thread nudge |
| `lib/slack/client.ts` | Slack Web API wrapper (postMessage, openDM, getThreadReplies) |
| `lib/slack/verify.ts` | HMAC-SHA256 signature verification |
| `lib/issue-triage/conversation.ts` | Intake phase: Claude call, state update, Slack reply |
| `lib/issue-triage/duplicate-detection.ts` | Fetch all active ClickUp tasks, run triage Claude prompt |
| `lib/issue-triage/workaround-search.ts` | `searchVault()` call + Claude ranking pass |
| `lib/issue-triage/router.ts` | `routeTicket()` — executes the routing decision, creates/updates ClickUp task; also called by `detectDuplicate()` to move a ticket to Planning when its bumped priority reaches "high" |
| `supabase/migrations/010_slack_issues.sql` | `slack_issues` table + enum + indexes |

### Changed files

| Path | Change |
|---|---|
| `lib/clickup/client.ts` | Add `createTask`, `moveTask`, `setTaskPriority` |
| `vercel.json` | Add cron entry for `/api/cron/slack-stale-check` |

---

## 12. Out of Scope

- Slack slash commands or bot mentions as alternative triggers
- pgvector / embedding-based search (Claude-as-ranker over GitHub Search results is sufficient)
- Socket Mode (incompatible with Vercel serverless)
- Any UI in the pm-app for viewing Slack issues (ClickUp is the source of truth)
- Multi-workspace Slack support

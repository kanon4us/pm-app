# Slack Bot Workflow Redesign + Self-Improving SOP System

**Date:** 2026-05-05
**Status:** Approved for implementation planning

---

## Problem Statement

The current Slack bot withholds ticket creation until after a multi-turn interview is complete. The team was not engaging with the bot's questions, so no tickets were being created. Additionally, any non-reporter message in a thread permanently silenced the bot, preventing team members from providing triage feedback.

---

## Goals

1. Create ClickUp tickets immediately on first message so the team has something to act on
2. Run early duplicate detection and progressively refine it as more info is gathered
3. Allow team members to give triage feedback in the thread without silencing the bot
4. Hand off cleanly when a dev claims the ticket in ClickUp
5. Store behavioral rules (SOPs) in Supabase so they can be updated without code deploys
6. Build a self-analysis layer that proposes SOP improvements based on outcome data
7. Route all SOP changes through a PM approval gate before going live
8. Collect dual-channel feedback (reporter sentiment + dev emoji reactions) to train the analysis layer
9. Handle media attachments (screen recordings, screenshots) via multimodal triage
10. Give PMs direct control over bot behavior via manual directives without code deploys

---

## Architecture Overview

Four layers working together:

**Runtime Layer** — The live bot. Reads its behavioral rules from Supabase at runtime. Handles Slack events, creates/enriches ClickUp tickets, runs duplicate detection, processes media attachments.

**Observation Layer** — Built into every bot action. Records structured outcome data (confidence scores, turn counts, team corrections, escalations, human feedback) to `bot_observations`.

**Analysis Layer** — A weekly cron job that reads observations, identifies patterns, consults rejection history before drafting, and generates proposed SOP changes with supporting evidence.

**Approval Layer** — Proposed changes posted to `#bot-improvements` in Slack. PM approves or rejects with optional reason. Approved changes become the new active SOP. Full version history preserved.

---

## Section 1 — New Core Workflow

### On First Message (Reporter Posts in Issues Channel)

Four things happen on receipt of the first message:

1. **File check** — Slack payload is inspected for attachments (screen recordings, screenshots). Any files found are immediately uploaded to the ClickUp ticket as attachments and their Slack permalinks added to the description. If an image is present, Claude runs a visual triage pass to generate a one-line summary (e.g., *"User clicking Export — progress bar stuck at 0%"*) prepended to the ticket description.

2. **ClickUp ticket created** in New Tickets list with: initial message, visual summary if applicable, original Slack message permalink, and file attachment links.

3. **Quick initial duplicate check** runs on the raw message text (and visual summary if present).

4. **Bot replies in thread** with:
   - Link to the created ClickUp ticket
   - Link to the original Slack message
   - Duplicate status: either *"No related tickets found at this time."* or *"⚠️ Possible duplicate of [task link] — monitoring as we learn more."*
   - First enrichment question (pulled from active SOP, including any `manual_directives`)

Observation recorded: `ticket_created` — initial triage confidence score, SOP version, whether media was present.

### On Each Reporter Follow-up

- ClickUp ticket description updated in real-time with accumulated structured data
- Duplicate detection re-runs with the richer ticket; thread updated if confidence changes materially
- Any new file attachments in the reply are uploaded to the ClickUp ticket immediately
- Next SOP question asked, OR escalation triggered if SOP escalation rules are met:
  > *"I don't have enough information to help you at this time — support will reach out within 24 hours."*

Observation recorded: `enrichment_turn` — turn count, confidence delta, question asked, whether reporter answered or deflected.

### On Confirmed Duplicate (High-Confidence Match)

When duplicate confidence crosses the confirmed threshold:

- Bot posts in thread: *"This looks like a known issue. Here's the existing ticket: [parent link]. Your context has been added as a comment. [workaround if available]"*
- Reporter's full context (message history + any media) is appended as a new comment on the **parent** ClickUp task — not the newly created ticket
- The newly created ticket is linked to the parent and closed/archived
- Thread shifts to **passive mode**: bot stops asking questions but continues to receive messages. Any further reporter input is appended to the parent ticket as additional comments
- Observation recorded: `duplicate_confirmed` — parent task ID, confidence score, turn count at confirmation

**Urgency collision rule:** If 3 or more reporters independently trigger the same parent ticket within a 24-hour window, the bot automatically bumps the parent task priority to Urgent and posts in `#bot-improvements`:
> *"🚨 3 reports of [task name] in the last 24 hours — priority elevated to Urgent."*

Observation recorded: `priority_bump` — parent task ID, reporter count, time window.

### On Team Member Message in Thread (Before Handoff)

- Bot processes the message as triage feedback, not enrichment
- Updates ticket priority, summary, or duplicate link based on what was said
- If the message disputes a flagged duplicate (e.g., "this isn't related to X"), bot clears the duplicate flag and records a `duplicate_overridden` observation
- Acknowledges in thread what it acted on
- Does NOT trigger human takeover — team members can speak freely

Observation recorded: `team_correction` — field corrected, previous value. If a duplicate was disputed, also records `duplicate_overridden` — task ID cleared and who cleared it.

### On Reporter Disengagement

If the reporter stops responding after N turns (defined in SOP escalation rules), bot posts the escalation message and stops asking questions. Ticket remains open in ClickUp for the team to follow up.

Observation recorded: `reporter_disengaged` — turn count at disengagement, last confidence score.

### On ClickUp Status or List Change (Dev Handoff)

ClickUp webhook fires when a dev changes the ticket's status or moves it to a different list.

- Bot finds the `slack_issues` row by `clickup_task_id`
- Sets `human_takeover = true`
- Posts in thread: *"✅ Dev team has claimed this ticket — handing off."*
- Posts **reporter feedback survey** (Block Kit buttons): 🟢 Helpful  🟡 Neutral  🔴 Not Helpful
- Goes silent after posting survey

Observation recorded: `handoff_complete` — total turns, final confidence, triage confirmed/overridden.

### Removed From Current Flow

- Confirmation step ("does this look right?") — ticket already exists
- Slack-based human takeover trigger (any non-reporter message → silent forever) — replaced by ClickUp webhook
- Final routing step that moved tickets between lists — ticket stays in New Tickets unless a dev moves it

---

## Section 2 — Dual-Channel Feedback System

Two low-friction feedback mechanisms feed the observation layer with human signal.

### Reporter Survey (Post-Handoff)

When a dev claims the ticket, the bot posts a Block Kit message to the reporter in the thread:

```
How helpful was the support bot during this process?
[🟢 Helpful]  [🟡 Neutral]  [🔴 Not Helpful]
```

Response captured via `block_actions` payload. Recorded as `human_feedback` event with `source: reporter`, `sentiment: positive | neutral | negative`, `sop_version`.

### Dev Team Emoji Reactions

Dev team members react to the bot's summary message in the thread using emoji to signal triage quality:

| Reaction | Meaning |
|---|---|
| ✅ `:white_check_mark:` | Bot summary was accurate |
| ⚠️ `:warning:` | Bot missed a key detail |
| ❌ `:x:` | Complete misidentification |

The bot listens for `reaction_added` events on its own messages. Reactions from non-reporter users are recorded as `human_feedback` events with `source: dev_team`, `signal: positive | missed_detail | misidentified`, `sop_version`.

**Requires:** `reactions:read` scope added to bot OAuth permissions.

### Data Path

Both feedback streams land in `bot_observations` as `human_feedback` events. The analysis cron correlates sentiment scores against specific SOP versions — a version with a high misidentification rate from devs becomes a strong signal for a triage prompt change.

---

## Section 3 — SOP Storage and Runtime Loading

Bot behavioral rules move from hardcoded constants in `conversation.ts` to a `bot_sops` Supabase table. The bot reads the active SOP at the start of each intake turn.

### `bot_sops` Table

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `version` | integer | Increments on each approval, unique |
| `intake_prompt` | text | System prompt for Claude intake turns |
| `escalation_rules` | jsonb | Thresholds: max turns, disengagement count, min confidence movement |
| `duplicate_thresholds` | jsonb | Confidence cutoffs for "possible" vs "confirmed" duplicate |
| `manual_directives` | jsonb | PM-forced rules that override AI-generated patterns (see below) |
| `status` | text | `active` or `archived` |
| `change_summary` | text | What changed and why |
| `approved_by` | text | Slack user ID of PM who approved |
| `approved_at` | timestamptz | |
| `created_at` | timestamptz | |

Only one row has `status = active` at any time. On new approval, old row is archived. Full history preserved.

### Manual Directives

The `manual_directives` field is a JSON array of PM-authored rules that are injected into the intake prompt at runtime and cannot be overridden by the AI's generated patterns. Example:

```json
[
  {
    "trigger": "contains_word",
    "value": "glitch",
    "action": "always_ask_for_screen_recording",
    "added_by": "U020PGH3RFW",
    "added_at": "2026-05-05T00:00:00Z"
  }
]
```

Directives are editable by the PM directly in a future admin UI or via an approved `sop_proposal` that only touches the `manual_directives` field. The analysis layer never proposes changes to `manual_directives` — those are PM-owned.

### Runtime Behavior

`conversation.ts` reads the active SOP before each Claude call. `duplicate-detection.ts` reads `duplicate_thresholds` from the active SOP. Manual directives are appended to the intake prompt as an inviolable rules block. On day one the initial SOP is seeded from the current hardcoded prompts — no behavior change.

---

## Section 4 — Observation Layer

Every significant bot action writes a row to `bot_observations`.

### `bot_observations` Table

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `thread_ts` | text | FK → slack_issues |
| `clickup_task_id` | text | |
| `sop_version` | integer | Which SOP was active |
| `event_type` | text | See event types below |
| `payload` | jsonb | Event-specific structured data |
| `created_at` | timestamptz | |

### Event Types

| Event | Payload includes |
|---|---|
| `ticket_created` | Initial triage confidence, question asked, media present |
| `enrichment_turn` | Turn number, confidence delta, question asked, answer received |
| `duplicate_flagged` | Task ID flagged, confidence score |
| `duplicate_confirmed` | Parent task ID, confidence score, turn count |
| `duplicate_overridden` | Who overrode it, what the correct answer was |
| `priority_bump` | Parent task ID, reporter count, time window |
| `team_correction` | Field corrected, old value, new value |
| `escalation_triggered` | Turn count, last confidence, reason |
| `reporter_disengaged` | Turn count, last confidence |
| `handoff_complete` | Total turns, final confidence, triage confirmed/overridden |
| `human_feedback` | Source (reporter/dev_team), sentiment/signal, sop_version |

---

## Section 5 — Self-Analysis Cron

Runs at `/api/cron/sop-analysis` on a weekly schedule (or manually triggered by PM via Slack command).

### Rejection Memory

Before drafting any proposal, the cron queries the last 5 rejected `sop_proposals`. If a pattern being considered was already proposed and rejected, it is only re-raised if the supporting data has grown by at least 50% since the rejection (i.e., a much larger evidence base now exists). The PM's rejection reason is included verbatim in the new proposal so context is never lost.

### Patterns Examined

- **Duplicate accuracy** — override rate on flagged duplicates + dev ❌ reactions. High rate → thresholds need tuning.
- **Question effectiveness** — average turn at which reporters disengage. Questions past that point aren't working.
- **Escalation calibration** — escalation frequency relative to ticket resolution outcomes.
- **Correction frequency** — which ticket fields are most often corrected by devs. May indicate ambiguous or missing questions.
- **Feedback sentiment** — reporter 🔴 rate and dev ⚠️/❌ rate correlated to specific SOP questions.
- **Media triage accuracy** — when a visual summary was generated, did the dev team confirm or correct it?
- **SOP version comparison** — did metrics improve or worsen after the last approved change?

### Proposal Generation

When a pattern crosses a significance threshold (e.g., >30% override rate across 10+ tickets), Claude drafts a proposed SOP change:

- Pattern observed and supporting ticket count
- Rejection history consulted (last 5 rejections shown if relevant)
- Current SOP behavior (quoted)
- Proposed change (specific prompt text or threshold value)
- Expected outcome
- Claude's confidence in the proposal

Written to `sop_proposals` with `status = pending_review`. Only one proposal per SOP section can be pending at a time.

---

## Section 6 — PM Approval Gate

### `sop_proposals` Table

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `sop_version` | integer | Current active version being proposed to replace |
| `proposed_changes` | jsonb | Section → { old, new } for each change |
| `pattern_summary` | text | Human-readable description of pattern found |
| `supporting_data` | jsonb | Observation IDs, counts, rates |
| `rejection_history` | jsonb | Last 5 rejections consulted before drafting |
| `claude_confidence` | float | |
| `status` | text | `pending_review`, `approved`, `rejected` |
| `pm_response` | text | Optional rejection reason |
| `resolved_by` | text | Slack user ID |
| `resolved_at` | timestamptz | |
| `created_at` | timestamptz | |

### Notification Format

Posted to `#bot-improvements` when a proposal is created:

```
🤖 SOP Improvement Proposal — v{current} → v{proposed}

Pattern: Duplicate detection was overridden 6 out of 18 times (33%) over 7 days.
Dev ❌ reactions on triage summaries: 4 of 18 threads.

Current behavior: Flag as duplicate at confidence >= 0.85
Proposed change: Raise threshold to 0.90 and require two matching fields

Supporting tickets: [link]
Rejection history: No prior rejections on this pattern.
Expected outcome: Team correction rate drops below 15%
Confidence: 72%

[Approve]  [Reject]
```

### Slack App Requirement

The Approve/Reject buttons use Slack Block Kit interactive components. The Slack app must have **Interactivity & Shortcuts** enabled with the Request URL pointing to the webhook route. The handler checks `payload.type === 'block_actions'` to route these separately from event callbacks.

### On Approve

- Active SOP archived, new SOP written with proposed changes and PM's Slack user ID
- Bot posts in `#bot-improvements`: *"SOP v{N} is now active."*
- Approval recorded as a `human_feedback` observation

### On Reject

- PM optionally provides a one-line reason via free text reply
- Proposal marked `rejected` with reason stored
- Bot continues on current SOP
- Rejection feeds into next analysis cycle's rejection memory check

### Guardrails

- SOP changes never auto-apply — PM action always required
- No proposal queue that bypasses review
- `manual_directives` are never touched by the analysis layer
- Any SOP version can be restored from archive

---

## Section 7 — Data Model Changes Summary

### Modified: `slack_issues`

- Add `sop_version integer` — which SOP was active when thread started
- Remove Slack-based `human_takeover` trigger from webhook handler — only set via ClickUp webhook now

### Modified: `bot_sops`

- Add `manual_directives jsonb` column (see Section 3)

### New Tables

- `bot_observations`
- `sop_proposals`

### ClickUp Webhook Handler

Extend subscription from `taskStatusUpdated` only to also include task-moved events. On either event: find `slack_issues` by `clickup_task_id`, set `human_takeover = true`, post handoff message + reporter feedback survey in thread.

---

## Files Changed

| File | Change |
|---|---|
| `app/api/webhooks/slack/route.ts` | Remove Slack-based takeover; add team-feedback branch; add `block_actions` branch (Approve/Reject + reporter survey); add `reaction_added` handler; add observation writes |
| `app/api/webhooks/clickup/route.ts` | Add handoff + reporter survey on status/list change |
| `lib/issue-triage/conversation.ts` | Read SOP + manual_directives from Supabase; remove hardcoded prompt |
| `lib/issue-triage/duplicate-detection.ts` | Read thresholds from active SOP; add urgency collision check |
| `lib/issue-triage/router.ts` | Simplify — remove list routing; add parent-ticket comment logic for confirmed duplicates |
| `lib/issue-triage/media.ts` | New — file detection, ClickUp upload, Claude visual triage |
| `lib/issue-triage/observations.ts` | New — helper to write `bot_observations` rows |
| `lib/issue-triage/sop.ts` | New — fetch active SOP from Supabase |
| `app/api/cron/sop-analysis/route.ts` | New — weekly analysis cron with rejection memory |
| `supabase/migrations/011_bot_sops.sql` | New — `bot_sops` (with `manual_directives`), `bot_observations`, `sop_proposals` tables |

---

## Required Environment Variables (New)

| Variable | Purpose |
|---|---|
| `SLACK_BOT_IMPROVEMENTS_CHANNEL_ID` | Channel ID for `#bot-improvements` |

## Required Slack App Configuration (New)

- Enable **Interactivity & Shortcuts** — Request URL: `https://viscap.edgefixautomation.com/api/webhooks/slack`
- Add OAuth scope: `reactions:read` (for dev emoji reaction capture)
- Reinstall app to workspace after scope change

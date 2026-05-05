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

---

## Architecture Overview

Four layers working together:

**Runtime Layer** — The live bot. Reads its behavioral rules from Supabase at runtime. Handles Slack events, creates/enriches ClickUp tickets, runs duplicate detection.

**Observation Layer** — Built into every bot action. Records structured outcome data (confidence scores, turn counts, team corrections, escalations) to `bot_observations`.

**Analysis Layer** — A weekly cron job that reads observations, identifies patterns, and generates proposed SOP changes with supporting evidence.

**Approval Layer** — Proposed changes posted to `#bot-improvements` in Slack. PM approves or rejects. Approved changes become the new active SOP. Full version history preserved.

---

## Section 1 — New Core Workflow

### On First Message (Reporter Posts in Issues Channel)

Three things happen in parallel:
1. ClickUp ticket created immediately in the New Tickets list, with the initial message as description and a permalink to the original Slack message
2. Quick initial duplicate check runs on the raw message
3. Bot replies in the thread with:
   - Link to the created ClickUp ticket
   - Link to the original Slack message
   - Duplicate status: either *"No related tickets found at this time."* or *"⚠️ Possible duplicate of [task link] — monitoring as we learn more."*
   - First enrichment question (pulled from active SOP)

Observation recorded: `ticket_created` — includes initial triage confidence score and SOP version.

### On Each Reporter Follow-up

- ClickUp ticket description updated in real-time with accumulated structured data
- Duplicate detection re-runs with the richer ticket; thread updated if confidence changes materially
- Next SOP question asked, OR escalation triggered if SOP escalation rules are met:
  > *"I don't have enough information to help you at this time — support will reach out within 24 hours."*

Observation recorded: `enrichment_turn` — turn count, confidence delta, question asked, whether reporter answered or deflected.

### On Team Member Message in Thread (Before Handoff)

- Bot processes the message as triage feedback, not enrichment
- Updates ticket priority, summary, or duplicate link based on what was said
- If the message disputes a flagged duplicate (e.g., "this isn't related to X"), bot clears the duplicate flag and records a `duplicate_overridden` observation
- Acknowledges in thread what it acted on
- Does NOT trigger human takeover — team members can speak freely

Observation recorded: `team_correction` — what field was corrected, what the previous value was. If a duplicate was disputed, also records `duplicate_overridden` — the task ID that was cleared and who cleared it.

### On Reporter Disengagement

If the reporter stops responding after N turns (defined in SOP escalation rules), bot posts the escalation message and stops asking questions. Ticket remains open in ClickUp for the team to follow up.

Observation recorded: `reporter_disengaged` — turn count at disengagement, last confidence score.

### On ClickUp Status or List Change (Dev Handoff)

ClickUp webhook fires when a dev changes the ticket's status or moves it to a different list.

- Bot finds the `slack_issues` row by `clickup_task_id`
- Sets `human_takeover = true`
- Posts in thread: *"✅ Dev team has claimed this ticket — handing off."*
- Goes silent

Observation recorded: `handoff_complete` — turn count, triage accuracy at handoff, whether duplicate detection was confirmed or overridden.

### Removed From Current Flow

- Confirmation step ("does this look right?") — ticket already exists, no need to confirm before creating
- Slack-based human takeover trigger (any non-reporter message → silent forever) — replaced by ClickUp webhook trigger
- Final routing step that moved tickets between lists — ticket stays in New Tickets unless a dev moves it (which triggers handoff)

---

## Section 2 — SOP Storage and Runtime Loading

Bot behavioral rules move from hardcoded constants in `conversation.ts` to a `bot_sops` Supabase table. The bot reads the active SOP at the start of each intake turn.

### `bot_sops` Table

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `version` | integer | Increments on each approval, unique |
| `intake_prompt` | text | System prompt for Claude intake turns |
| `escalation_rules` | jsonb | Thresholds: max turns, disengagement count, min confidence movement |
| `duplicate_thresholds` | jsonb | Confidence cutoffs for "possible" vs "confirmed" duplicate |
| `status` | text | `active` or `archived` |
| `change_summary` | text | What changed and why |
| `approved_by` | text | Slack user ID of PM who approved |
| `approved_at` | timestamptz | |
| `created_at` | timestamptz | |

Only one row has `status = active` at any time. On new approval, old row is archived. Full history is preserved.

### Runtime Behavior

`conversation.ts` reads the active SOP before each Claude call. `duplicate-detection.ts` reads `duplicate_thresholds` from the active SOP. On day one the initial SOP is seeded from the current hardcoded prompts — no behavior change, just moving to the database.

---

## Section 3 — Observation Layer

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
| `ticket_created` | Initial triage confidence, question asked |
| `enrichment_turn` | Turn number, confidence delta, question asked, answer received |
| `duplicate_flagged` | Task ID flagged, confidence score |
| `duplicate_overridden` | Who overrode it, what the correct answer was |
| `team_correction` | Field corrected, old value, new value |
| `escalation_triggered` | Turn count, last confidence, reason |
| `reporter_disengaged` | Turn count, last confidence |
| `handoff_complete` | Total turns, final confidence, triage confirmed/overridden |

---

## Section 4 — Self-Analysis Cron

Runs at `/api/cron/sop-analysis` on a weekly schedule (or manually triggered by PM).

### Patterns Examined

- **Duplicate accuracy** — override rate on flagged duplicates. High rate → thresholds need tuning.
- **Question effectiveness** — average turn at which reporters disengage. Questions past that point aren't working.
- **Escalation calibration** — are escalations triggering too early or too late based on resolution outcomes?
- **Correction frequency** — which ticket fields are most often corrected by the team? May indicate ambiguous or missing questions.
- **SOP version comparison** — did key metrics improve or worsen after the last approved SOP change? Informs whether to continue or revert direction.

### Proposal Generation

When a pattern crosses a significance threshold (e.g., >30% override rate across 10+ tickets), Claude drafts a proposed SOP change:

- Pattern observed and number of supporting tickets
- Current SOP behavior (quoted)
- Proposed change (specific prompt text or threshold value)
- Expected outcome
- Claude's confidence in the proposal

Written to `sop_proposals` with `status = pending_review`. Only one proposal per SOP section can be pending at a time.

---

## Section 5 — PM Approval Gate

### `sop_proposals` Table

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `sop_version` | integer | Version this proposes to replace |
| `proposed_changes` | jsonb | Section → { old, new } for each change |
| `pattern_summary` | text | Human-readable description of pattern found |
| `supporting_data` | jsonb | Observation IDs, counts, rates |
| `claude_confidence` | float | |
| `status` | text | `pending_review`, `approved`, `rejected` |
| `pm_response` | text | Optional rejection reason |
| `resolved_by` | text | Slack user ID |
| `resolved_at` | timestamptz | |
| `created_at` | timestamptz | |

### Notification Format

Posted to `#bot-improvements` when a proposal is created:

```
🤖 SOP Improvement Proposal v{N}

Pattern: Duplicate detection was overridden 6 out of 18 times (33%) over the last 7 days.

Current behavior: Flag as duplicate at confidence >= 0.85
Proposed change: Raise threshold to 0.90 and require two matching fields, not one

Supporting tickets: [link to observation IDs]
Expected outcome: Fewer false positives; team correction rate drops below 15%
Confidence: 72%

[Approve]  [Reject]
```

### Slack App Requirement

The Approve/Reject buttons use Slack Block Kit interactive components. The Slack app must have **Interactivity & Shortcuts** enabled in its settings, with the Request URL pointing to a new handler branch in the webhook route. The webhook handler checks `payload.type === 'block_actions'` to route these separately from event callbacks.

### On Approve

- Active SOP archived, new SOP written with proposed changes and PM's Slack user ID
- Bot posts in `#bot-improvements`: *"SOP v{N} is now active."*
- Approval recorded as an observation so future analysis knows what PM endorsed

### On Reject

- PM optionally provides a one-line reason via free text reply
- Proposal marked `rejected` with reason stored
- Bot continues on current SOP
- Rejection reason feeds into next analysis cycle — same change won't be re-proposed without new supporting evidence

### Guardrails

- SOP changes never auto-apply — PM action always required
- No proposal queue that bypasses review
- Any SOP version can be restored from archive

---

## Section 6 — Data Model Changes Summary

### Modified: `slack_issues`

Add column: `sop_version integer` — records which SOP was active when the thread started.

Remove behavior: the Slack-based `human_takeover` trigger (non-reporter message → silent) is deleted from the webhook handler. `human_takeover` is now only set via the ClickUp webhook.

### New Tables

- `bot_sops`
- `bot_observations`
- `sop_proposals`

### ClickUp Webhook Handler

Currently subscribed to `taskStatusUpdated` only. Extend to also handle task-moved events. On either event: find `slack_issues` by `clickup_task_id`, set `human_takeover = true`, post handoff message in thread.

---

## Files Changed

| File | Change |
|---|---|
| `app/api/webhooks/slack/route.ts` | Remove Slack-based takeover trigger; add team-feedback branch; add `block_actions` branch for Approve/Reject; add observation writes |
| `app/api/webhooks/clickup/route.ts` | Add handoff logic on status/list change |
| `lib/issue-triage/conversation.ts` | Read SOP from Supabase; remove hardcoded prompt |
| `lib/issue-triage/duplicate-detection.ts` | Read thresholds from active SOP |
| `lib/issue-triage/router.ts` | Simplify — ticket stays in New Tickets; remove list routing |
| `lib/issue-triage/observations.ts` | New — helper to write `bot_observations` rows |
| `lib/issue-triage/sop.ts` | New — fetch active SOP from Supabase |
| `app/api/cron/sop-analysis/route.ts` | New — weekly analysis cron |
| `supabase/migrations/011_bot_sops.sql` | New — `bot_sops`, `bot_observations`, `sop_proposals` tables |

## Required Environment Variables (New)

| Variable | Purpose |
|---|---|
| `SLACK_BOT_IMPROVEMENTS_CHANNEL_ID` | Channel ID for `#bot-improvements` where SOP proposals are posted |

## Required Slack App Configuration (New)

- Enable **Interactivity & Shortcuts** in the Slack app settings
- Set the Interactivity Request URL to `https://viscap.edgefixautomation.com/api/webhooks/slack`

# Help & Resources Chatbot — Phase 0 + Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-06-09-help-resources-chatbot-phase0-1.md` — read it first. All settled decisions are D1–D7 in that doc.

**Goal:** Replace ClickConnector with an access-aware chatbot: pm-app supplies the brain (`/api/bot/*`), viscap-ai-cloud-functions proxies and owns customer data, Typesense serves entitlement-filtered lesson retrieval, education-cms hosts the migrated Help & Resources manuals, and the app.viscap.ai side panel + chat UI present it. Ship behind a feature flag, shadow-test against a golden question set, cut over only when criteria pass.

**Architecture:** Five repos. pm-app (Vercel/Supabase) = brain + policies + observations. viscap-ai-cloud-functions = `helpBot` proxy module, scoped-key minting, Firestore conversation persistence. education-cms = lesson schema + manual migration. app.viscap.ai = panel + chat UI behind flag. documentation vault = migration source. Customer data never leaves Firebase (D6); pm-app stores derived signals only.

**Tech Stack:** Next.js App Router (pm-app), Supabase + pgvector, Anthropic SDK, Express cloud functions (Firebase), Firestore, Typesense, GCP Secret Manager, Jest, Ant Design.

---

## Workstream Map

| WS | Repo | What | Depends on |
|---|---|---|---|
| 0A | pm-app | Golden question set + scoring sheet | — |
| 0B | — | Region verification + Vercel pin | — |
| 0C | education-cms | Lesson schema extension + 3–5 manual pilot | — |
| 1 | pm-app | DB migrations: policies, observations, app_settings | — |
| 2 | pm-app + cloud-functions | JWT trust + `/api/bot/health` + helpBot skeleton | 1 |
| 3 | cloud-functions | Typesense `lessons` collection + indexing hook + scoped-key minting | 0C |
| 4 | pm-app | Bot brain: classify + chat + SOP-driven flows + ripcord | 1, 2, 3 |
| 5 | cloud-functions | Side effects: action/confirm (tickets, Slack DMs, dedup writes) | 4 |
| 6 | app.viscap.ai | Side panel redesign + chat UI behind feature flag | 3, 4 |
| 7 | education-cms + vault | Batch-migrate remaining ~17 manuals | 0C locked |
| 8 | all | Shadow test, scoring, cutover gate, ClickConnector retirement | all |

Critical path: 1 → 2 → 4 → 6 → 8. Workstreams 0A/0B/0C/3 run in parallel up front.

---

## File Map

### pm-app
- Create: `supabase/migrations/018_bot_chat.sql`
- Create: `lib/bot/auth.ts` (JWT validation)
- Create: `lib/bot/policies.ts` (active policy loader, mirrors `lib/issue-triage/sop.ts`)
- Create: `lib/bot/observations.ts` (derived-signal recorder, mirrors `lib/issue-triage/observations.ts`)
- Create: `lib/bot/classify.ts`
- Create: `lib/bot/chat.ts` (turn orchestration: retrieve → answer → cite → propose actions)
- Create: `lib/bot/dedup.ts` (reuses embedding approach from `lib/issue-triage/duplicate-detection.ts`)
- Create: `app/api/bot/health/route.ts`
- Create: `app/api/bot/classify/route.ts`
- Create: `app/api/bot/chat/route.ts`
- Create: `app/api/settings/route.ts` (app_settings CRUD, auth required)
- Create: `app/settings/page.tsx` (PM/marketing Slack IDs editable in UI)
- Create: `docs/golden-set/golden-questions.csv` + `docs/golden-set/README.md`
- Create: `__tests__/lib/bot/*.test.ts`, `__tests__/api/bot/*.test.ts`
- Modify: `proxy.ts` (PUBLIC_PATHS: none — `/api/bot/*` uses its own JWT check, add to matcher exclusion comment)
- Modify: `lib/supabase/types.ts` (new tables)
- Modify: `vercel.json` (region pin per 0B finding)

### viscap-ai-cloud-functions
- Create: `functions/src/v1/modules/helpBot/route.ts`
- Create: `functions/src/v1/modules/helpBot/controller.ts`
- Create: `functions/src/v1/modules/helpBot/service.ts` (pm-app client, conversation persistence, entitlement resolution)
- Create: `functions/src/v1/modules/helpBot/panelKey.ts` (scoped Typesense key minting)
- Create: `functions/src/v1/modules/helpBot/actions.ts` (confirmed side effects)
- Create: `functions/src/v1/modules/helpBot/validations.ts`, `types.ts`
- Modify: `functions/src/v1/modules/index.ts` (mount route)
- Modify: `functions-typesense/src/typesense.ts` + new `functions-typesense/src/typesense/tsLesson.ts` (lessons collection hook)

### education-cms
- Modify: lesson type/schema (add `type`, `parent_lesson_id`, `surface_slugs`, `roles`, `product_id`, `related_lesson_ids`, `tour_id`, `superseded_by`)
- Create: editor UI fields for the above
- Create: CI script `scripts/validate-surface-slugs.ts` (validates against app.viscap.ai route manifest)

### app.viscap.ai
- Create: `components/Admin/HelpResources/HelpPanel.tsx` (slug-matched lesson list, direct Typesense)
- Create: `components/Admin/HelpResources/HelpChat.tsx`
- Create: `hooks/useHelpPanelKey.ts` (scoped key fetch + refresh)
- Modify: `components/Admin/AdminNav/AdminNav.tsx` (feature-flagged swap: ClickConnector ↔ new panel)
- Create: `scripts/export-route-manifest.ts` (emit route list for CI slug validation)

### documentation vault
- Modify: pilot manuals gain frontmatter `cms_lesson_id` after migration

---

## WORKSTREAM 0A: Golden Question Set

### Task 1: Mine and structure the golden set

- [ ] **Step 1:** Export ClickConnector conversation history (admin → export; if no export exists, screenshot/copy the most recent ~200 conversations) and pull the last 6 months of closed support-type ClickUp tasks (`CLICKUP_NEW_TICKETS_LIST_ID` + resolved lists) via API.
- [ ] **Step 2:** Create `docs/golden-set/golden-questions.csv` in pm-app with columns:
  `id, question, category(question|user_error|bug|feature_suggestion), expected_answer_summary, expected_citation(lesson/manual name), source(clickconnector|clickup), notes`
- [ ] **Step 3:** Curate 50–100 entries. Coverage floor: ≥10 per category, ≥1 per Manual/ article where possible. Mark ~10 as "must-escalate" (no correct answer exists — tests the ripcord).
- [ ] **Step 4:** Write `docs/golden-set/README.md`: scoring rubric — per question score `correct+cited / correct+uncited / wrong-hedged / confidently-wrong / escalated`. Define cutover math: accuracy = (correct+cited)/total ≥ 70%; confidently-wrong/total < 2%.
- [ ] **Step 5:** Commit. This file is a permanent regression asset — note in README: rerun on every embedding-model or chunking change.

---

## WORKSTREAM 0B: Region Verification (D7)

### Task 2: Verify and pin regions

- [ ] **Step 1:** Record actual regions: Supabase dashboard → Settings → Infrastructure; Typesense Cloud dashboard (or cluster config) → region; note GCP cloud functions region (likely `us-central1`, check `firebase.json`/deploy config).
- [ ] **Step 2:** Add to `vercel.json`: `"regions": ["<closest-to-typesense-and-gcp>"]` (e.g. `iad1` for us-east, `cle1`/`pdx1` per actuals). Chat path latency = Vercel→Typesense + Vercel→Anthropic + CF→Vercel; optimize for the Typesense+GCP leg.
- [ ] **Step 3:** Document findings in the spec under D7 (edit the spec file, replace "verify, then pin" with actuals). Commit.

---

## WORKSTREAM 0C: Lesson Schema Pilot (education-cms)

### Task 3: Extend the lesson schema

- [ ] **Step 1:** Locate the lesson type definition in education-cms (`src/types.ts` / feature types) and the Firestore lesson document shape used by `viscap-ai-cloud-functions` education module. Add optional fields:

```typescript
type LessonType = 'workflow' | 'feature'
interface LessonExtensions {
  type?: LessonType                  // default 'workflow' for migrated manuals
  parent_lesson_id?: string | null   // folder nesting; validate acyclic on save
  surface_slugs?: string[]           // route patterns, e.g. '/admin/shotlists', '/admin/creatives/[id]'
  roles?: string[]
  product_id?: string                // 'help-resources-free' or paid product doc ID
  related_lesson_ids?: string[]      // navigation links only — never inlined (D5)
  tour_id?: string | null            // Phase 3 hook
  superseded_by?: string | null      // tombstone (D5/lifecycle)
}
```

- [ ] **Step 2:** Acyclic guard: on save, walk `parent_lesson_id` ancestry; reject if the lesson's own ID appears. Add unit test.
- [ ] **Step 3:** Editor UI: add fields to the lesson editor (type select, parent picker, slugs tag-input, roles multi-select, product select, related-lessons picker). Tombstone: "supersede" action replaces delete — sets `superseded_by`, hides from listings.
- [ ] **Step 4:** Create the `help-resources-free` product in education-cms if absent (Product → Modules mirroring Manual/ groupings: Onboarding, Creatives, Talent, Media, Education access).

### Task 4: Route manifest + CI slug validation

- [ ] **Step 1:** In app.viscap.ai, create `scripts/export-route-manifest.ts`: walk `pages/`, emit JSON array of route patterns (`/admin/shotlists`, `/admin/creatives/[id]`, …) to `route-manifest.json`. Add npm script `manifest:routes`.
- [ ] **Step 2:** In education-cms, create `scripts/validate-surface-slugs.ts`: fetch all lessons' `surface_slugs`, match each against the manifest (treat `[param]` as wildcard segments). Exit 1 listing offenders.
- [ ] **Step 3:** Wire as CI job (nightly or on cms deploy) with the manifest committed/published from app.viscap.ai CI. Slug rot now fails loudly.

### Task 5: Pilot-migrate 3–5 interconnected manuals

- [ ] **Step 1:** Pick the most interconnected cluster from `documentation/Manual/` — recommended: *Making a Creative*, *Making a Shotlist*, *Making a Shooting Session*, *Associating Footage with a Storyboard from a Shooting Session*, *Uploading Final Deliverables and Elements* (shared features: Media Library, naming, permissions).
- [ ] **Step 2:** For each: create a workflow lesson; split major sections into sub-lessons (`parent_lesson_id`); extract feature-specific passages into `type:'feature'` lessons wired via `related_lesson_ids`; assign `surface_slugs` from the actual pages where the workflow happens; assign roles + `help-resources-free`.
- [ ] **Step 3:** Add `cms_lesson_id: <id>` frontmatter to each migrated vault file.
- [ ] **Step 4:** Review the structure with CS (content owner per decision: "Customer Success approved the education product being updated"). **Lock the schema** — record any field changes in the spec before Task 18 batch migration.

---

## WORKSTREAM 1: pm-app DB Migrations

### Task 6: Migration 018 — bot chat tables

- [ ] **Step 1:** Create `supabase/migrations/018_bot_chat.sql`:

```sql
-- 018_bot_chat.sql
CREATE TABLE bot_chat_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  classification_prompt TEXT NOT NULL,
  answer_prompt TEXT NOT NULL,
  escalation_rules JSONB NOT NULL DEFAULT '{}',   -- {max_turns, min_confidence, must_escalate_phrases[]}
  citation_rules JSONB NOT NULL DEFAULT '{}',     -- {require_citation: true, max_citations: 3}
  manual_directives TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by TEXT
);

CREATE TABLE bot_chat_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_ref TEXT NOT NULL,                 -- Firestore doc ID, reference only (D6)
  turn_index INT NOT NULL,
  policy_version INT NOT NULL,
  classification TEXT,                            -- question|user_error|bug|feature_suggestion|escalation
  query_embedding vector(1536),                   -- pgvector already enabled (mig 012)
  cited_lesson_ids TEXT[] NOT NULL DEFAULT '{}',  -- Firestore lesson IDs
  page_slug TEXT,
  workspace_id TEXT,                              -- team ID for distinct-workspace struggle counts (D1)
  answered BOOLEAN,
  confidence NUMERIC,
  event_type TEXT NOT NULL,                       -- turn|content_gap|escalated|action_proposed|action_confirmed
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_bot_obs_slug ON bot_chat_observations(page_slug);
CREATE INDEX idx_bot_obs_workspace ON bot_chat_observations(workspace_id);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);
INSERT INTO app_settings (key, value) VALUES
  ('pm_slack_user_id', ''),            -- set in UI; CTO acting PM today
  ('marketing_slack_user_id', 'UJSASV0L9'),
  ('uiux_notification_channel', '');
```

⚠️ **NOTE:** message text columns are intentionally absent from `bot_chat_observations` (D6). Do not add them.

- [ ] **Step 2:** Seed `bot_chat_policies` v1 in the same migration (or `019_seed_bot_policy.sql` following the 012/013 pattern): classification prompt distinguishing the four intents; answer prompt mandating citation-or-escalate; escalation rules `{max_turns: 6, min_confidence: 0.5}`.
- [ ] **Step 3:** Apply in Supabase SQL Editor; update `lib/supabase/types.ts` (hand-edit rows like existing style or regen). Commit.

### Task 7: Policy + observation libs

- [ ] **Step 1:** `lib/bot/policies.ts` — `getActiveChatPolicy()` mirroring `lib/issue-triage/sop.ts` (read where status='active', cache per-request). Test.
- [ ] **Step 2:** `lib/bot/observations.ts` — `recordChatObservation(obs)` mirroring `lib/issue-triage/observations.ts`: insert, console.error on failure, never throw. Add a guard that strips/refuses any `message`/`text` keys passed accidentally (privacy boundary D6). Test the guard.
- [ ] **Step 3:** `app/settings/page.tsx` + `app/api/settings/route.ts` — table-driven editor for `app_settings` (auth required, NextAuth session). PM Slack ID becomes runtime-configurable here.

---

## WORKSTREAM 2: JWT Trust + Skeletons

### Task 8: Shared-secret JWT between cloud functions and pm-app

- [ ] **Step 1:** Generate an HS256 secret. Store in GCP Secret Manager as `pmapp-bot-jwt-secret`; add the same value to pm-app Vercel env as `BOT_JWT_SECRET`.
- [ ] **Step 2:** pm-app `lib/bot/auth.ts`:

```typescript
import { createHmac, timingSafeEqual } from 'crypto'
// verifyBotJwt(authHeader): validates HS256 JWT — iss='viscap-cloud-functions',
// aud='pm-app-bot', exp check. Payload carries: userId, teamId (workspace),
// email, roles[], entitlements: string[] (product IDs), pageSlug?.
// Throws on any failure. Entitlements come ONLY from this verified payload.
```

Mirror the proxy.ts decode-style error handling. Unit-test: valid, expired, bad-sig, missing-aud.

- [ ] **Step 3:** `app/api/bot/health/route.ts` — GET, JWT-required, returns `{ok, policyVersion}`.
- [ ] **Step 4:** Confirm `proxy.ts` matcher: `/api/bot/*` must NOT be in PUBLIC_PATHS (it has its own auth) but the proxy's session check would 401 it — add `/api/bot` to PUBLIC_PATHS with a comment: "authenticated by BOT_JWT_SECRET in lib/bot/auth.ts, not by session."

### Task 9: helpBot module skeleton (cloud functions)

- [ ] **Step 1:** Scaffold `functions/src/v1/modules/helpBot/{route,controller,service,validations,types}.ts` following the `support/` module shape. Routes (all behind existing `auth.authenticate` Firebase middleware):
  - `POST /help-bot/message`
  - `POST /help-bot/panel-key`
  - `POST /help-bot/action/confirm`
- [ ] **Step 2:** `service.ts`: `callPmApp(path, payload)` — reads `pmapp-bot-jwt-secret` via `readSecret` (Mercury pattern, see `performanceHub/service.ts`), signs a short-lived JWT (5 min) with the user context from `req.user` + entitlements, POSTs to `PMAPP_BOT_URL` env. Entitlement resolution: call the existing internal stripe products lookup (same data as `/stripe/user/:id/products`) server-side — never trust client-supplied entitlements.
- [ ] **Step 3:** Conversation persistence: `helpConversations/{conversationId}` doc + `messages` subcollection (role, text, citations, createdAt). `message` handler: persist user msg → callPmApp → persist reply → return reply.
- [ ] **Step 4:** Mount in `modules/index.ts`. Deploy to staging; verify `/help-bot/message` round-trips to pm-app `/api/bot/health` (temporary wiring) with a valid Firebase ID token.

---

## WORKSTREAM 3: Typesense Lessons + Scoped Keys

### Task 10: Lessons collection + indexing hook

- [ ] **Step 1:** In `functions-typesense`, add `tsLesson.ts` following `tsCreative.ts` pattern. Collection `lessons`: `id, title, body (chunked), type, surface_slugs[], roles[], product_id, superseded (bool), embedding (auto-embed or precomputed)`. Firestore trigger on lesson writes.
- [ ] **Step 2:** Tombstone handling: if `superseded_by` set → delete from collection immediately (D5 lifecycle). Test with a superseded pilot lesson.
- [ ] **Step 3:** Backfill script for pilot lessons; verify search returns them with `filter_by: product_id:[help-resources-free]`.

### Task 11: Scoped key minting

- [ ] **Step 1:** `helpBot/panelKey.ts`: using the Typesense admin key (Secret Manager), generate a **scoped search key**: `filter_by: product_id:[free + owned product IDs] && superseded:false`, expires 15 min. Return `{key, expiresAt}`.
- [ ] **Step 2:** Cache per (user, entitlement-hash) for the TTL window to avoid minting per keystroke.
- [ ] **Step 3:** Verify a scoped key CANNOT retrieve a paid lesson for a free user (write an integration test or manual curl check — this is the entitlement enforcement layer, D2).

---

## WORKSTREAM 4: The Brain (pm-app)

### Task 12: Classification

- [ ] **Step 1:** `lib/bot/classify.ts` — Claude call using `classification_prompt` from active policy. Returns `{intent, confidence}`. Retrieved/page context is data-only (injection posture: wrap user text in delimiters, instruct model to ignore embedded instructions).
- [ ] **Step 2:** `app/api/bot/classify/route.ts` — JWT-auth, calls classify, records observation (`event_type:'turn'`, classification, embedding). Tests with mocked Anthropic client.

### Task 13: Chat orchestration

- [ ] **Step 1:** `lib/bot/chat.ts` — the turn loop:
  1. classify (or continue prior intent from conversation context passed by CF)
  2. retrieve: query Typesense `lessons` with the **server-side entitlement filter rebuilt from JWT claims** (never from request body)
  3. answer with citations (lesson IDs + titles) — if no adequate retrieval, route to ripcord proposal
  4. per-intent SOP behavior (Task 14)
  5. return `{reply, citations[], proposedAction?}` — proposedAction is a draft only (ticket payload, DM payload); execution happens in CF after user confirm
  6. record observation (derived signals only)
- [ ] **Step 2:** Budgets: token count per conversation (running total passed by CF, refuse over budget with friendly handoff); per-workspace monthly counter in Supabase (`app_settings`-adjacent or simple counts table). Tests.
- [ ] **Step 3:** `app/api/bot/chat/route.ts` — wire it. Integration test: golden-set question → mocked Typesense + Anthropic → cited answer shape.

### Task 14: Intent SOPs + ripcord

- [ ] **Step 1: Ripcord first.** Any turn where the bot cannot answer (low confidence, empty retrieval, user asks for human, max_turns hit): reply proposes escalation; `proposedAction: {type:'create_support_ticket', payload:{name, description}}`. CF attaches full conversation from Firestore at execution. Observation `event_type:'escalated'`.
- [ ] **Step 2: User error:** retrieval hit on a workflow lesson matching the user's confusion → serve lesson + steps; `proposedAction: {type:'notify_uiux', payload:{slug, lessonId, summary}}` (auto-executable — notification, not a write on the user's behalf; CF posts to `uiux_notification_channel`). No lesson found → observation `content_gap`.
- [ ] **Step 3: Bug:** SOP-defined diagnostic interview (questions from policy `manual_directives`/escalation rules); after interview, `lib/bot/dedup.ts` embeds the structured report and compares against open ClickUp ticket embeddings (reuse `lib/issue-triage/duplicate-detection.ts` cosine approach; store ticket embeddings in a small `ticket_embeddings` table refreshed by the existing triage flow). Duplicate → `proposedAction: {type:'bump_duplicate', parentTaskId}`; original → `proposedAction: {type:'create_bug_ticket', payload}`.
- [ ] **Step 4: Feature suggestion:** interview → rewrite into template (Problem / Current workaround / Proposed behavior / Affected workflow & role / Frequency) → show rewrite → user approval = the confirm action `{type:'file_suggestion', payload}` (interim Phase 1 target: ClickUp Planning list; Phase 2 swaps target to the board).
- [ ] **Step 5:** Tests per intent path with golden-set examples.

---

## WORKSTREAM 5: Confirmed Side Effects (cloud functions)

### Task 15: action/confirm executor

- [ ] **Step 1:** `helpBot/actions.ts` — switch on action type, each requiring the authenticated user to match the conversation owner:
  - `create_support_ticket` / `create_bug_ticket`: ClickUp API (reuse the deprecated `support/service.ts` createTask approach, modernized) with conversation history appended; store ticket ref on the conversation doc; subscribe user to resolution notify.
  - `bump_duplicate`: ClickUp priority bump + **Slack DM to `app_settings.pm_slack_user_id`** via pm-app (pm-app owns the Slack client + settings; expose `POST /api/bot/internal/notify` JWT-protected, or CF calls Slack directly with the bot token — choose pm-app route so the PM setting lives in one place).
  - `file_suggestion`: ClickUp Planning list task with template body.
  - `notify_uiux`: Slack post to configured channel.
- [ ] **Step 2:** UI contract: actions execute ONLY from `/help-bot/action/confirm` carrying `{conversationId, actionId}` — the app renders the confirm button from the chat response; the LLM never triggers execution (spec Security #2).
- [ ] **Step 3:** Record `action_confirmed` observation via pm-app callback. Tests.

### Task 16: Resolution notifications

- [ ] **Step 1:** Extend pm-app's existing ClickUp webhook: on status→closed for a ticket with a `helpConversations` ref, call CF endpoint to create an in-app notification (existing `getTeamNotifications` infra) + optional push (`notificationService.ts`). "Your reported issue was resolved."

---

## WORKSTREAM 6: app.viscap.ai UI

### Task 17: Panel + chat behind feature flag

- [ ] **Step 1:** Feature flag `helpResourcesV2` (existing flag/remote-config mechanism, or env-gated per deploy channel like `SupportChat.isEnabled()`).
- [ ] **Step 2:** `useHelpPanelKey.ts` — fetch scoped key from `/help-bot/panel-key`, auto-refresh before expiry.
- [ ] **Step 3:** `HelpPanel.tsx` — direct Typesense query (D2): filter `surface_slugs` matching current route. Sections: search / **On this page** (max 4) / Continue learning (LearningContext) / Ask anything / locked upsell cards (non-owned hits rendered dimmed+lock, click → upgrade prompt). "Show me how" + "New in Viscap" sections stubbed (Phase 3). **Launch ordering hand-seeded** (D1): a static `pinned` map per slug until struggle data accrues; struggle-weight ranking is wired but floor-gated (≥5 workspaces).
- [ ] **Step 4:** `HelpChat.tsx` — thread UI on `/help-bot/message`; renders citations as lesson links; renders `proposedAction` as an explicit confirm card (button → `/help-bot/action/confirm`); shows handoff confirmation with ticket reference.
- [ ] **Step 5:** Swap in `AdminNav.tsx`: flag on → new panel; flag off → ClickConnector (unchanged). Both never simultaneously.

### Task 18: Struggle-signal ranking service (D1 final spec)

- [ ] **Step 1:** pm-app: nightly job (vercel cron) computing per (slug, lesson): distinct `workspace_id` count from `bot_chat_observations`, 30-day half-life decay, write to a `panel_rankings` table; expose read-only `GET /api/bot/rankings?slug=` (JWT) consumed by CF and cached into the panel-key response or a small CDN-cached endpoint.
- [ ] **Step 2:** Deploy-reset hook: app.viscap.ai deploy pipeline POSTs changed routes (from the route manifest diff) to pm-app `/api/bot/rankings/reset` → zeroes struggle rows for those slugs.
- [ ] **Step 3:** Manual pins: `panel_pins` table editable from pm-app settings UI; pins always sort first.

---

## WORKSTREAM 7: Batch Manual Migration

### Task 19: Migrate remaining ~17 manuals

- [ ] **Step 1:** Schema locked (Task 5 sign-off) — then migrate the remaining `Manual/` articles per the same procedure (workflow lesson + sub-lessons + feature extraction + slugs + roles + free product).
- [ ] **Step 2:** Frontmatter `cms_lesson_id` on every vault file; vault README note: **cms is user-facing authoritative post-migration**; vault Manual/ marked as dev-reference mirror.
- [ ] **Step 3:** Run slug CI; backfill Typesense; spot-check 5 random lessons through a scoped free-tier key.

---

## WORKSTREAM 8: Shadow Test & Cutover

### Task 20: Shadow mode

- [ ] **Step 1:** CF `message` handler shadow branch: when flag `helpBotShadow` on (and `helpResourcesV2` off), fork incoming ClickConnector-bound queries (or a Slack-sampled set if CC can't be tapped) to the bot; persist responses marked `shadow:true`; nothing shown to users.
- [ ] **Step 2:** Run the full golden set through `/api/bot/chat` via a script (`scripts/run-golden-set.ts` in pm-app) — outputs CSV of answers + citations for manual scoring against the rubric.
- [ ] **Step 3:** Score weekly in the spreadsheet. Minimum 1 week; extend to 2 if live traffic exercised <75% of categories (D3).

### Task 21: Cutover gate

- [ ] **Step 1:** Verify criteria: ≥70% correct+cited, <2% confidently-wrong, ripcord verified end-to-end in staging (ticket created with conversation attached).
- [ ] **Step 2:** Enable `helpResourcesV2` for the Viscap internal team first (1 week dogfood), then all workspaces.
- [ ] **Step 3:** Retire ClickConnector: remove widget SDK imports (`pages/_app.tsx`, `AdminNav.tsx`, `SupportChat.ts`), archive its conversation export into `docs/golden-set/` source folder.
- [ ] **Step 4:** Post-cutover: review first 2 weeks of observations; file the Phase 2 (suggestion board) spec kickoff.

---

## Verification Checklist (per the spec's cutover criteria)

- [ ] Golden set ≥70% correct+cited; <2% confidently-wrong
- [ ] Scoped key cannot fetch non-owned lesson (entitlement test)
- [ ] No message text present in any Supabase table (audit query)
- [ ] Ripcord: unanswerable → confirm → ClickUp ticket with full history
- [ ] Panel functions with pm-app intentionally stopped (D2 resilience check)
- [ ] All side effects require a rendered confirm click (attempt API-only execution → rejected)
- [ ] CI slug validation fails on a deliberately bad slug
- [ ] `app_settings` PM Slack ID change takes effect without deploy

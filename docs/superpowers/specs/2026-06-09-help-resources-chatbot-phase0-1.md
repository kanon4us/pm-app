# Access-Aware Help & Resources Chatbot — Phase 0 + Phase 1 Design

**Date:** 2026-06-09
**Status:** Approved for implementation planning
**Author:** Michael Terry (CTO, acting PM) + Claude
**Supersedes:** ClickConnector support widget in app.viscap.ai

---

## Problem Statement

Customer support today runs through ClickConnector — a generic third-party widget with no awareness of which education products a team owns, no access to the up-to-date documentation vault or education lessons, and no structured intake for bugs or feature suggestions. The documentation vault (`ViscapMedia/documentation`) holds 22 current user-manual articles and per-feature overviews, and education products already live in Firestore behind Stripe entitlements — but none of it is served to users at the moment of need.

The vault's own roadmap (`Feature Overview/Help & Resources.md`) specs an "Access-Aware Chatbot": team-aware, product-aware, serving only owned content, with upgrade prompts for gated content and optimized developer handoff. This document is the implementation design for that vision, Phases 0 and 1.

**Role of pm-app:** pm-app acts as a third-party AI-processing service in beta. It supplies the bot brain (classification, retrieval orchestration, SOPs, learning loops) but customer data — conversations, tickets, suggestions — lives in Viscap's Firebase. pm-app stores only derived signals, learnings, and policies, with Firestore document IDs as references.

---

## Settled Decisions (adjudication log)

| # | Decision | Resolution |
|---|---|---|
| D1 | Struggle-signal ranking | Distinct-workspace count, **30-day half-life decay**, **deploy-triggered reset** per affected page, **min-5-workspace floor** before auto-promotion, manual pins override. Launch ordering seeded by hand. |
| D2 | Retrieval data path | **Side panel queries Typesense directly** via session-minted scoped short-TTL keys (entitlement filters baked into key by cloud functions from verified JWT). **Only chat routes through pm-app.** Panel survives pm-app outage. |
| D3 | Shadow period | Minimum 1 week; auto-extend to 2 weeks if <75% of golden-set categories exercised by live traffic in week one. |
| D4 | Docs-freshness override | Gate is blocking by default. PM-signed override ships the release AND converts the block into a docs task with a **5-business-day SLA**. |
| D5 | Lesson hierarchy | **No embeds.** Lessons contain sub-lessons (strict folder structure — a parent is never a sub-lesson of its own descendant). Cross-references are **related-lesson links**, rendered as navigation, never inlined. No loop risk. |
| D6 | Conversation privacy | Conversations stay in **Firestore** (Viscap's database). Supabase stores **derived signals only**: query embeddings, cited lesson IDs, answered y/n, page slug, classification, SOP version used. Never message text. |
| D7 | Region pinning | Verify actual regions of Typesense cluster and Supabase project during Phase 0, then pin Vercel functions accordingly. Do not assume colocation. |

**Explicitly deferred (do not creep back in):** automated eval pipeline (LLM-as-judge CI), digest-mode Slack DMs, embedding re-version tooling. Revisit post-launch with real logs.

---

## Architecture Overview

```
┌─────────────────────────────┐
│  app.viscap.ai (Firebase)   │
│  ┌───────────────────────┐  │   scoped short-TTL key      ┌────────────┐
│  │ Help & Resources panel│──┼────────────────────────────▶│ Typesense  │
│  │ (slug-matched lessons)│  │   (entitlement-filtered)    │ (GCP)      │
│  └───────────────────────┘  │                             └─────▲──────┘
│  ┌───────────────────────┐  │                                   │
│  │ Chat UI               │  │                                   │ retrieval
│  └──────────┬────────────┘  │                                   │
└─────────────┼───────────────┘                                   │
              │ authenticated call                                │
              ▼                                                   │
┌─────────────────────────────┐    server JWT (Secret Mgr)  ┌─────┴──────────────┐
│ viscap-ai-cloud-functions   │────────────────────────────▶│ pm-app /api/bot/*  │
│  • helpBot module (proxy)   │                             │ (Vercel, brain)    │
│  • scoped-key minting       │                             │  • classify        │
│  • entitlement resolution   │                             │  • SOP-driven flow │
│  • conversation persistence │◀────────────────────────────│  • dedup (pgvector)│
│    (Firestore)              │    responses + actions      │  • observations    │
└─────────────────────────────┘                             └────────────────────┘
         │                                                            │
         ▼                                                            ▼
   Firestore: conversations,                                  Supabase: policies,
   tickets refs, suggestions                                  observations (derived
   (customer data stays home)                                 signals + Firestore IDs)
```

**Portability (exit paths, documented not built):** the brain is a stateless Next.js API layer; secrets are config-driven; storage sits behind interfaces. Migration targets: Cloud Run (Mercury / ai-product-researcher pattern, GCP-native) or AWS Lambda/ECS. Because app.viscap.ai only ever talks to cloud functions, relocating the brain is a URL + secret swap.

---

## Phase 0 — Parity & Validation (1–2 weeks)

### 0.1 Golden Question Set
- Mine **50–100 historical queries** from ClickConnector history + closed ClickUp support tickets.
- Each entry: question, expected answer summary, expected citation (lesson/manual), category (question / user-error / bug / feature-suggestion).
- Stored as a spreadsheet (manual scoring). This is a **permanent regression asset** — rerun it whenever embedding models change or content is rechunked.

### 0.2 Schema Pilot
- Migrate **3–5 interconnected manuals** from the vault into education-cms first, stress-testing: workflow/feature lesson types, sub-lesson folder structure, `surface_slugs` arrays, related-lesson links, role tags, product assignment.
- **Lock the schema** before batch-migrating the remaining ~17 manuals.

### 0.3 Cutover Criteria (defined now, measured in shadow)
- ≥70% golden-set accuracy **with correct citation**
- <2% confidently-wrong (hallucinated answer presented without hedging)
- Human ripcord verified end-to-end (bot-can't-answer → ClickUp ticket with conversation attached → user confirmation)
- ClickConnector is NOT retired until all three pass.

### 0.4 Infrastructure Verification
- Verify regions: Typesense cluster, Supabase project. Pin Vercel function region to minimize the chat path's total latency (D7).
- **CI route validation:** check that every `surface_slugs` value maps to a real route in the app.viscap.ai route manifest. Fails the education-cms publish (or a nightly job) on slug rot.

---

## Phase 1 — The Access-Aware Chatbot

### 1a. Brain + Plumbing

**pm-app — new API surface `/api/bot/*`:**
| Endpoint | Purpose |
|---|---|
| `POST /api/bot/chat` | One conversational turn. Receives user/team context + entitlement claims + conversation history (from cloud functions), returns reply + citations + proposed actions. |
| `POST /api/bot/classify` | Standalone intake classification (question / user-error / bug / feature-suggestion). |
| `GET /api/bot/health` | Liveness for the cloud-functions proxy. |

Auth: server JWT from GCP Secret Manager (Mercury pattern). pm-app validates issuer + audience; per-team rate limits and per-conversation token budgets enforced here.

**viscap-ai-cloud-functions — new `helpBot` module:**
- `POST /help-bot/message` — resolves entitlements server-side (purchased products from Firestore/Stripe data), persists the user message to Firestore, calls pm-app, persists the reply, returns it.
- `POST /help-bot/panel-key` — mints scoped, short-TTL Typesense search key with entitlement + role filters baked in (D2). Side panel calls Typesense directly with it.
- `POST /help-bot/action/confirm` — executes side effects ONLY after explicit user confirmation (see Security).

**Firestore (customer side):** `helpConversations/{id}` with `messages` subcollection; references to created tickets/suggestions. Conversations never leave Firebase (D6).

**Supabase (pm-app side) — new tables:**
- `bot_chat_policies` — versioned SOPs for response delivery: classification prompts, escalation rules, citation requirements, tone. Same approval pattern as existing `bot_sops`.
- `bot_chat_observations` — derived signals per turn: query embedding (pgvector), classification, cited lesson IDs (Firestore refs), answered y/n, confidence, page slug, policy version, conversation Firestore ID (reference only).
- `app_settings` — runtime role configuration: `pm_slack_user_id` (settable — CTO is acting PM today), `marketing_slack_user_id` (`UJSASV0L9`, Tyler), `uiux_notification_channel`. Editable in pm-app UI without deploys.

### 1b. Knowledge Indexing & Content Migration

**Lesson schema additions (education-cms / Firestore):**
| Field | Type | Notes |
|---|---|---|
| `type` | `'workflow' \| 'feature'` | Workflows are user-facing top-level; feature lessons give context within workflows |
| `parent_lesson_id` | ref \| null | Folder-structure nesting (D5). Acyclic by construction: parent assignment validated against ancestry. |
| `surface_slugs` | string[] | Route patterns where this workflow is performed (e.g. `/admin/shotlists`, `/admin/creatives/[id]`). CI-validated. |
| `roles` | string[] | Team roles this workflow applies to |
| `product_id` | ref | `help-resources-free` or paid product — drives entitlement filtering |
| `related_lesson_ids` | ref[] | Cross-links, rendered as navigation only (D5) |
| `tour_id` | string \| null | Interactive tour hook (Phase 3) |
| `superseded_by` | ref \| null | Soft-delete/tombstone. Typesense hook drops superseded lessons from serving immediately; Supabase keeps historical IDs for analytics continuity. |

**Typesense:** new `lessons` collection indexed via the existing `functions-typesense` hook pattern: title, body chunks, type, surface_slugs, roles, product_id, embedding. Scoped keys filter on `product_id ∈ (owned ∪ free)` and optionally role.

**Migration plan for the 22 manuals:** pilot 3–5 (Phase 0.2) → lock schema → batch-migrate remainder → each manual becomes a workflow lesson with sub-lessons per major section; feature-specific passages split into feature lessons placed via `related_lesson_ids` and surfaced inside the relevant workflows. Vault `Manual/` files gain frontmatter pointing at their education-cms lesson ID (vault remains the dev-facing source; education-cms is the user-facing serving copy — sync direction: vault → cms during migration, cms-authoritative after).

### 1c. Intake Flows (SOP-driven, per the canonical flow)

All flows are policies in `bot_chat_policies`, editable without deploys:

1. **Question** → retrieve owned+free lessons → answer with citations. Non-owned relevant content → upgrade prompt (never content).
2. **User error** → serve matching tutorial/lesson immediately → notify **UI/UX team** (not CS) with the confusion context — every user-error event is a UX signal. If no adequate lesson exists → record `content_gap` observation.
3. **Bug** → diagnostic interview (SOP-defined questions; LogRocket session link if available) → embed + dedup against existing ClickUp tickets (pgvector, reusing `lib/issue-triage/duplicate-detection.ts` patterns) →
   - **Duplicate:** bump parent ticket priority; **Slack DM the configured PM** (`app_settings.pm_slack_user_id`) via the existing support bot; link reporter for resolution notification.
   - **Original:** draft ClickUp ticket → user confirms → created; reporter subscribed to resolution notify (in-app notification on close).
4. **Feature suggestion** → interview → rewrite into standard template (Problem / Current workaround / Proposed behavior / Affected workflow & role / Frequency) → **user approves rewrite** → Phase 2 board (interim: ClickUp Planning list) → dedup against existing suggestions → duplicate links user as follower of the original.
5. **Human ripcord (ships day one):** when the bot cannot answer or the user asks for a human → draft ClickUp support ticket with full conversation history attached (pulled from Firestore by cloud functions) → user confirms → ticket created → confirmation with ticket reference shown to user.

### 1d. Side Panel Redesign

Layout (top→bottom): 🔍 search → **"On this page"** (slug-matched, struggle-weighted, max 4) → **"▶ Show me how"** (tour hook, Phase 3) → **"Continue learning"** (in-progress modules) → **"New in Viscap"** (changelog-fed, Phase 3) → 💬 **"Ask anything"** (chat) → locked upsell cards (dimmed, lock icon).

**Ranking signal (final spec, D1):**
```
struggle_weight(lesson, page) =
  distinct_workspaces(observations where slug=page, cited_or_target=lesson)
  decayed with 30-day half-life
  reset to 0 when a deploy touches `page` (deploy webhook → affected slugs)
  eligible for auto-promotion only when distinct workspaces ≥ 5
  manual pins always override; launch ordering seeded by hand
```
Rank = slug match → entitlement → role match → struggle weight → progress → freshness.

---

## Security & Cost Controls

1. **Entitlements are server-side only.** Filters constructed exclusively from verified JWT claims in cloud functions; the LLM never sees or sets filter parameters.
2. **Side effects require explicit confirmation.** The LLM drafts payloads (ticket, DM, suggestion post); an app-rendered confirm button executes them via `/help-bot/action/confirm`. No LLM-initiated writes, ever.
3. **Prompt-injection posture:** retrieved lesson content is data, not instructions; system prompt instructs accordingly; citations restricted to retrieval results.
4. **Cost ceilings:** per-conversation token budget; per-workspace monthly rate limit; both enforced in pm-app's API layer with observable counters.
5. **Privacy boundary (D6):** message text never crosses into Supabase. Derived signals only.

---

## Shadow Test & Cutover

1. Deploy brain + panel behind a feature flag; ClickConnector remains live.
2. Shadow mode: real queries forked to the bot, responses logged (Firestore + observations), hidden from users.
3. Score weekly against the golden set (manual spreadsheet).
4. Cutover when 0.3 criteria pass (min 1 week, max 2 — D3). Retire ClickConnector; keep its export archived as golden-set source.

---

## Out of Scope (this spec)

- **Phase 2:** public suggestion board in app.viscap.ai (Firestore posts/votes/follows; pm-app reads + FVI), top-10 board, public status enum mapping, follower-threshold → FVI draft.
- **Phase 3:** docs-freshness gate (blocking, with 5-day-SLA override — D4), interactive tours from prototype-builder scenarios (`data-tour-id` attributes, Playwright assertions, soft-fail player), lessons→Webflow posts pipeline (`features.viscap.ai` creation, Tyler/`UJSASV0L9` notification, bot cites lessons only), follower shipped-notifications.

Each gets its own spec once Phase 1 reaches shadow testing.

---

## Implementation Order

1. Phase 0.4 region verification + 0.1 golden set (parallel, week 1)
2. Phase 0.2 schema pilot in education-cms (week 1–2)
3. 1a plumbing: Secret Manager JWT, helpBot module skeleton, pm-app `/api/bot/health` + `/chat` stub
4. 1b Typesense lessons collection + scoped-key minting + CI slug validation
5. 1c SOP policies + intake flows + ripcord (ripcord before any other flow ships)
6. 1d panel UI + ranking signal (seeded ordering)
7. Shadow test → cutover gate → ClickConnector retirement

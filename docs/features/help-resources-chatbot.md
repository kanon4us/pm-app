# Feature: Help & Resources Chatbot (Phase 0–1)

**Branch:** `feature/help-resources-chatbot`
**Central spec:** `pm-app/docs/superpowers/specs/2026-06-09-help-resources-chatbot-phase0-1.md`
**Central plan:** `pm-app/docs/superpowers/plans/2026-06-09-help-resources-chatbot-phase0-1.md`

## What changes in THIS repo (pm-app)

pm-app supplies the **bot brain** as a stateless API: classification, retrieval orchestration, SOP-driven intake flows, and the learning layer (policies + derived-signal observations). Customer conversations stay in Viscap's Firestore — pm-app stores **no message text** (spec decision D6).

### Scope (from the plan)
- **WS 0A:** `docs/golden-set/` — golden question CSV + scoring rubric
- **WS 1:** Migration `018_bot_chat.sql` — `bot_chat_policies`, `bot_chat_observations`, `app_settings`; policy/observation libs; `/settings` page
- **WS 2:** `lib/bot/auth.ts` (HS256 JWT trust with cloud functions), `/api/bot/health`
- **WS 4:** `lib/bot/{classify,chat,dedup}.ts`, `/api/bot/{classify,chat}` — the brain
- **WS 6 (partial):** struggle-ranking cron + `panel_rankings`/`panel_pins`
- **WS 8:** `scripts/run-golden-set.ts`

### QA checklist for this repo
1. `npx tsc --noEmit` clean; `npx jest` — new suites pass (4 pre-existing failures on main are known: slack-stale-check, developers/experiment, clickup webhook, slack webhook)
2. Migration 018 applies cleanly on a fresh Supabase branch DB
3. **Privacy audit:** no column or insert in any new table carries message text — `grep -rn "message_text\|messageText" supabase/migrations/018* lib/bot/` returns nothing
4. `/api/bot/health` returns 401 without valid JWT, 200 with one
5. `/settings` page: changing `pm_slack_user_id` persists without redeploy
6. Side effects: `/api/bot/chat` returns `proposedAction` drafts only — nothing in pm-app executes ClickUp/Slack writes from an LLM turn

### Deploy notes
- New Vercel env: `BOT_JWT_SECRET` (same value as GCP Secret Manager `pmapp-bot-jwt-secret`)
- `vercel.json` region pin added per WS 0B verification
- Deploy AFTER cloud functions helpBot module is on staging (it calls `/api/bot/health` to verify the trust handshake)

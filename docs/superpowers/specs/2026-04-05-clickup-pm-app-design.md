# Viscap PM App — Design Spec

**Date:** 2026-04-05
**Status:** Approved — ready for implementation planning
**Repo:** `pm-app`

---

## 1. Purpose

A standalone internal web application that connects to ClickUp via OAuth, imports tasks from up to 10 selected lists, and subscribes to status-change webhooks. When a task status changes, the app queues a trigger that a developer reviews and approves. On approval, the app calls the Claude API to run the PM Agent and fans the output out to four write-back targets: ClickUp, the documentation repo, Webflow CMS, and Figma.

**Users:** Internal Viscap team only (Michael + developers, 2–5 people).

---

## 2. Architecture

### Deployment Model

The app runs in two modes:

| Mode | Where | Handles |
|------|--------|---------|
| **Hosted** | Vercel | ClickUp OAuth, task import, webhook receipt, trigger queue dashboard, trigger approval |
| **Local** | Developer machine | PM Agent processing runs, Code → Canvas Figma pushes, any workflow requiring `localhost` access |

This hybrid model is intentional. Webhook subscriptions and the queue must always be reachable (Vercel), but the processing-heavy PM Agent work runs locally where the developer has full context.

### System Layers

```
CLICKUP
  OAuth 2.0 → user signs in with their ClickUp account
  REST API  → import tasks from up to 10 selected lists
  Webhooks  → ClickUp POSTs status-change events to /api/webhooks/clickup

        ▼

NEXT.JS APP (Vercel)
  API Routes:
    POST /api/webhooks/clickup    receives status-change events
    POST /api/triggers/approve    developer approves a queued trigger
    POST /api/triggers/dismiss    developer dismisses a trigger
    GET  /api/lists               fetch available ClickUp lists
  Pages:
    /                  Trigger Queue dashboard (main view)
    /sprint            Sprint Planner
    /setup             OAuth connections + list selection
    /triggers/config   Status → PM Agent action mapping

        ▼

SUPABASE (Postgres + Realtime)
  10-table schema (see Section 4)
  Realtime channel → dashboard sees new triggers without polling

        ▼  on developer approval

CLAUDE API (claude-opus-4-6)
  System prompt: PM Agent SKILL.md + task context + workflow phase
  Figma MCP tools available during run
  Returns structured output: { clickup, docs, webflow, figma } payloads

        ▼  fans out to four targets

WRITE-BACK TARGETS
  ① ClickUp         comment (always) + description + custom fields
  ② Docs Repo       feature/[slug] branch — spec, CLAUDE.md, user stories (unmerged until ROI validated)
  ③ Webflow CMS     draft post or Coming Soon stub (published: false until shipped)
  ④ Figma           bidirectional via MCP (see Section 5)
```

### Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | Next.js 15 + TypeScript | Standard for Viscap projects |
| UI | Ant Design 5 | Matches app.viscap.ai, no new library to learn |
| Hosting | Vercel | Zero-config Next.js, serverless functions handle webhooks |
| Database | Supabase (Postgres) | Realtime subscriptions for live trigger queue |
| Auth (app) | NextAuth.js | ClickUp OAuth provider |
| OAuth tokens | Supabase `oauth_tokens` table (encrypted) | ClickUp, Figma, Webflow, GitHub |
| AI | Claude API — `claude-opus-4-6` | Per Viscap AI Tools policy |
| Figma sync | Figma MCP | Bidirectional design sync |

---

## 3. Screens

### Screen 1: Trigger Queue `/`
The primary view. Displays all queued triggers in real time via Supabase Realtime.

Each trigger card shows:
- Task name + ClickUp status transition that fired it
- PM Agent action that will run
- FVI score + risk level
- Write-back targets that will fire
- **Approve** / **Dismiss** / **Preview prompt** actions

Status tabs: Pending · Running · Done · Failed

### Screen 2: Sprint Planner `/sprint`
FVI-ranked task list for the active sprint.

- Cost budget bar (current cost / budget, e.g. 38.4 / 50)
- Per-task: name, FVI score, cost units
- Over-budget tasks flagged in orange
- PM Agent suggestion: which tasks to move to next sprint and remaining capacity after move
- Rebalance is a trigger — developer approves in the queue like any other action

### Screen 3: Setup `/setup`
One-time configuration. Revisit anytime.

- OAuth connection status per provider: ClickUp, GitHub, Figma, Webflow (connect / reconnect)
- List selector: search and select up to 10 ClickUp lists; shows current webhook subscription status per list

### Screen 4: Trigger Config `/triggers/config`
Maps ClickUp status transitions to PM Agent actions.

Columns: When status → | PM Agent action | Write-backs | on_failure | Edit

Default trigger rules (from PM Agent SOP):

| Status transition | PM Agent action | Write-backs |
|-------------------|----------------|-------------|
| → In Progress | Start feature kickoff | ClickUp · Docs · Webflow · Figma |
| → In Review / Deployed | Deploy cleanup | ClickUp · Docs · Webflow |
| → Archived (from active) | Kill feature | ClickUp · Docs |
| Custom: Flag Lifted | Upgrade Coming Soon stub | Webflow |
| Milestone: Sprint Close | Generate release notes | ClickUp · Webflow |

---

## 4. Data Model

### 11-Table Schema

#### `users`
Identity only. Tokens live in `oauth_tokens`.

| Column | Type |
|--------|------|
| id | uuid pk |
| email | text unique |
| clickup_workspace_id | text |
| created_at | timestamptz |

#### `oauth_tokens`
One row per user per provider. Handles token refresh automatically.

| Column | Type |
|--------|------|
| id | uuid pk |
| user_id | fk → users |
| provider | enum: clickup\|figma\|webflow\|github |
| access_token | text (encrypted) |
| refresh_token | text (encrypted) |
| token_expires_at | timestamptz |
| scopes | text[] |

#### `lists`
Up to 10 subscribed ClickUp lists per user.

| Column | Type |
|--------|------|
| id | uuid pk |
| user_id | fk → users |
| clickup_list_id | text |
| name | text |
| webhook_id | text |
| synced_at | timestamptz |

#### `tasks`
Imported task snapshot + FVI calculation fields.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid pk | |
| clickup_task_id | text unique | |
| list_id | fk → lists | |
| sprint_id | fk → sprints | nullable |
| name | text | |
| status | text | |
| custom_fields | jsonb | |
| fvi_score | float | Computed from objective_assessments |
| cost_effort | float | Dev days |
| cost_risk | float | 1.0x–3.0x multiplier |
| inverted_influence | float | Derived from skills_library role scores |
| git_branch | text | e.g. feature/recycling-engine-v2 |
| is_feature_flagged | boolean default false | Triggers Coming Soon stub in Webflow |
| synced_at | timestamptz | |

#### `sprints`

| Column | Type |
|--------|------|
| id | uuid pk |
| clickup_sprint_id | text |
| name | text |
| start_date | date |
| end_date | date |
| cost_budget | float |
| is_active | boolean |
| status | enum: planned\|active\|completed |

#### `trigger_configs`
Maps status transitions to PM Agent actions. Controls write-back targets and failure behavior.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid pk | |
| list_id | fk → lists | |
| from_status | text | null = any |
| to_status | text | |
| pm_agent_action | text | |
| write_back_order | text[] | e.g. ["clickup","docs","webflow","figma"] |
| write_back_config | jsonb | figma_file_key, webflow_collection_id, etc. |
| on_failure | enum: continue\|stop | Default: continue |

#### `trigger_queue`
Live queue. Supabase Realtime subscription drives the dashboard.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid pk | |
| task_id | fk → tasks | |
| config_id | fk → trigger_configs | |
| status | enum: pending\|approved\|dismissed\|running\|done\|failed | |
| approved_by | fk → users | Co-pilot audit trail |
| agent_output | jsonb | Full PM Agent response |
| error_details | jsonb | Cross-Repo Scan failures, API errors |
| created_at | timestamptz | |

#### `objective_assessments`
FVI numerator: 7 objective owner scores per task.

| Column | Type |
|--------|------|
| id | uuid pk |
| task_id | fk → tasks |
| objective_id | int (1–7) |
| score | int (-5 to +5) |
| reasoning | text |
| assessed_at | timestamptz |

#### `skills_library`
Maps role influence scores to SKILL.md files for User Story drafting.

| Column | Type |
|--------|------|
| id | uuid pk |
| role_slug | text (e.g. creative-strategist) |
| skill_path | text (vault path) |
| content_snapshot | text (cached SKILL.md content) |
| updated_at | timestamptz |

Seeded from `documentation/AI Tools/Skills/user-perspective/`.

#### `repo_registry`
Dynamic version of vault's `Repo-Registry.md` for Cross-Repo Scan (Step 3).

| Column | Type |
|--------|------|
| id | uuid pk |
| repo_name | text |
| domain | text[] (auth, billing, media, etc.) |
| readme_url | text |
| is_active | boolean default true |

#### `sync_logs`
Tracks last sync per integration — ensures MindStudio Support Agent reads fresh docs.

| Column | Type |
|--------|------|
| id | uuid pk |
| integration | enum: webflow\|figma\|github\|clickup |
| entity_id | text |
| status | enum: success\|failed |
| details | jsonb |
| synced_at | timestamptz |

### Write-Back Priority and Failure Handling

`trigger_configs.write_back_order` defines execution sequence. Default: `["clickup", "docs", "webflow", "figma"]` — ClickUp (system of record) always writes first.

`trigger_configs.on_failure`:
- `continue` (default) — log error to `trigger_queue.error_details`, proceed to remaining targets
- `stop` — halt run, surface in dashboard for developer review

This ensures ClickUp comment and docs branch always land even if Figma API rate-limits.

---

## 5. Figma Integration

### Phase 1 (ships with v1)
- Figma OAuth stored in `oauth_tokens`
- Figma MCP configured in PM Agent system prompt
- Create Figma page per feature at trigger time
- **Canvas → Code**: designer shares Figma component link → PM Agent pulls spec → modifies application code

### Phase 2 (local-only, post-v1)
- **Code → Canvas**: developer runs app locally → PM Agent previews `localhost` → pushes real Figma frames with auto layout (not screenshots)
- Visual discrepancy highlighting during UI/UX Review phase
- QA Approved: push Master Design back to Figma to lock visual documentation

### Figma × Workflow Phase Map

| Workflow Phase | Figma Action | Direction |
|---------------|-------------|-----------|
| UI/UX Design | Create page + initial frame structure for feature | Code → Canvas (Phase 2) |
| UI/UX Review | Send current build to review file, highlight discrepancies | Code → Canvas (Phase 2) |
| Architecting | Designer updates component → PM Agent pulls spec → updates code | Canvas → Code (Phase 1) |
| QA Approved | Push Master Design to Figma — visual docs match what shipped | Code → Canvas (Phase 2) |

**Phase 2 constraint:** Code → Canvas requires a running `localhost` dev server. This cannot run automatically from Vercel. Developers trigger it explicitly from their local machine.

---

## 6. PM Agent Integration

### How It Runs

On trigger approval, the Next.js API route:

1. Fetches task context from Supabase (task, sprint, objective scores, relevant SKILL.md from `skills_library`)
2. Resolves OAuth tokens for all write-back targets (auto-refreshing if expired)
3. Calls Claude API (`claude-opus-4-6`) with:
   - System prompt: PM Agent SKILL.md + user-perspective SKILL for highest-influence roles on this task
   - User message: task name, status transition, ClickUp custom fields, FVI context, git branch (if exists)
   - Figma MCP tools available
4. Parses structured response and executes write-backs in `write_back_order`
5. Updates `trigger_queue` status to `done` or `failed` with full `agent_output` and any `error_details`

### FVI Scoring Logic

When `pm_agent_action = "Start feature kickoff"`:
- PM Agent assesses all 7 objectives and writes scores to `objective_assessments`
- Computes `fvi_score = (sum of objective scores + 64) / (cost_effort × cost_risk × inverted_influence)`
- Updates `tasks.fvi_score`, `tasks.cost_effort`, `tasks.cost_risk`, `tasks.inverted_influence`
- Sprint Planner re-renders with updated cost budget

### Co-Pilot Model

The PM Agent is a **co-pilot**, not an autonomous gatekeeper:
- System proposes: trigger fires → PM Agent drafts FVI score, engineering plan, user stories
- Human confirms: developer reviews in queue, approves, dismisses, or edits before firing
- `trigger_queue.approved_by` logs every approval for audit trail

---

## 7. Scope Boundaries

### In Scope (v1)
- ClickUp OAuth + webhook subscription for up to 10 lists
- Trigger queue dashboard with Supabase Realtime
- PM Agent runs via Claude API on approval
- Four write-back targets: ClickUp, docs repo branch, Webflow draft, Figma page
- Canvas → Code Figma sync (Phase 1)
- Sprint planner with FVI cost budget
- Trigger config UI
- Setup / OAuth connection management

### Out of Scope (v1)
- Code → Canvas Figma sync (Phase 2 — requires localhost)
- Visual discrepancy highlighting
- QA Approved Master Design push
- Zapier / Make automation (replaced entirely by this app)
- Multi-workspace ClickUp support
- Public-facing UI (internal tool only)

---

## 8. Open Questions

None. All design decisions resolved during brainstorming session 2026-04-05.

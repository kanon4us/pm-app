# PM Agent Assessment — Full Redesign Plan

**Date:** 2026-04-06
**Status:** Draft — awaiting approval before implementation
**Spec:** `docs/superpowers/specs/2026-04-05-clickup-pm-app-design.md`
**Vault reference:** `documentation/00-Meta/FVI-Rubric.md` + `documentation/Inbox/Software Engineering Objectives.md`

---

## What This Replaces

The current `/api/sprint/tasks/[id]/assess/route.ts` is a static form — same 7 sliders for every task, no vault awareness, no conversation history, wrong FVI formula, placeholder objective names. This plan replaces it entirely.

---

## What We Are Building

A **PM Agent interview system** where Claude acts as the Product Manager and decides whether a task should be prioritized above everything else in the backlog. It does this by:

1. **Gathering context first** (read vault, read other tasks, check previous assessments) — before asking anything
2. **Pre-scoring all 7 objectives** based on evidence from the vault + ClickUp description
3. **Showing proposed scores to the user** — they review first; questions are only asked when confidence is low or the user disagrees
4. **Conducting a one-question-at-a-time interview** — each question names the objective it serves, shows Claude's reasoning, and references the vault evidence that prompted it
5. **Writing the approved spec to the vault** when assessment is complete
6. **Displaying Figma designs** as a visual anchor during the interview so the user describes the feature accurately

---

## Part 1 — GitHub OAuth App Setup (User Action Required)

This must be done before any code is written.

### Step 1: Create the OAuth App on GitHub

1. Go to **github.com → Settings → Developer settings → OAuth Apps → New OAuth App**
2. Fill in:
   - **Application name:** `Viscap PM App`
   - **Homepage URL:** `http://localhost:3000` (update to production URL when deploying)
   - **Authorization callback URL:** `http://localhost:3000/api/github/callback`
3. Click **Register application**
4. On the next screen, click **Generate a new client secret**
5. Copy the **Client ID** and **Client Secret**

### Step 2: Add to `.env.local`

```
GITHUB_CLIENT_ID=your_client_id_here
GITHUB_CLIENT_SECRET=your_client_secret_here
GITHUB_VAULT_REPO=ViscapMedia/documentation
```

> **Scope needed:** `repo` — required for read AND write access to the private vault repo.
> The `GITHUB_VAULT_REPO` env var means changing vaults never requires a code change.

### Step 3: Add callback URL for production

When deployed to Vercel, add a second callback URL in the GitHub OAuth App settings:
`https://your-vercel-domain.vercel.app/api/github/callback`

---

## Part 2 — Corrected FVI Formula

### The Formula

```
FVI = (ObjTotal + 64) / (InvertedInfluence × Effort × Risk)
```

### Inverted Influence

```
InvertedInfluence = 1 − ((3 × I_DM_norm + I_NDM_norm) / 4)
```

### Normalizing I-DM and I-NDM

Each role contributes: `role_weight × usage_frequency_score`

Usage frequency scores: Access by Default=1, Access Sometimes=2, Uses Sometimes=3, Uses Every Day=4

**I-DM raw** = sum of (weight × freq) for all affected DM roles
**I-NDM raw** = sum of (weight × freq) for all affected NDM roles

**Normalization divisors** (theoretical maximums — all roles at max weight, max frequency 4):

| Group | Roles (weights) | Max raw score |
|-------|----------------|---------------|
| I-DM | Agency: 10+10+8+9+7+5+6 = 55; Brand: 10+10+9+5+6 = 40; Total: 95 | 95 × 4 = **380** |
| I-NDM | Agency: 5+4+3+1+7+4+2+1+1+1 = 29; Brand: 5+4+3+7+4+2+1+1 = 27; Total: 56 | 56 × 4 = **224** |

```
I_DM_norm  = I_DM_raw  / 380   (range: 0.0 – 1.0)
I_NDM_norm = I_NDM_raw / 224   (range: 0.0 – 1.0)
```

**InvertedInfluence range:** 0.0 (all roles at max weight/frequency) to 1.0 (no roles affected)
**Guard:** clamp InvertedInfluence to minimum 0.01 to prevent division-by-zero.

### Risk Multiplier (R) — from vault

| Level | R | When |
|-------|---|------|
| Routine | 1.0× | Text copy, tooltips, CSS |
| Standard | 1.2× | New form field, new endpoint, filter |
| Moderate | 1.5× | DB column, stable API integration |
| High | 2.0× | Login, Billing, Permissions, Creative Formula |
| Critical | 3.0× | New AI model, payment provider switch, core refactor |

### Effort (E)

`E = Developer Days × Number of Devs` (e.g., 1 dev for 5 days = 5; 2 devs for 3 days = 6)

---

## Part 3 — Database Migrations

Add to `supabase/migrations/002_assessment_redesign.sql`:

```sql
-- Objectives registry — editable without code changes
CREATE TABLE objectives_registry (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  objective_id   INT  NOT NULL UNIQUE CHECK (objective_id BETWEEN 1 AND 7),
  name           TEXT NOT NULL,
  owner_name     TEXT NOT NULL,
  mandate        TEXT NOT NULL,
  score_matrix   JSONB NOT NULL DEFAULT '{}',
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Role registry — mirrors FVI-Rubric.md, editable without code changes
CREATE TABLE role_registry (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_name       TEXT NOT NULL,
  team_domain     TEXT NOT NULL CHECK (team_domain IN ('agency', 'brand')),
  influence_type  TEXT NOT NULL CHECK (influence_type IN ('DM', 'NDM')),
  weight          INT  NOT NULL CHECK (weight BETWEEN 1 AND 10),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

-- Assessment conversations — persisted, re-assessment aware
CREATE TABLE assessment_conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'in_progress'
                  CHECK (status IN ('in_progress', 'complete', 'abandoned')),
  vault_context   JSONB,   -- docs Claude found + overlapping tasks discovered
  proposed_scores JSONB,   -- Claude's pre-scored 7 objectives before any questions
  final_scores    JSONB,   -- confirmed scores after interview
  effort          FLOAT,
  risk            FLOAT,
  fvi_score       FLOAT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  UNIQUE (task_id, created_at)  -- multiple assessments per task allowed
);

-- Assessment messages — the actual interview turns
CREATE TABLE assessment_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID NOT NULL REFERENCES assessment_conversations(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('assistant', 'user')),
  content           TEXT NOT NULL,    -- question text (assistant) or answer (user)
  objective_id      INT,              -- which objective this turn is about (nullable)
  proposed_score    INT,              -- Claude's proposed score for this objective
  vault_evidence    TEXT,             -- which vault doc prompted this question
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Role assessments per conversation — which roles are affected + frequency
CREATE TABLE conversation_role_assessments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID NOT NULL REFERENCES assessment_conversations(id) ON DELETE CASCADE,
  role_id           UUID NOT NULL REFERENCES role_registry(id),
  usage_frequency   INT NOT NULL CHECK (usage_frequency BETWEEN 1 AND 4),
  -- 1=Access by Default, 2=Access Sometimes, 3=Uses Sometimes, 4=Uses Every Day
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed objectives_registry from vault definitions
INSERT INTO objectives_registry (objective_id, name, owner_name, mandate, score_matrix) VALUES
(1, 'Data-Backed Decisions', 'Architect of Truth',
 'Every user action must leave a structured data trail usable for decisions.',
 '{"5":"Source of Truth — fundamentally improves data foundation","3":"Strong Signal — adds valuable structured data","1":"Data Hygiene — prevents future data loss","0":"Neutral — no data impact","-1":"Data Friction — introduces minor ambiguity","-3":"Data Debt — breaks attribution or creates inconsistencies","-5":"Truth Breaker — undermines system credibility"}'::jsonb),

(2, 'Modular Content Creation', 'The Invisible Hand',
 'The system handles complexity invisibly; users create naturally.',
 '{"5":"Full Automation — eliminates entire user-facing steps while increasing capability","3":"Workflow Acceleration — user does less, system does more","1":"Friction Reduction — removes minor constraints","0":"Neutral — no workflow impact","-1":"Additional Steps — exposes minor modular concepts","-3":"Workflow Rigidity — makes system more opinionated","-5":"Modular Disaster — users must learn internal structure"}'::jsonb),

(3, 'User Success', 'The User''s Advocate',
 'Move users from confused to successful in the shortest path possible.',
 '{"5":"Workflow Revolution — transforms how users work","3":"Significant Enhancement — noticeably better experience","1":"Incremental Improvement — small step forward","0":"Neutral — no user success impact","-1":"Minor Friction — slight step backward","-3":"Workflow Regression — meaningfully harder to succeed","-5":"Critical Damage — severely undermines user success"}'::jsonb),

(4, 'Optimized Onboarding', 'The First Impressionist',
 'Every user type finds value within their first 5 minutes.',
 '{"5":"It Just Works — dramatically improves first creative quality and speed","3":"Clarity & Momentum — removes key confusion point","1":"Improvement / Polish — prevents future friction","0":"Neutral — does not affect onboarding","-1":"Minor Friction — adds small effort to first session","-3":"Activation Drag — actively slows reaching first value","- 5":"Trust Broken — undermines confidence, users may drop off"}'::jsonb),

(5, 'Third-Party Integrations', 'The Ecosystem Builder',
 'Buy proven tools; build only what differentiates Viscap.',
 '{"5":"Leverage Breakthrough — multiplies product power, native and frictionless","3":"Strategic Extension — meaningfully expands capabilities","1":"Tactical Connector — useful but narrow","0":"Neutral — no ecosystem impact","-1":"Integration Drag — adds friction or overhead","-3":"Leverage Debt — costs more than it saves","-5":"Integration Rot — actively harms platform"}'::jsonb),

(6, 'Quality Control', 'The Standard Bearer',
 'Nothing ships that can break the business silently.',
 '{"5":"Reliability Foundation — raises quality bar for everything","3":"Quality Multiplier — noticeably safer to build and ship","1":"Preventive Guardrail — keeps us out of trouble","0":"Quality Neutral — no impact on stability","-1":"Risk Introduction — manageable but real risk","-3":"Stability Debt — makes future work harder and riskier","-5":"Stability Violation — should not ship"}'::jsonb),

(7, 'Planning & ROI', 'Chad Terry + Artem Pavlushko',
 'Every feature is strategic, scoped, and resourced before work begins.',
 '{"5":"Proven Profit — evidence-backed ROI and perfect clarity","3":"Strategic Bet — confident speculation aligned with long-term vision","1":"Roadmap Integrity — keeps team aligned, maintains momentum","0":"Neutral — negligible resources, no strategy impact","-1":"Opportunity Cost — better spent elsewhere","-3":"Ambiguity Trap — vague specs, undefined why","-5":"Dead End — creates tech debt, burns cash with no path to profit"}'::jsonb);

-- Seed role_registry from FVI-Rubric.md
INSERT INTO role_registry (role_name, team_domain, influence_type, weight) VALUES
('Admin', 'agency', 'DM', 10),
('Creative Strategist', 'agency', 'DM', 10),
('Account Manager', 'agency', 'DM', 8),
('Director', 'agency', 'DM', 9),
('Content Director', 'agency', 'DM', 7),
('Casting Director', 'agency', 'DM', 5),
('Editing Director', 'agency', 'DM', 6),
('Editing Coordinator', 'agency', 'NDM', 5),
('DIT', 'agency', 'NDM', 4),
('Client Admin', 'agency', 'NDM', 3),
('Client Team', 'agency', 'NDM', 1),
('Copywriter', 'agency', 'NDM', 7),
('Editor', 'agency', 'NDM', 4),
('Videographer', 'agency', 'NDM', 2),
('Remote Talent', 'agency', 'NDM', 1),
('In House Talent', 'agency', 'NDM', 1),
('Sales', 'agency', 'NDM', 1),
('Brand Owner', 'brand', 'DM', 10),
('Internal Team CS', 'brand', 'DM', 10),
('Director', 'brand', 'DM', 9),
('Casting Director', 'brand', 'DM', 5),
('Editing Director', 'brand', 'DM', 6),
('Editing Coordinator', 'brand', 'NDM', 5),
('DIT', 'brand', 'NDM', 4),
('Collaborating Admin', 'brand', 'NDM', 3),
('Copywriter', 'brand', 'NDM', 7),
('Editor', 'brand', 'NDM', 4),
('Videographer', 'brand', 'NDM', 2),
('Remote Talent', 'brand', 'NDM', 1),
('In House Talent', 'brand', 'NDM', 1);
```

---

## Part 4 — New Files & Libraries

### 4.1 `lib/github/vault.ts`

GitHub API wrapper for reading and writing the documentation vault.

**Methods:**
- `getVaultToken(userId)` → reads `oauth_tokens` for `provider = 'github'`
- `searchVault(token, keywords)` → GitHub Search API across `ViscapMedia/documentation`, returns top 5 matching files with snippets
- `readVaultFile(token, path)` → reads a file from the vault repo by path
- `writeVaultFile(token, path, content, message)` → commits a file to the vault (creates or updates)
- `searchFeatureSpecs(token, keywords)` → targets `FeaturePlanning/_Active/` + `FeaturePlanning/_Archive/` specifically
- `listActiveSpecs(token)` → all files in `_Active/`

**Key behaviour:** All reads go through the GitHub Contents API (`GET /repos/{owner}/{repo}/contents/{path}`). All writes use the Git Data API (get SHA → create blob → create tree → create commit → update ref). Branch target: `main` by default; vault branches use `docs/feature/{slug}` naming per SOP 05.

### 4.2 `lib/fvi.ts`

Pure calculation functions, no side effects, unit-testable.

**Exports:**
- `normalizeInfluence(roles: RoleAssessment[]): { iDmNorm: number; iNdmNorm: number }` — applies the max-score divisors (380 for DM, 224 for NDM)
- `computeInvertedInfluence(iDmNorm, iNdmNorm): number` — `1 - ((3 × iDmNorm + iNdmNorm) / 4)`, clamped to [0.01, 1.0]
- `computeFVI(objTotal, invertedInfluence, effort, risk): number` — the full formula
- `fviDecision(fvi: number): 'build-sprint' | 'build-next' | 'backlog' | 'kill' | 'kill-immediately'`
- `trojanHorseCheck(scores: ObjectiveScore[]): boolean` — Data ≥ +5 AND (Modular ≤ -4 OR UserSuccess ≤ -4)
- `MAX_DM_SCORE = 380`, `MAX_NDM_SCORE = 224` — exported constants

### 4.3 `lib/github/connect.ts`

OAuth helpers shared between the connect and callback routes (state generation, code exchange).

---

## Part 5 — New & Modified API Routes

### 5.1 `GET /api/github/connect` (new)

Identical pattern to `/api/clickup/connect`. Generates a random `state` param, stores it in a short-lived cookie, redirects to:

```
https://github.com/login/oauth/authorize
  ?client_id={GITHUB_CLIENT_ID}
  &redirect_uri={NEXT_PUBLIC_URL}/api/github/callback
  &scope=repo
  &state={random_state}
```

### 5.2 `GET /api/github/callback` (new)

1. Verify `state` cookie matches
2. Exchange `code` for access token via `POST https://github.com/login/oauth/access_token`
3. Upsert into `oauth_tokens` (provider = 'github')
4. Redirect to `/setup`

### 5.3 `POST /api/sprint/tasks/[id]/assess/init` (replaces current assess route)

**The context-gather phase.** Called once when the user opens the assessment modal.

**Steps:**
1. Auth check
2. Fetch task from DB + fresh description/custom fields from ClickUp
3. Load all other tasks from DB (name, fvi_score, sprint_id, status) — for overlap detection
4. Load all previous `assessment_conversations` for this task (for re-assessment awareness)
5. Load objectives_registry and role_registry from DB
6. Fetch GitHub token → search vault:
   - Keywords from task name → `searchFeatureSpecs()`
   - Also search `Manual/` for relevant role/workflow mentions
   - Read any matched files (max 3 files, max 2000 tokens each)
7. Load Figma token → if task has a Figma link in custom fields or vault spec, fetch frame thumbnail URL
8. Call Claude (`claude-opus-4-6`, adaptive thinking) with ALL gathered context:
   - Task name + description + custom fields
   - Vault content found (with file paths cited)
   - Other tasks in system (overlapping work? similar names? same sprint?)
   - Previous assessment scores (if re-assessment: acknowledge them, note what's changed)
   - Full objectives_registry (score matrices per objective)
   - Full role_registry
   - System prompt: PM Agent role, suggestion-first mandate, question format spec
9. Claude returns structured JSON:
   ```json
   {
     "proposedScores": [
       { "objectiveId": 1, "score": 3, "confidence": "high", "evidence": "Vault spec at FeaturePlanning/_Active/... describes data capture requirement" },
       { "objectiveId": 2, "score": 0, "confidence": "low", "evidence": "Description does not mention workflow impact — need to ask" },
       ...
     ],
     "overlappingTasks": [
       { "taskId": "...", "taskName": "...", "relationship": "duplicate|related|prerequisite", "note": "..." }
     ],
     "firstQuestion": {
       "objectiveId": 2,
       "objectiveName": "Modular Content Creation",
       "objectiveOwner": "The Invisible Hand",
       "question": "Does this feature add any steps to the user's existing workflow, or does it run entirely in the background?",
       "reasoning": "I couldn't find an existing spec or manual entry for this feature. The description mentions a new UI panel, which could mean added steps (bad for Modular) or just a new access point (neutral). I need to know before scoring.",
       "currentProposedScore": 0
     },
     "costOfNotBuilding": "...",
     "workflowGapAssessment": "...",
     "isReassessment": false,
     "previousScoreSummary": null
   }
   ```
10. Save conversation to `assessment_conversations` with `vault_context` and `proposed_scores`
11. Save first assistant message to `assessment_messages`
12. Return everything to the client

**If no GitHub token:** skip vault search, Claude works from task description + other tasks only. Flag in response: `"vaultConnected": false`.

**If no low-confidence objectives** (all high confidence): return no question — assessment can be confirmed immediately from proposed scores alone.

### 5.4 `POST /api/sprint/tasks/[id]/assess/[conversationId]/reply` (new)

**The interview phase.** Called once per user answer.

**Steps:**
1. Load conversation + all prior messages
2. Load objectives_registry + role_registry
3. Save user's answer as a message in `assessment_messages`
4. Call Claude with: full original context + all prior turns + new answer
5. Claude determines:
   - Are there more low-confidence objectives to ask about? If yes → next question (same format)
   - Are all objectives now scoreable? → finalize
6. If finalizing:
   - Claude returns final scores for all 7 objectives + effort estimate + risk level + role assessments (which roles are affected + usage frequency)
   - Compute InvertedInfluence and FVI using `lib/fvi.ts`
   - Upsert `objective_assessments` (task_id + objective_id, score, reasoning)
   - Update `tasks` (fvi_score, cost_effort, cost_risk, inverted_influence)
   - Save `conversation_role_assessments`
   - Update `assessment_conversations` status to 'complete', store final_scores + fvi_score
   - Write ClickUp description update (non-fatal)
   - If GitHub token: write vault spec stub to `FeaturePlanning/_Active/{slug}.md` per Feature-Spec-Template.md format
7. Return: next question OR finalized result

### 5.5 `POST /api/sprint/tasks/[id]/assess/[conversationId]/confirm` (new)

Called when the user reviews the proposed scores and clicks **"These look right"** without needing any questions. Runs steps 6–7 from the reply handler (finalize immediately from proposed scores).

### 5.6 `GET /api/sprint/tasks/[id]/assess` (new)

Returns all `assessment_conversations` for a task, ordered newest first. Used to load prior assessments when the user reopens a task.

### 5.7 Modify `DELETE /api/sprint/tasks/[id]/assess/[conversationId]` (new)

Allows abandoning an in-progress conversation.

---

## Part 6 — UI Redesign (`app/sprint/page.tsx`)

### Assessment Modal — Three Views

**View A: Loading** (init in progress)
Simple spinner with "Claude is reading the vault and reviewing your backlog…"

**View B: Interview**
Two-column layout (640px modal, fixed height):

- **Left column (top):** Task name, ClickUp status, current FVI
- **Left column (middle):** Figma frame thumbnail (if available) — visual anchor
- **Left column (bottom):** Overlapping tasks found (if any) — "⚠️ DEV-124 covers similar ground (already in Sprint 3)"
- **Left column (bottom):** Cost of not building / workflow gap — Claude's assessment from vault
- **Right column (top):** Proposed scores — all 7 objectives shown as a compact grid. Each shows: objective name, owner, proposed score (-5 to +5), confidence indicator (✓ high / ? low). User can click any score to override it directly.
- **Right column (middle):** Current question from Claude — the interview card:
  - Badge: which objective (e.g., `Obj 2 — The Invisible Hand`)
  - Question text (bold)
  - Reasoning paragraph (lighter, smaller)
  - Evidence from vault (italic, with file path citation)
  - Text area for user's answer
  - "Answer" button
- **Right column (bottom, conditional):** "These all look right — skip to results" button (only shown when user hasn't started answering yet)
- **Progress:** "Question 2 of 4" indicator

**View C: Results**
- FVI score banner (large, color-coded: green ≥5, blue 2–5, yellow 0.5–2, red <0.5)
- Decision verdict: "Build This Sprint" / "Build Next Sprint" / "Backlog" / "Kill"
- Trojan Horse warning if triggered
- Per-objective breakdown: score + owner + one-sentence reasoning
- InvertedInfluence breakdown: which roles were affected + usage frequency
- Updated description (as written to ClickUp + vault)
- Overlapping tasks (if found) with links
- If re-assessment: diff vs previous scores ("▲ +2 from previous")
- "Done" button closes modal and refreshes task list

### Role Assessment Step (between interview and results)

After the last question but before finalizing, Claude will have identified which roles are affected. Present a compact role picker:
- Pre-selected roles (Claude's suggestion based on feature description)
- Usage frequency dropdown per role (1–4)
- "Confirm Roles" button → triggers final computation

This is the data that drives InvertedInfluence. It's one step, not a question.

---

## Part 7 — Figma Integration (Visual Anchor)

**Scope for this feature:** Display only. No write-back.

**Flow:**
1. During `/assess/init`, check if the task's custom fields contain a Figma URL (field name likely "Figma Link" or similar)
2. If found AND Figma OAuth token exists: call Figma API `GET /v1/images/{file_key}` for the specific frame
3. Return thumbnail URL in the init response
4. Display in assessment modal left column as a static image with caption "Current design — Figma"

**If no Figma link or no token:** left column shows task description text instead. Not blocking.

---

## Part 8 — Vault Write-back (on Assessment Complete)

When an assessment is finalized, Claude generates and commits a spec stub to the vault:

**Path:** `FeaturePlanning/_Active/{clickup-task-id}-{slug}.md`

**Content follows Feature-Spec-Template.md format:**
- Context (from task description + assessment answers)
- Influence Assessment table (the confirmed role selections + frequencies)
- FVI Assessment (all 7 scores with reasoning + formula result)
- Empty sections (Acceptance Criteria, Architecture Notes, etc.) — left for the developer to fill

**Commit message:** `PM Agent: FVI assessment for {task name} ({date})`

---

## Part 9 — Files Modified / Created

| Action | File |
|--------|------|
| Create | `supabase/migrations/002_assessment_redesign.sql` |
| Create | `lib/fvi.ts` |
| Create | `lib/github/vault.ts` |
| Create | `lib/github/connect.ts` |
| Create | `app/api/github/connect/route.ts` |
| Create | `app/api/github/callback/route.ts` |
| Replace | `app/api/sprint/tasks/[id]/assess/route.ts` → split into `init/route.ts` |
| Create | `app/api/sprint/tasks/[id]/assess/[conversationId]/reply/route.ts` |
| Create | `app/api/sprint/tasks/[id]/assess/[conversationId]/confirm/route.ts` |
| Create | `app/api/sprint/tasks/[id]/assess/route.ts` (GET — list conversations) |
| Modify | `app/sprint/page.tsx` — replace assessment modal with 3-view interview UI |
| Create | `__tests__/lib/fvi.test.ts` — unit tests for formula |

---

## Part 10 — Implementation Order

Do not start Part N+1 until Part N is complete and tested.

1. **GitHub OAuth App** — user action (prerequisite for everything)
2. **Database migration** — run in Supabase SQL editor; seed objectives + roles
3. **`lib/fvi.ts`** + tests — formula must be correct before it's called anywhere
4. **`lib/github/vault.ts`** — can be tested independently via a small script
5. **GitHub OAuth routes** (`/connect`, `/callback`) — verify token stores correctly in `oauth_tokens`
6. **`/api/sprint/tasks/[id]/assess/init`** — the heaviest lift; test with a real task
7. **`/api/sprint/tasks/[id]/assess/[conversationId]/reply`** + `/confirm`
8. **`/api/sprint/tasks/[id]/assess` GET** — list conversations
9. **UI — View A + B** (loading + interview) — connect to init + reply
10. **UI — Role picker step**
11. **UI — View C** (results)
12. **Vault write-back** — spec stub generation + commit
13. **Figma visual anchor** — last; non-blocking

---

## Open Questions — RESOLVED (2026-04-13)

1. **Vault repo name on GitHub:** ✅ `ViscapMedia/documentation` — confirmed. Use as `GITHUB_VAULT_REPO` env var.
2. **Figma custom field name in ClickUp:** ✅ The field is a link to the Figma project. Look for any URL custom field containing `figma.com`. Note: Figma project organization needs a separate game plan (future work).
3. **Effort unit:** ✅ Total dev-days only (`E = Days × Devs` computed by the PM before entering). Claude asks for a single number, not days + devs separately.
4. **Spec stub naming:** ✅ Include the ClickUp task ID: `YYYY-MM-DD-[clickup-id]-[feature-slug].md`. This prevents overwrites when merging to main and keeps files traceable.
5. **Who sets Risk (R)?** ✅ Claude proposes the risk level based on the Risk Matrix in `documentation/DevObjectives/How Conflicts are Resolved.md` (Routine 1.0×, Standard 1.2×, Moderate 1.5×, High 2.0×, Critical 3.0×) and the Risk Checklist. The user confirms or overrides. The canonical source for all objective scoring breakdowns and the Risk Checklist is `ViscapMedia/documentation/DevObjectives/`.

---

## Track B — Vault Update Notes (after implementation)

- Add `pm-app` to `Repo-Registry.md` as the PM tooling repo
- Add GitHub, Figma, Webflow OAuth flows to `GitHub/pm-app.md` (create this file)
- Add assessment conversation schema to the migration doc
- Update `FeaturePlanning/README.md` to note that PM App writes spec stubs automatically

## Track C — CLAUDE.md Updates (after implementation)

- Add note: `lib/fvi.ts` is the single source of truth for all FVI math — never compute FVI inline
- Add note: all vault reads/writes go through `lib/github/vault.ts` — never call GitHub API directly
- Add note: `objectives_registry` and `role_registry` tables are seeded data — do not hardcode objective names or role weights in application code

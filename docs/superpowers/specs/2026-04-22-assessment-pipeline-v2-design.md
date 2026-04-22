# Assessment Pipeline v2 Design

**Date:** 2026-04-22
**Status:** Approved for implementation planning

## Overview

The PM Agent assessment modal is redesigned from a single-phase FVI calculator into a **7-phase guided pipeline** that produces everything the team needs to build, ship, and document a feature — from influence scoring through to Help & Resources content for the CS team.

The pipeline is experimental by design. Each run is tagged as an **experiment** so the team can compare prompt versions across features, trace output quality via `git blame`, and evolve the pipeline as the process matures.

---

## Problem Statement

Five issues with the current assessment flow drove this redesign:

1. **Missing 0 option** — The role frequency dropdown had no "Cannot Access" option; excluded roles couldn't be expressed.
2. **Incomplete role list** — Only Claude's proposed roles appeared; all 30 roles must be visible and editable.
3. **No explanation for overrides** — Users could silently change Claude's role scores with no audit trail.
4. **Non-deterministic scores** — Running the same spec multiple times produced different influence scores because the interview Q&A phase was not reliably triggering, leaving Claude without user-supplied calibration.
5. **No persistent reference** — Assessment results were inaccessible after closing the modal.

The redesign fixes all five while expanding the pipeline to produce documentation, user stories, implementation plans, and CS-ready Help & Resources content.

---

## FVI Formula

$$FVI = \frac{ObjTotal + 64}{InvertedInfluence \times Effort \times Risk}$$

$$InvertedInfluence = 1 - \frac{3 \times I\_DM\_norm + I\_NDM\_norm}{4}$$

Where:
- `I_DM_norm  = I_DM_raw  / 380` (max possible DM score)
- `I_NDM_norm = I_NDM_raw / 224` (max possible NDM score)

FVI decisions: `≥5` build-this-sprint · `2–5` build-next-sprint · `0.5–2` backlog · `<0.5` kill · `<0` kill-immediately

---

## The 7-Phase Pipeline

---

### Phase 1: Workflow Standardization & Impact Audit

#### Objective
Map the feature to a standardized list of affected workflows, determine downstream documentation impacts, and surface edge cases through targeted Q&A before any scoring begins.

#### Workflow Mapping
Claude reads the feature description and any existing 7 Objective notes. It then proposes a list of **standardized workflow names** derived from both the feature description and the existing manuals in the docs repository. Workflow names must match or be derived from the canonical names in those manuals — this is not a free-form list of actions.

A `workflow_registry` reference document will be maintained in the docs repo to keep workflow names consistent across features.

#### New Workflow Proposals
If Claude identifies a workflow impact with no match in the existing manuals, it proposes a standardized title for a new Manual entry and adds it to `affected_workflows` with `registry_status: "proposed"`. The PM can accept the title, rename it, or merge it with an existing entry. Proposed entries appear in `workflow_registry` as drafts until a manual is written. Nothing blocks on this — the assessment continues with the proposed name.

#### Impact Audit
For every workflow identified, Claude must ask the user to confirm whether the change impacts:
- **Internal SOPs** — team processes and operating procedures
- **Education Products** — lessons or content sold to customers
- **ScribeHow Tutorials** — step-by-step manual tutorials

#### Clarifying Questions
Claude asks **at least 3 targeted questions** to surface edge cases and role-specific impacts. These questions are clarifying questions designed to help Claude answer the three core questions as accurately as possible:

1. What workflows change as a result of this feature (not just what it does)?
2. What edge cases or failure modes exist?
3. Which roles are affected directly vs. indirectly?

The questions Claude asks are not these three verbatim — they are tailored to the specific feature and designed to elicit the information needed to answer these three accurately.

#### If Objective Notes Do Not Exist
If no 7 Objective notes exist for this task, Claude creates initial drafts before asking questions. The questions then refine those drafts.

**Output stored:** `affected_workflows[]` with impact flags per workflow (`sop_impacted`, `education_impacted`, `scribehow_impacted`, `registry_status: "existing" | "proposed"`)

---

### Phase 2: Iterative Objective Evaluation (FVI)

#### State Management
If Objective scores and notes already exist for this task, the user is asked:

> "Objective scores exist for this feature. Would you like to regenerate them? If yes, should I consider the existing notes during the process? If there's something specific that's wrong, please describe it."

#### Scoring
Seven objectives scored –5 to +5. Claude's reasoning explicitly references the workflows identified in Phase 1.

#### The Critique Loop
If the user provides feedback on any single objective score (e.g., "Complexity is higher because of X"), Claude re-evaluates **all 7 objectives** — not just the one mentioned. Claude then explains the **ripple effect**: how adjusting one score influenced the others, and why. The user must give final approval on the full modified set before proceeding.

**Stored in:** `objective_assessments`, `assessment_conversations.final_scores`

---

### Phase 3: Total Role Influence (30 Roles)

**All 30 roles** from `role_registry` are shown and editable, grouped: Agency DM → Agency NDM → Brand DM → Brand NDM. This matches the canonical spreadsheet template exactly.

**Frequency dropdown (corrected order):**

| Value | Meaning |
|---|---|
| 0 | Cannot Access |
| 1 | Access Sometimes |
| 2 | Access by Default |
| 3 | Uses Sometimes |
| 4 | Uses Every Day |

Note: values 1 and 2 are swapped from the previous implementation to match the spreadsheet column order and scoring semantics. This changes the raw influence score for any role assigned either value — the FVI formula is unchanged but existing assessments will produce different I-DM/I-NDM totals if re-run. Historical assessments are not retroactively recalculated.

**Default state:** Every role defaults to 0 and is editable. Claude proposes frequencies for roles it identifies as affected; all other roles remain at 0 with no reasoning pre-filled.

**Per-role reasoning:** Each row shows Claude's proposed frequency and its reasoning inline. The user can edit both the frequency and the reasoning text at any time.

**Audit trail:**
- Rows using Claude's proposed frequency display an **AI badge**
- Rows where the user has changed the frequency display a **Person icon**
- When a user overrides a frequency, the `user_reasoning` field is **mandatory** — the user must provide an explanation before the confirm button activates

**Override data model:** `conversation_role_assessments` stores Claude's proposal and the user's final decision separately:

```
claude_proposed_frequency  int (0–4)
user_override_frequency    int (0–4) nullable
claude_reasoning           text
user_reasoning             text        -- required when user_override_frequency is set
```

Active frequency = `user_override_frequency ?? claude_proposed_frequency`

One row is created per role per assessment for all 30 roles. Roles Claude did not select get `claude_proposed_frequency = 0` and null reasoning. This makes the full role picture queryable without joining against the registry.

---

### Phase 4: De-duplicated User Stories

After roles are confirmed, Claude generates user stories for every Role × Workflow pairing with a score > 0.

**De-duplication rule:** If multiple roles share the exact same `[workflow step]`, `[action]`, and `[outcome]`, they are combined into a single story rather than repeated:

```
As a [Role1], [Role2], or [Role3], when [workflow step],
I need to [action] so that [outcome].
```

Each story is tied to a specific workflow from Phase 1 and links back to the roles and their frequency scores. The PM reviews, edits, and approves inline. These stories are the source of truth for Phase 5 task mapping, Phase 6 acceptance criteria, and Phase 7 tutorial content.

**Stored in:** `assessment_conversations.user_stories` (JSONB)

---

### Phase 5: Implementation Plan

Claude writes a TDD-format implementation plan:

- **Goal** — one sentence
- **Architecture** — 2–3 sentences
- **Tech stack** — key technologies
- **Tasks** — each decomposed into Red (failing test) → Green (minimal implementation) → Refactor steps, with each task mapped to one or more Phase 4 user stories

---

### Phase 6: Dev & QA Skills

Two short skill documents generated per feature:

- **`dev-skill.md`** — critical constraints, patterns, and gotchas specific to this feature
- **`qa-skill.md`** — pressure scenarios and acceptance criteria derived from Phase 4 user stories

---

### Phase 7: Handover & Help Resources

#### Content Generated
- **ScribeHow steps** — numbered, click-by-click instructions for each affected workflow
- **Glossary entries** — any new vocabulary introduced by the feature
- **Manual update notes** — which existing help docs need revision and what changes

#### ScribeHow Handover Checklist
ScribeHow tutorials may require editing by the UI/UX Designer or Software Engineer to ensure the prototype matches the final spec. A handover checklist is generated covering:

- [ ] UI/UX Designer has reviewed ScribeHow steps against the approved prototype
- [ ] Software Engineer has confirmed all described interactions are implemented
- [ ] Prototype matches the spec described in `spec.md`
- [ ] Any divergences between prototype and spec are documented

#### Communication SOP
A ClickUp comment template is generated and committed to `help-resources.md`. It is used to notify the CS team of impacts to Education Products or SOPs identified in Phase 1:

```
[PM Agent — Feature Impact Notice]

Feature: [Feature Name] ([TASK-ID])
Branch: [next-release/feature-slug]

Workflows affected: [list]
Impacts:
  - Internal SOPs: [yes/no — which ones]
  - Education Products: [yes/no — which ones]
  - ScribeHow Tutorials: [yes/no — which ones]

Action required before release:
  □ CS team to review help-resources.md
  □ Update affected SOP documents
  □ Update affected Education Product content
  □ Approve ScribeHow tutorial edits

Docs folder: [GitHub link to next-release/feature-slug/]
```

This comment is posted to the ClickUp task when the feature moves to `next-release`.

---

## Experiments Model

An **experiment** is a named trial of a prompt configuration run against one or more features. Experiments let the team test whether a prompt change improves output quality before adopting it permanently.

### Database

```sql
create table experiments (
  id             text primary key,       -- slug, e.g. "influence-v2"
  name           text not null,          -- human label
  description    text,                   -- hypothesis being tested
  prompt_version text,                   -- which prompt set was used
  created_at     timestamptz default now()
);
```

`assessment_conversations` gains an optional `experiment_id` FK. A feature can appear in multiple experiments; an experiment covers multiple features.

### Commit Tagging

Every vault doc commit made under an experiment includes both the experiment ID and the PM-App commit ID at the time of bundle creation:

```
feat(DEV-10405): bundle assessment docs [exp:influence-v2] [pm-app:a3f9c12]
```

The `commit_id` is the git SHA of the PM-App repo at bundle time. The backend resolves this via `NEXT_PUBLIC_COMMIT_SHA` (set at build time) or `git rev-parse HEAD` at runtime. It is stored in:
- `assessment_conversations.pm_app_commit_id`
- The metadata section of `assessment.md`
- The git commit message for every vault write

`git blame` on any vault doc then traces it to the exact PM-App version and prompt configuration that generated it.

### Experiments Tab

A tab on the task detail page shows all experiments the feature participated in. Each experiment shows every phase output, editable inline. Phase docs are stored in the database (working copy) and in GitHub (committed copy). Edits update the database record; a "Sync to vault" button re-commits to GitHub.

A standalone Experiments page lists all experiments with links to every participating feature and aggregate quality notes.

### Prompt Versioning

`prompt_version` on each experiment records which version of the init/reply/confirm prompts was used. This enables before/after comparisons as prompts evolve.

---

## GitHub Branch Structure

Branches mirror ClickUp lists. Features do not get their own branches — they get folders inside the current stage branch.

```
main            ← shipped features (moved to Archive in ClickUp)
next-release    ← CS-reviewed and ready to ship
active          ← currently in development
planning        ← being assessed or specced
```

Each feature lives at `[branch]/[feature-slug]/` containing all its phase docs.

### Lifecycle Automation (ClickUp webhook → GitHub Action)

| ClickUp list change | GitHub action |
|---|---|
| → Planning | Create feature folder in `planning` |
| Planning → Active | Move folder to `active`, open PR |
| Active → Next Release | Move folder to `next-release`, open CS review PR + post ClickUp comment |
| Next Release → Archive | Merge feature folder to `main` |

### CS Review Gate

When a feature reaches `next-release`, a PR is auto-opened tagging the CS team. The PR body links directly to `help-resources.md`. The ClickUp comment template from Phase 7 is posted to the task. CS approval triggers the merge to `main`.

### Selective Merge to Main

Only archived features merge to `main`. Because every commit carries `[feat:TASK-ID]`, `[exp:SLUG]`, and `[pm-app:SHA]` tags, `git blame` on any doc in `main` shows the experiment, prompt version, and PM-App build that generated it.

---

## Bundle: Vault Docs Written to GitHub

| File | Contents | Status |
|---|---|---|
| `spec.md` | Feature spec stub | Existing |
| `assessment.md` | Full FVI breakdown: objectives with reasoning, role influence table (Claude proposals + user overrides), effort, risk, formula inputs/outputs, experiment ID, PM-App commit SHA | **New** |
| `user-stories.md` | All Phase 4 de-duplicated stories with role + workflow mapping | **New** |
| `plan.md` | TDD implementation plan mapped to user stories | **Replaces `plan-draft.md`** |
| `dev-skill.md` | Feature-specific dev constraints and gotchas | **New** |
| `qa-skill.md` | Acceptance criteria and pressure scenarios | **New** |
| `help-resources.md` | ScribeHow steps, glossary, manual update notes, handover checklist, ClickUp comment template | **New** |
| `roles-affected.md` | Role influence table (sourced from assessment.md data) | Existing |
| `kickoff-prompt.md` | Kickoff context for developers | Existing |

---

## Data Model Changes

### New table: `experiments`

```sql
create table experiments (
  id             text primary key,
  name           text not null,
  description    text,
  prompt_version text,
  created_at     timestamptz default now()
);
```

### Modified table: `assessment_conversations`

```sql
alter table assessment_conversations
  add column experiment_id        text references experiments(id),
  add column pm_app_commit_id     text,
  add column affected_workflows   jsonb,   -- [{name, sop_impacted, education_impacted, scribehow_impacted}]
  add column user_stories         jsonb,
  add column implementation_plan  text,
  add column dev_skill            text,
  add column qa_skill             text,
  add column help_resources       text;
```

### Modified table: `conversation_role_assessments`

```sql
alter table conversation_role_assessments
  add column claude_proposed_frequency int check (claude_proposed_frequency between 0 and 4),
  add column user_override_frequency   int check (user_override_frequency between 0 and 4),
  add column claude_reasoning          text,
  add column user_reasoning            text;  -- required when user_override_frequency is not null
```

One row is created per role per assessment for all 30 roles. Roles Claude did not select get `claude_proposed_frequency = 0` and null reasoning.

---

## Design Decisions

**Why show all 30 roles and make all editable?**
Previously only roles with a Claude-proposed score could be adjusted. This excluded the CS team from explicitly marking roles as "Cannot Access," which is as meaningful as an inclusion. All 30 roles default to 0 and are fully editable.

**Why swap frequency values 1 and 2?**
"Access Sometimes" is lower engagement than "Access by Default." The corrected order matches the canonical spreadsheet column ordering. Historical assessments are not retroactively recalculated.

**Why is `user_reasoning` mandatory on override?**
The CS team needs to understand why a human corrected Claude's proposal. Mandatory reasoning also creates a feedback signal for prompt calibration — consistent corrections indicate a prompt weakness.

**Why de-duplicate user stories?**
Repeating the same story for 8 roles that share identical workflow, action, and outcome adds noise without value. Combined stories are easier to review and map more cleanly to QA test cases.

**Why include PM-App commit SHA in bundles?**
The PM-App's prompts evolve over time. Tagging each bundle with the commit SHA at generation time means `git blame` on a vault doc can identify exactly which version of the PM-App logic produced it — enabling precise before/after comparisons when prompts change.

**Why long-lived stage branches instead of per-feature branches?**
Stage branches make the repo a mirror of the ClickUp board state — visible at a glance, CS-reviewable as a set, and cleanly mergeable to main feature by feature when they ship.

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
2. **Incomplete role list** — Only Claude's proposed roles appeared; the CS team needed to see all 30 roles.
3. **No explanation for overrides** — Users could silently change Claude's role scores with no audit trail.
4. **Non-deterministic scores** — Running the same spec multiple times produced different influence scores because the interview Q&A phase was not reliably triggering, leaving Claude without user-supplied calibration.
5. **No persistent reference** — Assessment results were inaccessible after closing the modal.

The redesign fixes all five while expanding the pipeline to produce documentation, user stories, implementation plans, and CS-ready Help & Resources content.

---

## The 7-Phase Pipeline

### Phase 1: Brainstorming

Claude reads the ClickUp spec and vault context, then **always** opens a structured conversation (fixing the interview-skipping bug). Claude asks at least 3 targeted questions:

- What workflows change as a result of this feature (not just what it does)?
- What edge cases or failure modes exist?
- Which roles are affected directly vs. indirectly?

**Output stored:** `affected_workflows[]` — a named list of workflow steps the feature touches. Every subsequent phase references these workflows.

**Fix for non-determinism:** By requiring Claude to gather workflow context before proposing anything, role and objective proposals become grounded in user-supplied information rather than spec text alone.

---

### Phase 2: Developer Objective Evaluation (FVI)

Seven objectives scored –5 to +5 via the existing conversation flow. No formula changes. Claude's objective reasoning now explicitly references the workflows identified in Phase 1.

Stored in: `objective_assessments`, `assessment_conversations.final_scores`

---

### Phase 3: Influence Calculations

**All 30 roles** from `role_registry` are shown, grouped: Agency DM → Agency NDM → Brand DM → Brand NDM. This matches the canonical spreadsheet template exactly.

**Frequency dropdown (corrected order):**

| Value | Label |
|---|---|
| 0 | Cannot Access |
| 1 | Access Sometimes |
| 2 | Access by Default |
| 3 | Uses Sometimes |
| 4 | Uses Every Day |

Note: values 1 and 2 are swapped from the previous implementation to match the spreadsheet column order and scoring semantics. This changes the raw influence score for any role assigned either of these values — the FVI formula is unchanged but existing assessments will produce different I-DM/I-NDM totals if re-run. Historical assessments are not retroactively recalculated.

**Default state:** Every role defaults to 0. Claude's proposed frequencies are pre-filled for roles it selected.

**Per-role reasoning:** Each row shows Claude's reasoning for its proposed frequency inline. Users can edit both the frequency and the reasoning text. Rows where the user has changed Claude's value display a person icon; rows using Claude's proposal display an AI badge.

**Explanation requirement:** When a user changes a frequency, the reasoning field highlights with the label "Your override — explain why." No hard block, but clearly expected.

**Override data model:** `conversation_role_assessments` stores both Claude's proposal and the user's final decision separately:

```
claude_proposed_frequency  int (0–4)
user_override_frequency    int (0–4) nullable
claude_reasoning           text
user_reasoning             text
```

Active frequency = `user_override_frequency ?? claude_proposed_frequency`

---

### Phase 4: User Stories

After roles are confirmed, Claude generates updated user stories for every unique workflow × role pairing that scored > 0.

Format:
```
As a [Role], when [workflow step], I need to [action] so that [outcome].
```

The PM reviews, edits, and approves inline. These stories become the source of truth for QA acceptance criteria and Help & Resources content.

Stored in: `assessment_conversations.user_stories` (JSONB)

---

### Phase 5: Implementation Plan

Claude writes a TDD-format implementation plan:

- **Goal** — one sentence
- **Architecture** — 2–3 sentences
- **Tech stack** — key technologies
- **Tasks** — each decomposed into Red (failing test) → Green (minimal implementation) → Refactor steps, with each task mapped to one or more user stories from Phase 4

---

### Phase 6: Dev & QA Skills

Two short skill documents generated per feature:

- **Dev skill** — critical constraints, patterns, and gotchas specific to this feature
- **QA skill** — pressure scenarios and acceptance criteria derived from Phase 4 user stories

These are usable as context documents for the development team and as a test planning reference for QA.

---

### Phase 7: Help & Resources

Structured content for the CS and documentation team:

- **ScribeHow steps** — numbered, click-by-click instructions for each affected workflow
- **Glossary entries** — any new vocabulary introduced by the feature
- **Manual update notes** — which existing help docs need revision and what changes

---

## Experiments Model

An **experiment** is a named trial of a specific prompt configuration run against one or more features. It is not per-feature — a single experiment may span many features to test whether a prompt change improves output quality consistently.

### Database

```sql
experiments
  id          text primary key  -- slug, e.g. "influence-v2"
  name        text              -- human label
  description text              -- hypothesis being tested
  prompt_version text           -- which prompt set was used
  created_at  timestamptz

assessment_conversations
  experiment_id text FK → experiments(id) nullable
```

### Git commit tagging

Every vault doc commit made under an experiment includes the experiment ID:

```
feat(DEV-10405): bundle assessment docs [exp:influence-v2]
```

`git blame` on any doc then shows which experiment produced it, linking output quality directly to the prompt configuration. The CS team uses this to evaluate experiment results: "influence-v2 assigned Videographer to this feature — was that accurate?"

### Experiments tab

A tab on the task detail page shows all experiments this feature participated in, with each phase's outputs displayed and editable. Phase docs are stored in the database (working copy) and in GitHub (committed copy). Edits in the tab update the database record; a "Sync to vault" button re-commits to GitHub.

A standalone Experiments page lists all experiments with links to every participating feature and aggregate quality notes.

### Prompt versioning

The `prompt_version` field on each experiment records which version of the init/reply/confirm prompts was used. This enables before/after comparisons as prompts are refined.

---

## GitHub Branch Structure

Branches mirror ClickUp lists. Features do not get their own branches — they get folders inside the appropriate stage branch.

```
main            ← shipped features only (archived in ClickUp)
next-release    ← CS-reviewed, ready to ship
active          ← currently being built
planning        ← being assessed / specced
```

Each feature lives at `[branch]/[feature-slug]/` containing all its phase docs.

### Lifecycle automation (ClickUp webhook → GitHub Action)

| ClickUp list change | GitHub action |
|---|---|
| → Planning | Create folder in `planning`, initial commit |
| Planning → Active | Move folder to `active`, open PR |
| Active → Next Release | Move folder to `next-release`, open CS review PR |
| Next Release → Archive | Merge feature folder to `main`, close PR |

### CS review gate

When a feature lands in `next-release`, a PR is auto-opened tagging the CS team. The PR body lists which phase docs need review — specifically `help-resources.md` (ScribeHow steps, glossary, manual updates). CS team approval triggers the merge.

### Selective merge to main

When a ClickUp task moves to Archive, only that feature's folder is merged from `next-release` to `main`. Features that are delayed or descoped stay in `next-release` without polluting `main`. Because commits are tagged with `[feat:TASK-ID]` and `[exp:SLUG]`, `git blame` on any doc in `main` traces directly to the experiment and prompt version that generated it.

---

## Bundle: Vault Docs Written to GitHub

| File | Contents | Status |
|---|---|---|
| `spec.md` | Feature spec stub | Existing |
| `assessment.md` | Full FVI breakdown: objectives with reasoning, role influence table (Claude proposals + user overrides), effort, risk, formula inputs/outputs, experiment ID | **New** |
| `user-stories.md` | All Phase 4 stories with role + workflow mapping | **New** |
| `plan.md` | TDD implementation plan (replaces `plan-draft.md`) | **Replaces existing** |
| `dev-skill.md` | Feature-specific dev constraints and gotchas | **New** |
| `qa-skill.md` | Acceptance criteria and pressure scenarios | **New** |
| `help-resources.md` | ScribeHow steps, glossary entries, manual update notes | **New** |
| `roles-affected.md` | Role influence table (sourced from assessment.md data) | Existing |
| `kickoff-prompt.md` | Kickoff context for developers | Existing |

---

## Data Model Changes

### New table: `experiments`

```sql
create table experiments (
  id           text primary key,
  name         text not null,
  description  text,
  prompt_version text,
  created_at   timestamptz default now()
);
```

### Modified table: `assessment_conversations`

```sql
alter table assessment_conversations
  add column experiment_id       text references experiments(id),
  add column affected_workflows  jsonb,
  add column user_stories        jsonb,
  add column implementation_plan text,
  add column dev_skill           text,
  add column qa_skill            text,
  add column help_resources      text;
```

### Modified table: `conversation_role_assessments`

```sql
alter table conversation_role_assessments
  add column claude_proposed_frequency int check (claude_proposed_frequency between 0 and 4),
  add column user_override_frequency   int check (user_override_frequency between 0 and 4),
  add column claude_reasoning          text,
  add column user_reasoning            text;
```

One row is created per role per assessment for all 30 roles (not just Claude's proposals). Roles Claude did not select get `claude_proposed_frequency = 0` and null reasoning. This makes the full role picture queryable without joining against the registry.

---

## Design Decisions

**Why show all 30 roles instead of just Claude's proposals?**
The CS team needs to confirm which roles cannot access a feature, not just which can. A missing role is as meaningful as a present one. Defaulting to 0 (Cannot Access) makes exclusion explicit rather than implied by absence.

**Why swap frequency values 1 and 2?**
"Access Sometimes" represents lower engagement than "Access by Default" — a role that only occasionally encounters the feature vs. one that has it enabled as standard. The corrected order matches the canonical spreadsheet column ordering and the cumulative scoring semantics (higher value = more integrated into workflow).

**Why separate claude_proposed vs. user_override in the database?**
The CS team needs to know whether a role assignment reflects AI judgment or human correction. This distinction is also critical for experiment evaluation — if users consistently override Claude's proposals for a particular role type, that's a signal the prompt needs calibration.

**Why long-lived stage branches instead of per-feature branches?**
Per-feature branches made it impossible to see "everything in Planning" or "everything in Next Release" without querying ClickUp. Stage branches make the repo a mirror of the ClickUp board state — visible at a glance, CS-reviewable as a set, and cleanly mergeable to main when features ship.

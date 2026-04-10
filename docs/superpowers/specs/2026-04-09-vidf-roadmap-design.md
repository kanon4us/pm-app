# Viscap Integrated Development Framework (VIDF) — Roadmap Design

**Date:** 2026-04-09
**Status:** Approved
**Authors:** Michael Terry + Claude Code

---

## 1. Purpose

The VIDF is Viscap's internal development operating system. It connects the Product Manager's feature decisions to the developer's execution environment and closes the loop through documentation, Webflow publishing, and quality measurement. It replaces ad-hoc planning with a structured, AI-assisted workflow that is measurable from day one.

The PM-App (web dashboard) is the PM-facing command center. The Viscap Plugin (Claude Code) is the developer-facing orchestration layer. The Documentation Vault (ViscapMedia/documentation) is the system of record. ClickUp status changes drive every lifecycle transition.

---

## 2. Architecture

Three systems, one loop.

### 2.1 Systems

**PM-App** (web, Vercel, Next.js + Supabase)
The Product Manager's command center. Scores FVI, generates the developer resource bundle, commits it to the feature's vault branch, posts the kickoff prompt as a ClickUp comment. Monitors all ClickUp status changes via webhook → trigger queue. Fires Webflow, release note, and archive automation. Tracks developer experiment assignments for the Git Blame quality system.

**ViscapMedia/viscap-plugin** (Claude Code plugin, permanent)
Developer-facing. Installed once, works across all features. Contains three core skills: `chief-architect`, `pm-agent`, `quality-gate`. Compatible with Superpowers — both active simultaneously in the same session. Viscap handles orchestration (Phases 1–2, 4); Superpowers handles execution (Phase 3).

**ViscapMedia/documentation** (the vault)
System of record. PM-App creates `docs/feature/[slug]` branch per feature and commits the resource bundle. Viscap Plugin reads from this branch during the developer session. After ship and feature flags removed, PM-App merges the branch to main.

**ClickUp**
Status-driven, not list-driven. The four lists (Planning → Active → Next Release → Archive) represent team handoffs, not task types. Tasks move between lists as a side effect of status changes the PM-App webhook processes.

**Write-back targets:** GitHub (vault) · ClickUp · Webflow · Figma (Figma write-back deferred post-v1; display-only in current PM-App assessment modal)

### 2.2 Data Flow

```
PM scores feature in PM-App
        │
        ▼
Resource Bundle generated → committed to docs/feature/[slug] vault branch
        │
        ▼
Developer pastes kickoff prompt → Viscap Plugin reads vault branch → session setup
        │
        ▼
ClickUp status changes → PM-App trigger queue → lifecycle automation fires
        │
        ▼
Feature ships → flags removed → vault branch merges to main → Webflow publishes → experiment record closes
```

---

## 3. Phase 0: Git Blame Quality Baseline

**Priority: Immediate — before any other VIDF changes land.**

### 3.1 Purpose

The Resource Bundle is the primary experiment the team is conducting. Before introducing any workflow changes, a baseline must be established so that the effect of each bundle version on code quality is measurable. Every commit across all five repos must be tagged with the workflow context active when it was written.

### 3.2 Tagging Strategy

A global post-commit git hook queries the PM-App experiment API and appends metadata to every commit message:

```
[vidf:pre | bundle:v0 | sop:v0 | sprint:2026-04]
```

As VIDF phases roll out, the tag evolves:

```
Phase 1:     [vidf:v1 | bundle:v1.0 | sop:v1 | sprint:2026-04]
Bundle tweak:[vidf:v1 | bundle:v1.1 | sop:v1 | sprint:2026-05]
Phase 2:     [vidf:v2 | bundle:v1.1 | sop:v2 | sprint:2026-06]
```

### 3.3 Hook Architecture

```
Developer runs git commit
        │
        ▼
Global post-commit hook fires
        │
        ▼
GET /api/developers/{git-email}/experiment
        │
        ▼
PM-App returns: { tag, bundle_version, sop_version, sprint }
        │
        ▼
Hook appends tag to commit message
        │
        ▼
GitHub Action validates tag is present on every push
(fails PR check if missing — enforces adoption)
```

### 3.4 PM-App Requirements for Phase 0

| Component | Description |
|-----------|-------------|
| `developer_experiments` table | Maps developer GitHub email → current experiment tag, bundle version, SOP version, sprint |
| `bundle_versions` table | Tracks what each bundle version contains — files, format, Claude context used, date activated |
| `GET /api/developers/[email]/experiment` | Read-only, key-authenticated endpoint the git hook calls |
| PM dashboard: experiment assignment | PM assigns developers to bundle versions; tracks adoption rate |
| `scripts/install-git-hook.sh` (Viscap Plugin) | One-time global hook installer developers run once |
| GitHub Action (per repo) | Validates tag presence on every push; fails PR check if missing |

### 3.5 Repos in Scope

All six Viscap repos tagged from day one:
- `app.viscap.ai`
- `viscap-ai-cloud-functions`
- `documentation`
- `media-sync-desktop`
- `mercury`
- `pm-app` (this repo)

---

## 4. Phase 1: Planning Loop

The PM's primary workflow. Starts with a feature idea, ends with a developer having everything needed to open their Claude Code session.

### 4.1 FVI Assessment

The PM-App Assessment Modal runs a multi-turn interview powered by Claude API (`claude-opus-4-6` with adaptive thinking). It gathers vault context (GitHub search), Figma thumbnail, overlapping tasks, and previous assessments, then scores all 7 objectives and computes the FVI.

**FVI Formula:** `FVI = (Objective Total + 64) / (Inverted Influence × Cost)`

**Decision thresholds:**

| FVI Score | Decision |
|-----------|----------|
| > 5.0 | Build this sprint |
| 2.0 – 5.0 | Build next sprint |
| 0.5 – 2.0 | Backlog |
| < 0.5 | Kill |
| Negative | Kill immediately |

If FVI < 0.5, PM-App generates a Priority Analysis comment on the ClickUp task explaining paths to increase the score.

### 4.2 Resource Bundle

The Resource Bundle is committed to `docs/feature/[slug]` in `ViscapMedia/documentation`. It is the experiment unit — every bundle generated is stamped with the active `bundle_version`. The structure and contents of the bundle are the primary variable being tested against code quality outcomes.

**Bundle contents (v1.0):**

| File | Contents |
|------|---------|
| `spec.md` | Feature name, FVI score, objective breakdown, role influence, risk level, Figma link, vault evidence from assessment |
| `plan-draft.md` | High-level implementation plan; FE/BE split flagged if complexity warrants; file paths inferred from codebase |
| `claude-md-block.md` | Pre-written Feature Focus block ready to inject into repo CLAUDE.md |
| `kickoff-prompt.md` | Exact prompt developer pastes into Claude Code to activate Viscap Plugin |
| `webflow-stub.md` | Coming Soon draft pre-populated with feature name and FVI rationale |
| `roles-affected.md` | Which of 26 roles are affected, usage frequency per role, influence breakdown |
| `release-notes-draft.md` | Stub populated at deploy time; consolidated at sprint close |
| `scribehow-link.md` | **Optional.** If PM attaches a ScribeHow flow during assessment, pm-agent includes it in the Acceptance Criteria section of `spec.md`. If absent, Acceptance Criteria is a manual placeholder. |

The bundle version is logged in PM-App when generated. Subsequent bundle structure iterations increment the version number (`v1.1`, `v1.2`, `v2.0` for major changes). Results (bug rate, churn, deviations) are measured per bundle version.

### 4.3 FE/BE Split Logic

PM-App flags a feature for FE/BE split during assessment when Claude identifies both significant UI work and significant data/API work.

- **If split:** PM-App creates two ClickUp tasks — `[Project] | FE | [slug]` and `[Project] | BE | [slug]`. Both reference the same vault branch. BE task gets a "blocks" dependency on FE task. Both tasks tracked separately in PM-App.
- **If small (same list):** Single task, no split.

### 4.4 Kickoff Prompt

```
Start feature: [feature-name]
Vault branch: docs/feature/[slug]
ClickUp: [task-url]
FVI: [score] | Risk: [level] | FE/BE: [single|split]
Bundle: [bundle_version]

[viscap:pm-agent]
```

PM-App posts this prompt as a ClickUp comment on the task and displays it in the PM-App UI. The `[viscap:pm-agent]` tag activates the Viscap Plugin's pm-agent skill.

### 4.5 What's Already Built vs. Needed

| Component | Status |
|-----------|--------|
| Assessment Modal — init + reply routes | 80% complete |
| FVI calculation (`lib/fvi.ts`) | Complete |
| GitHub vault read/write (`lib/github/vault.ts`) | Complete |
| Vault branch creation | Not yet built |
| Resource bundle file generation | Not yet built |
| Bundle version stamping + logging | Not yet built |
| ClickUp comment write-back | Not yet built |
| FE/BE split logic + task creation | Not yet built |

---

## 5. Phase 2: Viscap Plugin (`ViscapMedia/viscap-plugin`)

A permanent Claude Code plugin developers install once. Structured like Superpowers but Viscap-specific.

### 5.1 Repo Structure

```
viscap-plugin/
├── .claude-plugin/
│   └── plugin.json          # name: viscap, version: 1.0.0
├── skills/
│   ├── chief-architect/
│   │   └── SKILL.md
│   ├── pm-agent/
│   │   └── SKILL.md
│   └── quality-gate/
│       └── SKILL.md
├── hooks/
│   └── hooks.json           # SessionStart hook: loads experiment context + self-repair check
└── scripts/
    └── install-git-hook.sh  # One-time global hook installer (also run by self-repair)
```

**SessionStart self-repair:** On every session open, the `SessionStart` hook checks whether the global git hook is installed in the current repo. If missing, it immediately offers to run `install-git-hook.sh`. Developer confirms with one keypress. This prevents PR failures for developers who missed the initial install step.

### 5.2 `pm-agent` Skill

Activates when developer pastes the kickoff prompt. Reads `docs/feature/[slug]` from the vault branch. Executes in order:

1. Creates git worktree for the feature branch
2. Reads `spec.md`, `plan-draft.md`, `roles-affected.md` from vault branch
3. Injects `claude-md-block.md` as Feature Focus block into repo CLAUDE.md
4. Presents FE/BE split to developer if flagged — confirms sequencing
5. Verifies experiment tag is active (calls PM-App API; alerts if hook not installed)
6. Hands off to developer — Superpowers picks up from here for execution

### 5.3 `chief-architect` Skill

For cases where a developer must re-run the spec mid-feature (risk matrix triggered). Reads current vault branch state, presents the three-condition risk check:

| Condition | Question | If No |
|-----------|----------|-------|
| Easy Rollback | Can this change be undone in < 30 min with no data loss? | Halt |
| No Delay | Does this change keep the sprint deadline intact? | Halt |
| No Side Effects | Does this change touch zero other features or Critical Path? | Halt |

All three Yes → Developer logs deviation in `spec.md` and proceeds. Any No → two paths:

**Standard path:** Developer halts and surfaces to PM via ClickUp comment. Session waits for PM response.

**Low-Risk Bypass:** Developer can proceed past any "No" by writing a Super-Explanation (minimum 3 sentences: what changed, why it's worth the risk, explicit rollback plan). The bypass is appended to the commit message as `[risk:bypass]` and logged in PM-App as `priority: high` in the SOP Improvement Candidates queue for PM review next session. The bypass is always available — it is a documented override with full accountability, not a loophole.

Deviations (both standard and bypassed) are stored in PM-App as `spec_deviations` associated with the active bundle version.

### 5.4 `quality-gate` Skill

Phase 8 gate before `finishing-a-development-branch` completes.

**Pull-before-write:** Before writing anything to the vault branch, the skill pulls the latest remote state. If a conflict exists (e.g., BE developer already wrote to the branch), the skill surfaces it for the developer to resolve before the gate can close.

**Checklist:**

- Pull latest vault branch (resolve conflicts if any)
- Vault branch updated with lessons learned in the correct FE or BE section
- `spec.md` marked complete with final FVI actuals
- TDD skips logged with documented reasons
- `webflow-stub.md` confirmed present in vault branch
- Experiment tag confirmed present on all commits in the feature branch

### 5.5 Superpowers Compatibility

- No namespace conflicts — Viscap skills use `viscap:` prefix; Superpowers uses `superpowers:`
- Both plugins active simultaneously in the same session
- Viscap Plugin handles orchestration (Phases 1–2, 4); Superpowers handles execution (Phase 3)
- `pm-agent` skill explicitly hands off to Superpowers after session setup

---

## 6. Phase 3: Status-Driven Automation

Every VIDF lifecycle transition is triggered by a ClickUp status change hitting the PM-App webhook. The trigger queue routes each event through an approval step or auto-executes based on action risk level.

### 6.1 Status Map

| ClickUp Status | List Transition | PM-App Action | Approval |
|----------------|----------------|---------------|----------|
| → In Progress | Planning → Active | Posts kickoff comment to ClickUp | No |
| → Architecting | Active | Syncs engineering plan updates from vault branch to ClickUp task description | No |
| → Ready for QA | Active | Posts QA checklist; runs Sync Pulse spec-drift check | No |
| → Deployed | Active → Next Release | Publishes Webflow Coming Soon; writes release notes draft to vault branch; notifies CS/Education/Marketing | PM approves |
| Custom: Flag Lifted | Next Release | Upgrades Webflow Coming Soon → full feature post (Education/Marketing 3-day review window) | PM approves |
| Milestone: Sprint Close | — | Consolidates all feature release notes for sprint into one Webflow release notes post | PM approves |
| → Archived | Next Release → Archive | Merges vault branch → main; strips Feature Focus from CLAUDE.md; archives spec; closes bundle experiment record | No |

### 6.2 Sync Pulse (QA Gate) + Back-Fill Logic

**Sync Pulse:** Before QA begins, PM-App compares the vault spec's last-updated timestamp against the most recent commit timestamp on the feature branch. If the spec predates recent commits, PM-App blocks the QA trigger and surfaces a spec-drift warning in the trigger queue. Developer must update `spec.md` before QA proceeds.

**Status Jump Back-Fill:** Developers sometimes skip statuses (e.g., In Progress → Deployed without hitting → Ready for QA). PM-App detects these jumps by comparing the current status against expected prior statuses in the task's history. When a jump is detected:
1. PM-App runs all missed automation steps in order before processing the current status
2. If Sync Pulse never fired (QA was skipped), it runs retroactively before any Deployed automation executes
3. If spec is stale, Deployed trigger pauses and surfaces the drift warning before publishing anything to Webflow
4. The gap is logged in the trigger queue as a warning (not a blocker for the merge)

The GitHub Action does NOT block merges for missed status triggers. It only enforces the experiment tag presence.

### 6.3 Archive Loop

```
Feature flags removed in code
        │
        ▼
Status → Archived
        │
        ▼
PM-App fires:
1. Merge docs/feature/[slug] → main in documentation vault
2. Strip Feature Focus block from repo CLAUDE.md
3. Move spec.md → FeaturePlanning/_Archive/
4. Mark bundle_version experiment record complete
   (captures: ship date, TDD skips, spec deviations)
5. Webflow Coming Soon → Posts (if Flag Lifted already fired)
        │
        ▼
Sprint Close fires:
All feature release-notes-draft.md files → single Webflow release notes post
```

### 6.4 Webflow Pipeline

| Stage | Trigger | Action |
|-------|---------|--------|
| Coming Soon stub | → Deployed | PM-App generates from `webflow-stub.md`; publishes immediately |
| Full feature post | Flag Lifted | PM-App generates draft; Education/Marketing reviews in vault for 3 business days; then publishes |
| Release notes post | Sprint Close | PM-App consolidates all feature `release-notes-draft.md` files; PM approves; publishes |

### 6.5 What's Already Built vs. Needed

| Component | Status |
|-----------|--------|
| Webhook receiver + HMAC verification | Complete |
| Trigger queue (Realtime, approve/dismiss) | Complete |
| Trigger config table (7 rules) | Complete |
| ClickUp task write-back | Not yet built |
| Vault branch merge on archive | Not yet built |
| CLAUDE.md Feature Focus strip | Not yet built |
| Webflow Coming Soon publish | Not yet built |
| Webflow Coming Soon → Posts upgrade | Not yet built |
| Sprint Close release notes consolidation | Not yet built |
| Sync Pulse spec-drift check | Not yet built |
| Bundle experiment record close on archive | Not yet built |

---

## 7. Phase 4: VIDF Depth

Feedback loops that make VIDF self-improving over time.

### 7.1 TDD Skip Tracking

When a developer skips the TDD gate, the `quality-gate` skill prompts for a documented reason before allowing the skip. That reason is:

1. Appended to the commit message: `[tdd:skipped | reason:ui-only]`
2. Posted to PM-App via `POST /api/experiments/tdd-skip`
3. Stored against the active bundle version
4. Surfaced in PM-App as **SOP Improvement Candidates** — a queue the PM reviews to identify patterns (e.g., "UI work consistently skips TDD — should we formalize a UI exception rule?")

### 7.2 Spec Deviation Tracking

Every mid-feature spec deviation (risk matrix triggered) is logged to PM-App as a `spec_deviation` associated with the active bundle version. Deviations are classified:

- **Low Risk / Approved** — developer had authority to pivot; no escalation
- **Halted / Escalated** — developer surfaced to PM; re-assessment may have run

Over time, high deviation rates on a specific bundle version signal that the bundle isn't giving developers enough clarity.

### 7.3 SOP Improvement Candidates Queue

TDD skips + spec deviations + quality gate failures feed a PM-facing queue in PM-App. Each candidate shows:
- What happened (skip, deviation, drift)
- Which bundle version was active
- Developer and feature
- Suggested SOP rule change

PM reviews the queue per sprint and decides whether to increment the bundle version.

---

## 8. Phase 5: Quality Analysis

A periodic report (per sprint close or monthly) that queries GitHub commit history across all five repos and measures VIDF impact.

### 8.1 Metrics

| Metric | How Measured |
|--------|-------------|
| Bug rate | Commits tagged `fix:` or linked to bug ClickUp tasks, grouped by bundle version |
| Code churn | Lines changed in fix commits vs. feature commits, per bundle version |
| Review cycles | PR review round count, grouped by bundle version |
| Spec deviation rate | `spec_deviations` per feature, per bundle version |
| TDD skip rate | Skip count / total commits, per bundle version |
| Time Planning → Archive | Sprint duration per feature, per bundle version |

### 8.2 Comparison View

PM-App surfaces a quality report comparing:
- `bundle:v0` (pre-VIDF baseline) vs. each subsequent bundle version
- Bundle versions against each other (A/B comparisons if team was split)
- Trend lines across sprints

This is not a real-time dashboard. It runs at sprint close and stores the snapshot in PM-App.

---

## 9. Open Questions (Resolved)

All design questions from the VIDF brainstorm draft and team review have been resolved:

| Question | Resolution |
|----------|-----------|
| Git Blame SOP version tag in commit messages? | Yes — automated via global git hook, not manual |
| ScribeHow integration? | Optional field in v1 bundle. If PM attaches a ScribeHow link during assessment, pm-agent includes it in Acceptance Criteria in `spec.md`. Required-field consideration deferred to Phase 4. |
| TDD skip archive location? | PM-App `tdd_skips` table against bundle version record; not in vault |
| FE/BE split without list duplication? | Separate ClickUp tasks with same vault branch; dependency chain enforces sequencing |
| PM Agent execution model? | Hybrid — Viscap Plugin orchestrates; Superpowers executes; PM-App handles lifecycle automation |
| FE/BE concurrent vault branch writes? | Sequential by design (BE blocks FE). `quality-gate` skill does pull-before-write on vault branch. `spec.md` and `release-notes-draft.md` have dedicated `## FE` and `## BE` sections to minimize conflict surface. |
| Missed ClickUp status updates (status skipping)? | PM-App detects status jumps and back-fills missed automation in order. GitHub Action does NOT block merges for missed triggers. Sync Pulse runs retroactively before Deployed automation fires — if spec is stale, Deployed trigger pauses and surfaces drift warning before any Webflow publish. |
| Git hook adoption for new hires / contractors? | Viscap Plugin `SessionStart` hook self-detects missing global hook and offers immediate install. GitHub Action remains enforcement backstop for repos without the hook. PRs fail if tag is missing — self-repair is the path out. |
| Developer blocked at 2 AM by risk matrix "Halt"? | Low-Risk Bypass added to `chief-architect` skill. Developer can proceed past any "No" by writing a Super-Explanation (minimum 3 sentences: what changed, why it's worth the risk, rollback plan). Bypass tagged `[risk:bypass]` in commit; flagged `priority: high` in SOP Improvement Candidates queue for PM review next session. |

---

## 10. Implementation Order

| Phase | Deliverable | Depends On |
|-------|-------------|------------|
| 0 | Git hook + GitHub Action + PM-App experiment API | Nothing — start immediately |
| 1a | Complete Assessment Modal (reply/confirm routes + UI) | Existing assessment init route |
| 1b | Vault branch creation + resource bundle generation | Phase 1a |
| 1c | ClickUp kickoff comment write-back | Phase 1b |
| 2 | `ViscapMedia/viscap-plugin` repo + 3 skills | Phase 1b (reads bundle format) |
| 3a | Webflow Coming Soon publish pipeline | Phase 1b |
| 3b | Archive loop (vault merge, CLAUDE.md strip) | Phase 2 |
| 3c | Sprint Close release notes consolidation | Phase 3a |
| 4 | TDD skip tracking, spec deviations, SOP candidates queue | Phase 2 + 3 |
| 5 | Quality analysis report | Phase 0 + enough tagged commits |

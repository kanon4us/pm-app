# PM App — ViscapMedia

An AI-assisted product management tool that guides feature assessment from initial spec through to CS-ready documentation. Built on Next.js, Supabase, and Claude.

---

## What It Does

The PM Agent takes a ClickUp feature task and walks it through a 7-phase assessment pipeline. At the end, every stakeholder has what they need:

- **Engineering** gets a TDD implementation plan and dev skill document
- **QA** gets acceptance criteria and pressure scenarios
- **CS** gets ScribeHow tutorial steps, glossary updates, and manual revision notes
- **Everyone** gets a persistent, versioned record in GitHub that mirrors the feature's lifecycle stage

---

## The Assessment Pipeline

Triggered from a task card in the sprint view. Each phase produces a document committed to the vault (GitHub docs repo).

| Phase | What happens | Output doc |
|---|---|---|
| 1. Brainstorming | Claude asks ≥3 questions about affected workflows, edge cases, and role impact | Stored in DB |
| 2. Objective Evaluation | 7 developer objectives scored –5 to +5 via Q&A | `assessment.md` |
| 3. Influence Calculations | All 30 roles rated 0–4; Claude proposes, PM overrides with explanation | `assessment.md`, `roles-affected.md` |
| 4. User Stories | Stories generated for every role × workflow pairing that scored > 0 | `user-stories.md` |
| 5. Implementation Plan | TDD-format plan: Red → Green → Refactor per task, mapped to user stories | `plan.md` |
| 6. Dev & QA Skills | Feature-specific constraints for devs; acceptance criteria for QA | `dev-skill.md`, `qa-skill.md` |
| 7. Help & Resources | ScribeHow steps, glossary entries, manual update notes for CS team | `help-resources.md` |

### Role Frequency Scale

| Value | Meaning |
|---|---|
| 0 | Cannot Access |
| 1 | Access Sometimes |
| 2 | Access by Default |
| 3 | Uses Sometimes |
| 4 | Uses Every Day |

### FVI Formula

```
FVI = (ObjTotal + 64) / (InvertedInfluence × Effort × Risk)

InvertedInfluence = 1 − ((3 × I_DM_norm + I_NDM_norm) / 4)
I_DM_norm  = I_DM_raw  / 380   (max possible DM score)
I_NDM_norm = I_NDM_raw / 224   (max possible NDM score)
```

FVI decisions: `≥5` build-this-sprint · `2–5` build-next-sprint · `0.5–2` backlog · `<0.5` kill · `<0` kill-immediately

---

## Experiments

An **experiment** is a named trial of a prompt configuration run across multiple features. Experiments let the team test whether a prompt change improves output quality before adopting it permanently.

Every vault doc commit is tagged with the experiment ID:

```
feat(DEV-10405): bundle assessment docs [exp:influence-v2]
```

`git blame` on any doc in the vault traces it back to the exact prompt version that generated it. The **Experiments tab** on each task shows all experiments the feature participated in, with every phase output visible and editable.

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

### Lifecycle Automation

When a ClickUp task changes list, a webhook triggers a GitHub Action:

| ClickUp list change | GitHub action |
|---|---|
| → Planning | Create feature folder in `planning` |
| Planning → Active | Move folder to `active`, open PR |
| Active → Next Release | Move folder to `next-release`, open CS review PR |
| Next Release → Archive | Merge feature folder to `main` only |

### CS Review Gate

When a feature reaches `next-release`, a PR is auto-opened tagging the CS team. The PR body links directly to `help-resources.md` (ScribeHow steps, glossary, manual updates). CS approval triggers the merge to `main`.

### Selective Merge to Main

Only archived features merge to `main` — delayed or descoped features stay in `next-release` without polluting main. Because every commit carries `[feat:TASK-ID]` and `[exp:SLUG]` tags, `git blame` on any doc in `main` shows which experiment generated it and when it shipped.

---

## Project Structure

```
pm-app/
├── app/
│   ├── sprint/          # Task board and assessment modal
│   └── api/
│       └── sprint/tasks/[id]/
│           ├── assess/
│           │   ├── init/        # Phase 1–2: brainstorming + objective scoring
│           │   └── [convId]/
│           │       ├── reply/   # Q&A turns
│           │       └── confirm/ # Phase 3: role influence confirm + FVI compute
│           └── bundle/          # Phases 4–7: doc generation + vault commit
├── lib/
│   └── fvi.ts           # FVI formula and influence calculations
├── docs/
│   └── superpowers/
│       ├── specs/        # Design documents
│       └── plans/        # Implementation plans
└── __tests__/
    └── lib/fvi.test.ts
```

---

## Database Tables

| Table | Purpose |
|---|---|
| `tasks` | ClickUp task mirror with FVI score, effort, risk |
| `assessment_conversations` | One per assessment run; holds all phase outputs |
| `assessment_messages` | Individual Q&A turns in the interview phase |
| `conversation_role_assessments` | Per-role frequency with Claude proposal + user override |
| `objective_assessments` | Per-objective scores and reasoning |
| `bundle_generations` | Vault write record: branch, files, ClickUp fields |
| `experiments` | Named prompt trials spanning multiple features |
| `role_registry` | All 30 roles with weight, DM/NDM, team domain |
| `objectives_registry` | 7 developer objectives with score matrices |

---

## Local Development

```bash
npm install
npm run dev
```

Requires `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
CLICKUP_API_TOKEN=
GITHUB_TOKEN=
VAULT_REPO=
```

---

## Design Specs

Full design documents live in [`docs/superpowers/specs/`](docs/superpowers/specs/):

- [Assessment Pipeline v2](docs/superpowers/specs/2026-04-22-assessment-pipeline-v2-design.md) — current architecture
- [FVI Assessment Redesign](docs/superpowers/plans/2026-04-06-pm-agent-assessment-redesign.md) — original FVI formula and decision thresholds

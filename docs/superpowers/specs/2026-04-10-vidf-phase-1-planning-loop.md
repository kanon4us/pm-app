# VIDF Phase 1: Planning Loop — Design Spec

**Date:** 2026-04-10
**Status:** Approved
**Authors:** Michael Terry + Claude Code

---

## 1. Overview

Phase 1 completes the PM's planning workflow: after the FVI Assessment Modal scores a feature, the PM generates the Resource Bundle. The bundle is committed to a feature vault branch in `ViscapMedia/documentation`, a kickoff prompt is posted to ClickUp, and optionally two tasks are created for FE/BE split features.

**What's already built:**
- `POST /api/sprint/tasks/[id]/assess/init` — vault context gather, pre-score, first question
- `POST /api/sprint/tasks/[id]/assess/[conversationId]/reply` — multi-turn interview
- `POST /api/sprint/tasks/[id]/assess/[conversationId]/confirm` — FVI compute + DB save
- `lib/github/vault.ts` — read/write vault files on `main`
- `lib/fvi.ts` — FVI calculation
- `lib/clickup/client.ts` — task read/update

**What Phase 1 adds:**
- New `POST /api/sprint/tasks/[id]/assess/[conversationId]/bundle` route
- Vault branch creation in `ViscapMedia/documentation`
- 7-file resource bundle generation (single Claude call)
- Bundle version stamping + `bundle_generations` Supabase table
- ClickUp kickoff comment write-back
- FE/BE split: task rename + new task creation + dependency

---

## 2. Architecture

### 2.1 Route Split

`confirm` stays fast:
- Computes FVI
- Saves scores, effort, risk, FVI to DB
- Updates ClickUp task description (non-fatal)
- Returns FVI result immediately

**Removed from confirm:** the current vault spec write moves to the bundle route.

New `bundle` route (called by UI after confirm resolves, while showing "Generating bundle…" spinner):
1. Load conversation, task, and assessment data from DB
2. Fetch active `bundle_version` from `bundle_versions` table (`is_active=true`)
3. Create vault branch `docs/feature/[clickupId]-[slug]` off `main`
4. Single Claude call → 7-file JSON bundle
5. Commit all 7 files to the branch
6. Log `bundle_generations` record
7. Post kickoff prompt as ClickUp comment
8. If `feBeSplit=true`: rename original task, create FE task, set dependency

### 2.2 Data Flow

```
PM clicks "Confirm Assessment"
        │
        ▼
POST /confirm → FVI computed, saved to DB
        │
        ▼
UI shows FVI score + "Generate Bundle" button
        │
        ▼
POST /bundle
  ├── Create vault branch
  ├── Claude generates 7 files
  ├── Commit files to branch
  ├── Log bundle_generations
  ├── Post ClickUp kickoff comment
  └── (if split) Rename task + create FE task + set dependency
        │
        ▼
Return { branchUrl, files[], commentId, warnings[], feBeSplit? }
```

---

## 3. New API Route: `/bundle`

**`POST /api/sprint/tasks/[id]/assess/[conversationId]/bundle`**

Request body:
```typescript
{
  feBeSplit: boolean
  figmaLink?: string
}
```

Response:
```typescript
{
  branchName: string
  branchUrl: string
  bundleVersion: string
  filesWritten: string[]
  clickupCommentId: string | null
  feTaskId: string | null   // only if feBeSplit=true
  beTaskId: string | null   // only if feBeSplit=true
  warnings: string[]        // non-fatal failures
}
```

All external calls (GitHub, ClickUp) are non-fatal — failures are collected in `warnings[]` and the route always returns 200.

---

## 4. Resource Bundle

### 4.1 Vault Branch

Branch name: `docs/feature/[clickupTaskId]-[slug]`
- Built by existing `vaultBranchName()` in `lib/github/vault.ts`
- Created off `main` using GitHub Git Refs API

`lib/github/vault.ts` gains one new function:
- `createVaultBranch(token, branchName)` — creates the branch off main using GitHub Git Refs API

All 7 file writes use the existing `writeVaultFile(token, path, content, message, branch)` with the new branch name passed explicitly.

### 4.2 Bundle Files

All 7 files committed to `docs/feature/[slug]/`:

| Path | Description |
|------|-------------|
| `spec.md` | Feature name, FVI score, objective breakdown, role influence, risk, Figma link, vault evidence |
| `plan-draft.md` | High-level implementation plan; FE/BE split noted if applicable |
| `claude-md-block.md` | Feature Focus block ready to inject into repo CLAUDE.md |
| `kickoff-prompt.md` | Exact prompt developer pastes into Claude Code |
| `webflow-stub.md` | Coming Soon draft with feature name and FVI rationale |
| `roles-affected.md` | Affected roles, usage frequency, influence breakdown |
| `release-notes-draft.md` | Stub for sprint close consolidation |

### 4.3 Claude Bundle Generation

Single call to `claude-opus-4-6` with extended thinking. System prompt instructs Claude to return valid JSON with 7 string keys (`spec_md`, `plan_draft_md`, `claude_md_block_md`, `kickoff_prompt_md`, `webflow_stub_md`, `roles_affected_md`, `release_notes_draft_md`).

Input context passed to Claude:
- Task name, ClickUp ID, ClickUp description
- FVI score, decision threshold
- All 7 objective scores with reasoning
- Roles affected with usage frequencies
- Effort (days), risk level
- Figma link (if present)
- Vault context snippets from the assessment conversation
- Active bundle version
- FE/BE split flag

The `kickoff_prompt_md` content exactly matches what gets posted to ClickUp:
```
Start feature: [feature-name]
Vault branch: docs/feature/[clickupId]-[slug]
ClickUp: https://app.clickup.com/t/[clickupTaskId]
FVI: [score] | Risk: [level] | FE/BE: [single|split]
Bundle: [bundleVersion]

[viscap:pm-agent]
```

### 4.4 Bundle Version Stamping

Active bundle version: query `bundle_versions` for `is_active=true` record. This is the `bundle_version` stamped on the `bundle_generations` record and included in the kickoff prompt.

---

## 5. Database: `bundle_generations` Table

New Supabase migration `004_bundle_generations.sql`:

```sql
CREATE TABLE bundle_generations (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id            UUID        NOT NULL REFERENCES tasks(id),
  conversation_id    UUID        NOT NULL REFERENCES assessment_conversations(id),
  bundle_version     TEXT        NOT NULL,
  branch_name        TEXT        NOT NULL,
  files_written      JSONB       NOT NULL DEFAULT '[]',
  clickup_comment_id TEXT,
  fe_task_id         TEXT,
  be_task_id         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bundle_generations_task ON bundle_generations(task_id);
```

Add corresponding TypeScript types to `lib/supabase/types.ts`.

---

## 6. ClickUp Client Extensions

Add to `buildClickUpClient` in `lib/clickup/client.ts`:

```typescript
createComment: (taskId: string, commentText: string) =>
  // POST /task/{task_id}/comment

createTask: (listId: string, body: { name: string; description?: string }) =>
  // POST /list/{list_id}/task

setDependency: (taskId: string, dependsOnTaskId: string) =>
  // POST /task/{task_id}/dependency
```

The `listId` for FE task creation comes from the task's existing `list_id` stored in the `tasks` table. If `list_id` is not present on the task record, FE/BE split logs a warning and skips task creation without failing.

---

## 7. FE/BE Split Logic

When `feBeSplit=true`:

1. Rename original ClickUp task: prepend `[BE] ` to name
2. Create new ClickUp task in same list: `[FE] [original name]`
3. Set dependency: BE task depends on FE task (`setDependency(beTaskId, feTaskId)`)
4. Store both IDs in `bundle_generations.fe_task_id` / `be_task_id`
5. Update original task record in Supabase `tasks` table with new name

Both tasks reference the same vault branch. The kickoff prompt in `kickoff-prompt.md` notes `FE/BE: split`.

If any ClickUp call fails: log to `warnings[]`, continue — the vault branch and files are already written.

---

## 8. Error Handling

All external calls wrapped in try/catch. Failures append to `warnings[]`:

| Step | On failure |
|------|-----------|
| Vault branch creation | Add warning, skip all file writes, return early with warning |
| Individual file write | Add warning for that file, continue writing remaining files |
| Bundle version lookup | Default to `"v0"`, add warning |
| ClickUp comment | Add warning, continue |
| FE/BE task creation | Add warning, continue |
| FE/BE dependency set | Add warning, continue |

Vault branch creation is the only failure that short-circuits (can't write files without a branch).

---

## 9. TypeScript Types

Add to `lib/supabase/types.ts` (inside `Tables:`):

```typescript
bundle_generations: {
  Row: {
    id: string
    task_id: string
    conversation_id: string
    bundle_version: string
    branch_name: string
    files_written: Json
    clickup_comment_id: string | null
    fe_task_id: string | null
    be_task_id: string | null
    created_at: string
  }
  Insert: {
    id?: string
    task_id: string
    conversation_id: string
    bundle_version: string
    branch_name: string
    files_written?: Json
    clickup_comment_id?: string | null
    fe_task_id?: string | null
    be_task_id?: string | null
  }
  Update: {
    files_written?: Json
    clickup_comment_id?: string | null
    fe_task_id?: string | null
    be_task_id?: string | null
  }
  Relationships: []
}
```

---

## 10. Testing

New test file: `__tests__/api/sprint/tasks/bundle.test.ts`

Mocks: Supabase client, Anthropic client, GitHub vault functions, ClickUp client.

Test cases:
- Returns 401 when unauthenticated
- Creates branch, generates files, returns correct response
- Handles vault branch creation failure gracefully (warning, no files written)
- Handles individual file write failure (warning, other files still written)
- FE/BE split: renames task, creates FE task, sets dependency
- FE/BE split ClickUp failure: warning only, bundle still returned
- Stamps correct bundle version from active `bundle_versions` record
- Posts kickoff prompt as ClickUp comment

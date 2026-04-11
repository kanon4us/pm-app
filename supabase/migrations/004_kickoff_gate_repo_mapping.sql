-- Migration 004: Kickoff Gate #4 — repo-to-list mapping
--
-- Changes:
--   repo_registry  — add github_repo_full_name (owner/repo string for GitHub API calls)
--   lists          — add repo_registry_id FK (many lists → one repo, nullable)
--   tasks          — add kickoff_gate_overrides JSONB (audit trail for legacy-zone acknowledgments)
--
-- Relationship: lists.repo_registry_id → repo_registry.id (n:1)
-- Multiple ClickUp lists can map to the same code repository.
-- repo_registry retains its role as the Cross-Repo Dependency Scanner registry;
-- it has no knowledge of ClickUp — the mapping lives on the lists side.

-- ── repo_registry ─────────────────────────────────────────────────────────────

-- Full GitHub repo path in owner/repo format (e.g. "ViscapMedia/pm-app").
-- Required for GitHub Contents API and Code Search calls.
-- Nullable so existing rows are not broken; should be populated before Gate #4 runs.
ALTER TABLE repo_registry
  ADD COLUMN github_repo_full_name TEXT;

-- Enforce uniqueness once populated (prevents duplicate repo registrations).
CREATE UNIQUE INDEX repo_registry_github_full_name_uq
  ON repo_registry (github_repo_full_name)
  WHERE github_repo_full_name IS NOT NULL;

COMMENT ON COLUMN repo_registry.github_repo_full_name
  IS 'GitHub owner/repo string (e.g. "ViscapMedia/pm-app"). Used for GitHub API calls in Kickoff Checklist Gate #4 and Cross-Repo Scan.';

-- ── lists ─────────────────────────────────────────────────────────────────────

-- FK to the primary code repository for tasks in this list.
-- Nullable: lists that are not backed by a code repo (e.g. admin/ops lists) leave this null,
-- which causes Gate #4 to show "No repo mapped — configure in Setup" rather than blocking.
ALTER TABLE lists
  ADD COLUMN repo_registry_id UUID REFERENCES repo_registry(id) ON DELETE SET NULL;

COMMENT ON COLUMN lists.repo_registry_id
  IS 'FK to the code repository that backs this ClickUp list. Used by Kickoff Checklist Gate #4 to find and scan for baseline tests.';

-- ── tasks ─────────────────────────────────────────────────────────────────────

-- Stores developer overrides for Kickoff Checklist gates that cannot be automatically satisfied.
-- Shape: { "gate_4": { "acknowledgedAt": "ISO date", "reason": "Legacy codebase — tests being added in parallel ticket CU-XXX" } }
-- A gate with an override entry displays as yellow (acknowledged) rather than red (blocked).
-- An override does NOT make the gate green — the developer must resolve the underlying condition
-- or carry the acknowledgment forward as a documented risk.
ALTER TABLE tasks
  ADD COLUMN kickoff_gate_overrides JSONB;

COMMENT ON COLUMN tasks.kickoff_gate_overrides
  IS 'Developer acknowledgments for Kickoff Checklist gates that cannot be auto-satisfied (e.g. Gate #4 in a legacy codebase). Shape: { "gate_4": { "acknowledgedAt": string, "reason": string } }';

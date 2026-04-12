-- Migration 005: Bundle Generations
--
-- Changes:
--   assessment_conversations  — add vault_spec_content (persists Claude-generated spec so bundle
--                               route can read it without the client re-sending it)
--   bundle_generations        — audit trail for each vault resource bundle write attempt
--
-- Safe to re-run — all statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

-- ── assessment_conversations ──────────────────────────────────────────────────

ALTER TABLE assessment_conversations
  ADD COLUMN IF NOT EXISTS vault_spec_content TEXT;

COMMENT ON COLUMN assessment_conversations.vault_spec_content
  IS 'Claude-generated spec stub written during confirm step. Read by /bundle to produce spec.md without re-sending from client.';

-- ── bundle_generations ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bundle_generations (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id                  UUID        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  conversation_id          UUID        NOT NULL REFERENCES assessment_conversations(id) ON DELETE CASCADE,
  generated_by             UUID        NOT NULL REFERENCES users(id),
  vault_branch             TEXT,
  vault_spec_url           TEXT,
  files_written            TEXT[]      NOT NULL DEFAULT '{}',
  clickup_fields_written   TEXT[]      NOT NULL DEFAULT '{}',
  clickup_comment_posted   BOOLEAN     NOT NULL DEFAULT FALSE,
  error_details            JSONB,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bundle_generations_task ON bundle_generations(task_id);
CREATE INDEX IF NOT EXISTS idx_bundle_generations_conv ON bundle_generations(conversation_id);

COMMENT ON TABLE bundle_generations
  IS 'Audit log for each vault resource bundle generation. One row per Generate Bundle click.';

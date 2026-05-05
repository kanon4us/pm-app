-- supabase/migrations/012_bot_sops.sql

-- Add sop_version to slack_issues
ALTER TABLE slack_issues ADD COLUMN sop_version INTEGER;

-- Add 'passive' status (confirmed duplicate — thread alive, bot appends to parent)
ALTER TYPE slack_issue_status ADD VALUE IF NOT EXISTS 'passive';

-- Replace human_takeover boolean with reversible handoff_status
-- 'taken': dev claimed the ticket; 'returned': dev sent it back for more info; null: no handoff yet
ALTER TABLE slack_issues DROP COLUMN human_takeover;
ALTER TABLE slack_issues ADD COLUMN handoff_status TEXT
  CHECK (handoff_status IN ('taken', 'returned'));

-- pgvector: install extension + add embedding column for Phase B.5 semantic duplicate detection
-- Phase A just creates the column (NULL); population deferred to Phase B.5
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE slack_issues ADD COLUMN embedding vector(1536);

-- bot_sops: versioned behavioral rules for the bot
CREATE TABLE bot_sops (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version              INTEGER UNIQUE NOT NULL,
  intake_prompt        TEXT NOT NULL,
  escalation_rules     JSONB NOT NULL DEFAULT '{}',
  duplicate_thresholds JSONB NOT NULL DEFAULT '{}',
  manual_directives    JSONB NOT NULL DEFAULT '[]',
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  change_summary       TEXT,
  approved_by          TEXT,
  approved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Exactly one active SOP at any time
CREATE UNIQUE INDEX idx_bot_sops_single_active ON bot_sops(status) WHERE status = 'active';

-- bot_observations: structured outcome log for every bot action
CREATE TABLE bot_observations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_ts        TEXT REFERENCES slack_issues(thread_ts) ON DELETE CASCADE,
  clickup_task_id  TEXT,
  sop_version      INTEGER,
  event_type       TEXT NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bot_obs_thread     ON bot_observations(thread_ts);
CREATE INDEX idx_bot_obs_sop        ON bot_observations(sop_version);
CREATE INDEX idx_bot_obs_event_type ON bot_observations(event_type);
CREATE INDEX idx_bot_obs_created_at ON bot_observations(created_at);

-- sop_proposals: bot-generated improvement proposals awaiting PM review
CREATE TABLE sop_proposals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sop_version       INTEGER NOT NULL,
  proposed_changes  JSONB NOT NULL DEFAULT '{}',
  pattern_summary   TEXT NOT NULL,
  supporting_data   JSONB NOT NULL DEFAULT '{}',
  rejection_history JSONB NOT NULL DEFAULT '[]',
  claude_confidence FLOAT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending_review'
                    CHECK (status IN ('pending_review', 'approved', 'rejected')),
  pm_response       TEXT,
  resolved_by       TEXT,
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sop_proposals_status ON sop_proposals(status);

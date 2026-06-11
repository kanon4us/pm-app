-- 018_bot_chat.sql
-- Help & Resources chatbot: policies, derived-signal observations, runtime settings.
-- Spec: docs/superpowers/specs/2026-06-09-help-resources-chatbot-phase0-1.md
--
-- PRIVACY BOUNDARY (decision D6): bot_chat_observations stores DERIVED SIGNALS ONLY.
-- Conversation message text lives in Viscap's Firestore (helpConversations/*).
-- Do NOT add message/text columns to these tables.

CREATE TABLE bot_chat_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  classification_prompt TEXT NOT NULL,
  answer_prompt TEXT NOT NULL,
  escalation_rules JSONB NOT NULL DEFAULT '{}',   -- {max_turns, min_confidence, must_escalate_phrases[]}
  citation_rules JSONB NOT NULL DEFAULT '{}',     -- {require_citation, max_citations}
  manual_directives TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by TEXT
);

-- Exactly one active policy at a time
CREATE UNIQUE INDEX idx_bot_chat_policies_one_active
  ON bot_chat_policies (status)
  WHERE status = 'active';

CREATE TABLE bot_chat_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_ref TEXT NOT NULL,                 -- Firestore doc ID, reference only (D6)
  turn_index INT NOT NULL,
  policy_version INT NOT NULL,
  classification TEXT CHECK (classification IN ('question', 'user_error', 'bug', 'feature_suggestion', 'escalation')),
  query_embedding vector(1536),                   -- pgvector enabled in migration 012
  cited_lesson_ids TEXT[] NOT NULL DEFAULT '{}',  -- Firestore lesson doc IDs
  page_slug TEXT,
  workspace_id TEXT,                              -- team ID — distinct-workspace struggle counts (D1)
  answered BOOLEAN,
  confidence NUMERIC,
  event_type TEXT NOT NULL CHECK (event_type IN ('turn', 'content_gap', 'escalated', 'action_proposed', 'action_confirmed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bot_obs_slug ON bot_chat_observations (page_slug);
CREATE INDEX idx_bot_obs_workspace ON bot_chat_observations (workspace_id);
CREATE INDEX idx_bot_obs_created ON bot_chat_observations (created_at);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

INSERT INTO app_settings (key, value) VALUES
  ('pm_slack_user_id', ''),                       -- set via /settings UI (CTO acting PM today)
  ('marketing_slack_user_id', 'UJSASV0L9'),       -- Tyler
  ('uiux_notification_channel', '');

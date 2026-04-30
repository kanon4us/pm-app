-- supabase/migrations/010_slack_issues.sql
CREATE TYPE slack_issue_status AS ENUM (
  'gathering',
  'confirming',
  'triaging',
  'complete',
  'human_takeover'
);

CREATE TABLE slack_issues (
  thread_ts        TEXT PRIMARY KEY,
  channel_id       TEXT NOT NULL,
  reporter_id      TEXT NOT NULL,
  status           slack_issue_status NOT NULL DEFAULT 'gathering',
  ticket_data      JSONB NOT NULL DEFAULT '{}',
  metadata         JSONB NOT NULL DEFAULT '{}',
  human_takeover   BOOLEAN NOT NULL DEFAULT FALSE,
  clickup_task_id  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_msg_ts      TEXT
);

CREATE INDEX idx_slack_issues_status     ON slack_issues(status);
CREATE INDEX idx_slack_issues_updated_at ON slack_issues(updated_at);

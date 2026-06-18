-- 027_vault_review_sessions.sql
-- Ephemeral interaction routing for weekly vault consolidation. Durable document
-- state lives in vault frontmatter; this table is disposable plumbing, cleared per cycle.
create table if not exists vault_review_sessions (
  id uuid primary key default gen_random_uuid(),
  run_id text not null,                 -- weekly run identifier (e.g. 2026-W25)
  doc_path text not null,
  author_email text not null,
  author_slack_id text,
  branch text not null,                 -- vault-consolidation/<isoweek>
  base_blob_sha text not null,          -- optimistic-lock baseline
  question_id text not null,
  status text not null default 'open',  -- open | answered | aborted
  slack_channel text,
  slack_message_ts text,
  created_at timestamptz not null default now()
);
create index if not exists idx_vault_review_sessions_run on vault_review_sessions(run_id);
create index if not exists idx_vault_review_sessions_author on vault_review_sessions(run_id, author_email);

create table if not exists vault_review_runs (
  run_id text primary key,              -- 2026-W25
  started_at timestamptz not null default now(),
  snapshot_ref text,                    -- KV/Blob key for the run snapshot
  pr_url text,                          -- set when the consolidated PR opens
  author_done jsonb not null default '{}'::jsonb  -- { "<email>": true }
);

create table if not exists vault_run_snapshots (
  run_id text primary key,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

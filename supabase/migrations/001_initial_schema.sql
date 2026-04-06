-- NOTE: Apply this migration manually via the Supabase dashboard SQL editor.
-- Do NOT run this file locally with the Supabase CLI unless a local stack is configured.

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  clickup_workspace_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- oauth_tokens
CREATE TABLE oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('clickup', 'figma', 'webflow', 'github')),
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  scopes TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

-- lists
CREATE TABLE lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clickup_list_id TEXT NOT NULL,
  name TEXT NOT NULL,
  webhook_id TEXT,
  synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, clickup_list_id)
);

-- sprints
CREATE TABLE sprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clickup_sprint_id TEXT,
  name TEXT NOT NULL,
  start_date DATE,
  end_date DATE,
  cost_budget FLOAT NOT NULL DEFAULT 50,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- tasks
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clickup_task_id TEXT UNIQUE NOT NULL,
  list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  sprint_id UUID REFERENCES sprints(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  custom_fields JSONB NOT NULL DEFAULT '{}',
  fvi_score FLOAT,
  cost_effort FLOAT,
  cost_risk FLOAT,
  inverted_influence FLOAT,
  git_branch TEXT,
  is_feature_flagged BOOLEAN NOT NULL DEFAULT FALSE,
  synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- trigger_configs
CREATE TABLE trigger_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  pm_agent_action TEXT NOT NULL,
  write_back_order TEXT[] NOT NULL DEFAULT ARRAY['clickup', 'docs', 'webflow', 'figma'],
  write_back_config JSONB NOT NULL DEFAULT '{}',
  on_failure TEXT NOT NULL DEFAULT 'continue' CHECK (on_failure IN ('continue', 'stop')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- trigger_queue
CREATE TABLE trigger_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  config_id UUID NOT NULL REFERENCES trigger_configs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'dismissed', 'running', 'done', 'failed')),
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  agent_output JSONB,
  error_details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- objective_assessments
CREATE TABLE objective_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  objective_id INT NOT NULL CHECK (objective_id BETWEEN 1 AND 7),
  score INT NOT NULL CHECK (score BETWEEN -5 AND 5),
  reasoning TEXT,
  assessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(task_id, objective_id)
);

-- skills_library
CREATE TABLE skills_library (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_slug TEXT UNIQUE NOT NULL,
  skill_path TEXT NOT NULL,
  content_snapshot TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- repo_registry
CREATE TABLE repo_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_name TEXT UNIQUE NOT NULL,
  domain TEXT[] NOT NULL DEFAULT '{}',
  readme_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- sync_logs
CREATE TABLE sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration TEXT NOT NULL CHECK (integration IN ('webflow', 'figma', 'github', 'clickup')),
  entity_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  details JSONB,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Realtime on trigger_queue
ALTER PUBLICATION supabase_realtime ADD TABLE trigger_queue;

-- Indexes
CREATE INDEX idx_trigger_queue_status ON trigger_queue(status);
CREATE INDEX idx_tasks_list_id ON tasks(list_id);
CREATE INDEX idx_trigger_configs_list_id ON trigger_configs(list_id);
CREATE INDEX idx_oauth_tokens_user_provider ON oauth_tokens(user_id, provider);

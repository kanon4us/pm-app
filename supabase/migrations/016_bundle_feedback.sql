-- supabase/migrations/016_bundle_feedback.sql

CREATE TABLE bundle_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sprint_id UUID REFERENCES sprints(id) ON DELETE SET NULL,
  bundle_version INT NOT NULL,
  developer_email TEXT NOT NULL,
  kickoff_prompt_rating INT NOT NULL CHECK (kickoff_prompt_rating BETWEEN 1 AND 5),
  user_stories_rating INT NOT NULL CHECK (user_stories_rating BETWEEN 1 AND 5),
  dev_skill_rating INT NOT NULL CHECK (dev_skill_rating BETWEEN 1 AND 5),
  comments TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(task_id, developer_email)
);

CREATE INDEX idx_bundle_feedback_sprint ON bundle_feedback(sprint_id);
CREATE INDEX idx_bundle_feedback_bundle_version ON bundle_feedback(bundle_version);

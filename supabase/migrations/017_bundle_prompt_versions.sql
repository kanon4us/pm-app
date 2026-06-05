-- supabase/migrations/017_bundle_prompt_versions.sql

CREATE TABLE bundle_prompt_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INT NOT NULL UNIQUE,
  prompt_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  proposed_prompt_text TEXT,
  change_summary TEXT,
  activated_at TIMESTAMPTZ,
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enforce single active version at the DB level
CREATE UNIQUE INDEX idx_bundle_prompt_versions_single_active
  ON bundle_prompt_versions(status)
  WHERE status = 'active';

-- Stamp bundle generations with the prompt version that produced them
ALTER TABLE bundle_generations
  ADD COLUMN IF NOT EXISTS prompt_version INT;

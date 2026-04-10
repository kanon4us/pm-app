-- 003_vidf_experiments.sql
-- VIDF Phase 0: developer experiment assignments and bundle version registry

-- developer_experiments: maps each developer (by git email) to their current VIDF experiment
CREATE TABLE developer_experiments (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  github_email  TEXT        NOT NULL UNIQUE,
  github_username TEXT,
  vidf_tag      TEXT        NOT NULL DEFAULT 'pre',
  bundle_version TEXT       NOT NULL DEFAULT 'v0',
  sop_version   TEXT        NOT NULL DEFAULT 'v0',
  sprint        TEXT        NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- bundle_versions: registry of bundle structure iterations being tested
CREATE TABLE bundle_versions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  version       TEXT        NOT NULL UNIQUE,
  description   TEXT        NOT NULL,
  files         JSONB       NOT NULL DEFAULT '[]',
  claude_context TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  activated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deactivated_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed: pre-VIDF baseline bundle version
INSERT INTO bundle_versions (version, description, files, is_active)
VALUES (
  'v0',
  'Pre-VIDF baseline — no resource bundle generated. Establishes commit quality before any workflow changes.',
  '[]',
  true
);

-- Indexes
CREATE INDEX idx_developer_experiments_email ON developer_experiments(github_email);
CREATE INDEX idx_bundle_versions_active      ON bundle_versions(is_active);

-- Auto-update updated_at on developer_experiments
CREATE OR REPLACE FUNCTION update_developer_experiments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_developer_experiments_updated_at
  BEFORE UPDATE ON developer_experiments
  FOR EACH ROW EXECUTE FUNCTION update_developer_experiments_updated_at();

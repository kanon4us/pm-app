-- 011_feature_prototype_builder.sql

-- Core feature entity
CREATE TABLE IF NOT EXISTS features (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- M:M features ↔ tasks
CREATE TABLE IF NOT EXISTS feature_tasks (
  feature_id UUID NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (feature_id, task_id)
);

-- Standalone user stories (reusable across features)
CREATE TABLE IF NOT EXISTS user_stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  as_a TEXT NOT NULL,
  i_want TEXT NOT NULL,
  so_that TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- M:M features ↔ user_stories with ordering
CREATE TABLE IF NOT EXISTS feature_user_stories (
  feature_id UUID NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  user_story_id UUID NOT NULL REFERENCES user_stories(id) ON DELETE CASCADE,
  display_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (feature_id, user_story_id)
);

-- Scenarios owned by a user story
CREATE TABLE IF NOT EXISTS scenarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_story_id UUID NOT NULL REFERENCES user_stories(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  display_order INT NOT NULL DEFAULT 0
);

-- Steps within a scenario (each maps to one Figma screen)
CREATE TABLE IF NOT EXISTS steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  figma_url TEXT,
  figma_frame_id TEXT,
  figma_thumbnail_url TEXT,
  display_order INT NOT NULL DEFAULT 0
);

-- Generated HTML prototypes
CREATE TABLE IF NOT EXISTS feature_prototypes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id UUID NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  scenario_id UUID REFERENCES scenarios(id) ON DELETE SET NULL,
  is_current BOOLEAN NOT NULL DEFAULT true,
  html_content TEXT NOT NULL,
  vault_path TEXT,
  vault_url TEXT,
  generated_by TEXT NOT NULL, -- email of the user who triggered generation
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One conversation per feature (unique constraint)
CREATE TABLE IF NOT EXISTS feature_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id UUID NOT NULL UNIQUE REFERENCES features(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','complete')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Messages within a feature conversation
CREATE TABLE IF NOT EXISTS feature_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES feature_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('assistant','user')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_feature_tasks_feature_id ON feature_tasks(feature_id);
CREATE INDEX IF NOT EXISTS idx_feature_tasks_task_id ON feature_tasks(task_id);
CREATE INDEX IF NOT EXISTS idx_feature_user_stories_feature_id ON feature_user_stories(feature_id);
CREATE INDEX IF NOT EXISTS idx_feature_user_stories_story_id ON feature_user_stories(user_story_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_user_story_id ON scenarios(user_story_id);
CREATE INDEX IF NOT EXISTS idx_steps_scenario_id ON steps(scenario_id);
CREATE INDEX IF NOT EXISTS idx_feature_prototypes_feature_id ON feature_prototypes(feature_id);
CREATE INDEX IF NOT EXISTS idx_feature_messages_conversation_id ON feature_messages(conversation_id);

-- Partial unique index for current prototype per feature+scenario
CREATE UNIQUE INDEX IF NOT EXISTS uniq_current_prototype
  ON feature_prototypes(feature_id, scenario_id)
  WHERE is_current = true;

-- Partial unique index for current feature-level prototype (no scenario)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_current_full_feature_prototype
  ON feature_prototypes(feature_id)
  WHERE is_current = true AND scenario_id IS NULL;

-- Supabase Storage bucket for permanent Figma images
INSERT INTO storage.buckets (id, name, public)
VALUES ('prototype-assets', 'prototype-assets', true)
ON CONFLICT (id) DO NOTHING;

-- Allow public reads on prototype-assets
DROP POLICY IF EXISTS "prototype-assets public read" ON storage.objects;
CREATE POLICY "prototype-assets public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'prototype-assets');

-- Allow authenticated users to upload to steps/ path
DROP POLICY IF EXISTS "prototype-assets auth upload" ON storage.objects;
CREATE POLICY "prototype-assets auth upload"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'prototype-assets'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = 'steps'
  );

-- 026_workflow_user_stories_relationships.sql

-- Many-to-many workflow relationships
CREATE TABLE IF NOT EXISTS workflow_relationships (
  workflow_id UUID NOT NULL REFERENCES workflows_registry(id) ON DELETE CASCADE,
  related_workflow_id UUID NOT NULL REFERENCES workflows_registry(id) ON DELETE CASCADE,
  relationship_type TEXT DEFAULT 'related' CHECK (relationship_type IN ('related', 'depends_on', 'enables')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workflow_id, related_workflow_id),
  CHECK (workflow_id != related_workflow_id)
);

-- User stories for workflows (following feature pattern from migration 011)
CREATE TABLE IF NOT EXISTS workflow_user_stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES workflows_registry(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  as_a TEXT NOT NULL,
  i_want TEXT NOT NULL,
  so_that TEXT NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prototype variants for each user story
CREATE TABLE IF NOT EXISTS workflow_story_prototypes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_story_id UUID NOT NULL REFERENCES workflow_user_stories(id) ON DELETE CASCADE,
  variant_name TEXT NOT NULL,
  figma_url TEXT,
  figma_frame_id TEXT,
  figma_thumbnail_url TEXT,
  description TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_workflow_relationships_workflow ON workflow_relationships(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_relationships_related ON workflow_relationships(related_workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_user_stories_workflow ON workflow_user_stories(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_user_stories_order ON workflow_user_stories(workflow_id, display_order);
CREATE INDEX IF NOT EXISTS idx_workflow_story_prototypes_story ON workflow_story_prototypes(user_story_id);

-- Ensure only one primary prototype per user story
CREATE UNIQUE INDEX IF NOT EXISTS uniq_primary_prototype_per_story
  ON workflow_story_prototypes(user_story_id)
  WHERE is_primary = true;

-- Add updated_at triggers
CREATE TRIGGER workflow_user_stories_updated_at
BEFORE UPDATE ON workflow_user_stories
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER workflow_story_prototypes_updated_at
BEFORE UPDATE ON workflow_story_prototypes
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RPC function for atomic user story + prototype creation
CREATE OR REPLACE FUNCTION create_user_story_with_prototype(
  p_workflow_id UUID,
  p_title TEXT,
  p_as_a TEXT,
  p_i_want TEXT,
  p_so_that TEXT,
  p_figma_url TEXT
) RETURNS UUID AS $$
DECLARE
  v_story_id UUID;
BEGIN
  -- Insert user story with auto-incrementing display_order
  INSERT INTO workflow_user_stories (
    workflow_id, title, as_a, i_want, so_that, display_order
  )
  VALUES (
    p_workflow_id, p_title, p_as_a, p_i_want, p_so_that,
    COALESCE((SELECT MAX(display_order) + 1 FROM workflow_user_stories WHERE workflow_id = p_workflow_id), 0)
  )
  RETURNING id INTO v_story_id;

  -- Insert primary prototype if Figma URL provided (atomic with story)
  IF p_figma_url IS NOT NULL AND p_figma_url != '' THEN
    INSERT INTO workflow_story_prototypes (
      user_story_id, variant_name, figma_url, is_primary
    )
    VALUES (
      v_story_id, 'Primary', p_figma_url, true
    );
  END IF;

  RETURN v_story_id;
END;
$$ LANGUAGE plpgsql;
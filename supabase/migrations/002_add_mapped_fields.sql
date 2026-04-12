-- Add mapped_fields column to store custom field DB mappings (obj scores, figma link, etc.)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS mapped_fields JSONB NOT NULL DEFAULT '{}';

-- supabase/migrations/014_trigger_configs_list_routing.sql
-- NOTE: This migration must be applied manually via the Supabase dashboard.
-- Automatic application is not supported in this environment.

ALTER TABLE trigger_configs
  ADD COLUMN IF NOT EXISTS destination_list_id UUID REFERENCES lists(id);

ALTER TABLE trigger_configs
  ALTER COLUMN to_status DROP NOT NULL;

-- Unique: each destination list has at most one list-based trigger config
CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_configs_destination_list_unique
  ON trigger_configs(destination_list_id)
  WHERE destination_list_id IS NOT NULL;

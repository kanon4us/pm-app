-- 037_feature_figma_publish.sql
-- Spec #2: PM-curated reuse references + the published Figma file linkage.
-- Additive; manual prod apply per convention (BEFORE deploying code that reads them).
alter table features add column if not exists reuse_refs     jsonb;   -- { refs: [{ kind, value, note }] }
alter table features add column if not exists figma_file_key text;    -- set by the plugin after publish (Spec #3 read-back)

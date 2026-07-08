-- 036_feature_ux_architecture.sql
-- Structured objectives (Module A) and the Gemini UX-architect stitch (Module B).
-- Additive: the legacy `objectives text` column is retained as a read-only fallback.
alter table features add column if not exists objectives_json jsonb;
alter table features add column if not exists ux_stitch       jsonb;

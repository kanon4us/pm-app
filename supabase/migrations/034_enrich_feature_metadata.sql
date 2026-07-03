-- ClickUp gatekeeper enrichment: when a task is flagged Ready-for-Prototype,
-- the webhook enriches the scaffolded feature with deep ClickUp metadata so
-- planning starts pre-briefed (injected via buildFeatureContext).
alter table features
  add column if not exists fvi_score double precision,
  add column if not exists objectives text,
  add column if not exists clickup_details text;

comment on column features.fvi_score
  is 'Feature Value Impact at activation time — ClickUp FVI custom field, falling back to tasks.fvi_score (assessment pipeline). Snapshot, not live.';

comment on column features.objectives
  is 'Goals extracted from the ClickUp task (Objectives custom field, else an Objectives section in the description).';

comment on column features.clickup_details
  is 'Full ClickUp task description (markdown) captured at gatekeeper activation.';

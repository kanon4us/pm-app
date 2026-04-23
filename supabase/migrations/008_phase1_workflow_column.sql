-- supabase/migrations/008_phase1_workflow_column.sql
alter table assessment_conversations
  add column if not exists affected_workflows jsonb;

comment on column assessment_conversations.affected_workflows
  is 'Phase 1 workflow audit: [{name,sopImpacted,educationImpacted,scribehowImpacted,registryStatus}]';

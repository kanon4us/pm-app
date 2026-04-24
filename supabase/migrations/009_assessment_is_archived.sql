-- supabase/migrations/009_assessment_is_archived.sql
alter table assessment_conversations
  add column if not exists is_archived boolean not null default false;

comment on column assessment_conversations.is_archived
  is 'When true, this run is hidden from the default history view. Set by PM via the drawer UI.';

create index if not exists idx_assessment_conversations_history
  on assessment_conversations(task_id, created_at desc);

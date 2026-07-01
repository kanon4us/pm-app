-- supabase/migrations/030_design_index_inbox.sql
create table if not exists design_index_inbox (
  id              uuid primary key default gen_random_uuid(),
  clickup_task_id text not null unique,
  title           text not null,
  figma_url       text,
  trigger_status  text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  processed_at    timestamptz,
  last_error      text
);

create index if not exists design_index_inbox_unprocessed
  on design_index_inbox (created_at) where processed_at is null;

alter table design_index_inbox enable row level security;
-- No policies: service-role only (webhook + cron use the Supabase service client).

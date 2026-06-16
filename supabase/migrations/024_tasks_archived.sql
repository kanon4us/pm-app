-- Add is_archived column to track archived tasks from ClickUp
-- Tasks are marked archived when they're missing from ClickUp API response
alter table tasks
  add column if not exists is_archived boolean not null default false;

comment on column tasks.is_archived
  is 'True when task is archived in ClickUp. Set by sync process when task is not returned by API.';

-- Index for filtering archived tasks in sprint queries
create index if not exists idx_tasks_archive_status
  on tasks(is_archived, sprint_id);

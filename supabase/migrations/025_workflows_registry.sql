-- Create workflows_registry table
create table workflows_registry (
  id uuid default gen_random_uuid() primary key,
  name text not null unique,
  description text,
  sop_impacted boolean default false,
  education_impacted boolean default false,
  scribehow_impacted boolean default false,
  is_deprecated boolean default false,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- Create indexes
create index idx_workflows_registry_name on workflows_registry(name);
create index idx_workflows_registry_deprecated on workflows_registry(is_deprecated);

-- Create junction table for assessments
create table assessment_workflows (
  id uuid default gen_random_uuid() primary key,
  assessment_id uuid not null references assessment_conversations(id) on delete cascade,
  workflow_id uuid not null references workflows_registry(id) on delete restrict,
  created_at timestamp with time zone default now(),
  unique(assessment_id, workflow_id)
);

-- Create indexes on junction table
create index idx_assessment_workflows_assessment on assessment_workflows(assessment_id);
create index idx_assessment_workflows_workflow on assessment_workflows(workflow_id);

-- Extract existing workflows from JSONB
insert into workflows_registry (name, sop_impacted, education_impacted, scribehow_impacted)
select distinct
  workflow->>'name' as name,
  coalesce((workflow->>'sopImpacted')::boolean, false) as sop_impacted,
  coalesce((workflow->>'educationImpacted')::boolean, false) as education_impacted,
  coalesce((workflow->>'scribehowImpacted')::boolean, false) as scribehow_impacted
from assessment_conversations ac
cross join lateral jsonb_array_elements(affected_workflows) as workflow
where ac.affected_workflows is not null
  and workflow->>'name' is not null
on conflict (name) do nothing;

-- Link existing assessments to workflows
insert into assessment_workflows (assessment_id, workflow_id)
select distinct
  ac.id as assessment_id,
  wr.id as workflow_id
from assessment_conversations ac
cross join lateral jsonb_array_elements(affected_workflows) as workflow
join workflows_registry wr on wr.name = workflow->>'name'
where ac.affected_workflows is not null;

-- Add updated_at trigger
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger workflows_registry_updated_at
before update on workflows_registry
for each row execute function update_updated_at();

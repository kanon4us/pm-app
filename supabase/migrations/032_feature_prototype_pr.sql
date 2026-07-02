-- Prototyping phase: agentic code reading + PR handoff into the product repo (CODE_REPO).
-- code_paths seeds Claude's exploration; prototype_branch/prototype_pr_url track the
-- server-computed branch and its PR in Viscap-Media/app.viscap.ai (base develop, no auto-merge).
alter table features
  add column if not exists code_paths text[] not null default '{}',
  add column if not exists prototype_branch text,
  add column if not exists prototype_pr_url text;

comment on column features.code_paths
  is 'Suggested starting directories in the product repo (e.g. components/Admin/Creatives). Injected into the prototyping prompt as hints, not limits.';

comment on column features.prototype_branch
  is 'Server-computed branch in CODE_REPO (feature/uiux-<clickup_task_id>), force-updated on each prototype revision.';

comment on column features.prototype_pr_url
  is 'Open PR against develop in CODE_REPO. Vercel posts the preview link on this PR.';

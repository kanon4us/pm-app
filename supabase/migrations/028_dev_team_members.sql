-- Dev team registry: single source of truth for "who is a dev" and the
-- Slack-user -> ClickUp-user (email) mapping used to assign ClickUp tasks.
-- Replaces the hardcoded DEV_TEAM_IDS set in lib/issue-triage/dev-team.ts
-- (which remains as a fallback seed if this table is empty/unavailable).
create table dev_team_members (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  slack_id text not null unique,
  clickup_email text,
  active boolean not null default true,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create index idx_dev_team_members_slack_id on dev_team_members(slack_id);
create index idx_dev_team_members_active on dev_team_members(active);

insert into dev_team_members (name, slack_id, clickup_email) values
  ('Cameron Almazan', 'U03MK0SEPH9', 'cameron@viscapmedia.com'),
  ('Ilya Mikhalev',   'U047E6PJ5B9', 'ilia@viscapmedia.com'),
  ('Michael Katskyi', 'U06RWVCH924', 'michael-k@viscapmedia.com'),
  ('Zaeem Asif',      'U07501EJ2SK', 'zaeem@viscapmedia.com'),
  ('Jahanara Ali',    'U081QGB6ZC1', 'ali@viscapmedia.com'),
  ('Michael Simpson', 'U025022DJ9H', 'simpson@viscapmedia.com'),
  ('Chad Terry',      'U020PGH3RFW', 'chad@viscapmedia.com'),
  ('Artem',           'U09SPSFBBQE', 'artem@viscapmedia.com');

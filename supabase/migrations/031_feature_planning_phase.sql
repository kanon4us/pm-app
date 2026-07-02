-- Planning phase + spec artifact for the Superpowers planning loop in the Feature Editor.
-- Claude drafts the spec via the write_spec tool; the PM approving it flips planning_phase,
-- which gates the (future) prototyping phase.
alter table features
  add column if not exists planning_phase text not null default 'planning'
    check (planning_phase in ('planning', 'approved', 'prototyping')),
  add column if not exists spec_content text;

comment on column features.planning_phase
  is 'planning = brainstorming with Claude; approved = PM approved the spec; prototyping = prototype PR in flight.';

comment on column features.spec_content
  is 'Markdown spec drafted by Claude (write_spec tool). Approval is the gate, so drafts are freely overwritten.';

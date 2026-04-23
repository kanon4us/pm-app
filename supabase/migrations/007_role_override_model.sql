alter table conversation_role_assessments
  add column if not exists claude_proposed_frequency integer
    check (claude_proposed_frequency between 0 and 4),
  add column if not exists user_override_frequency integer
    check (user_override_frequency between 0 and 4),
  add column if not exists claude_reasoning text,
  add column if not exists user_reasoning text;

comment on column conversation_role_assessments.claude_proposed_frequency
  is 'Frequency Claude proposed (0=Cannot Access). 0 for roles Claude did not select.';
comment on column conversation_role_assessments.user_override_frequency
  is 'Frequency the user chose when overriding Claude. Null if user accepted Claude proposal.';
comment on column conversation_role_assessments.claude_reasoning
  is 'Claude reasoning for the proposed frequency. Null for roles Claude scored 0.';
comment on column conversation_role_assessments.user_reasoning
  is 'Required when user_override_frequency is set. Explains why the user corrected Claude.';

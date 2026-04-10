-- NOTE: Apply via Supabase dashboard SQL editor.
-- Safe to re-run — uses IF NOT EXISTS and ON CONFLICT DO NOTHING.

-- Objectives registry — editable without code changes
CREATE TABLE IF NOT EXISTS objectives_registry (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  objective_id  INT  NOT NULL UNIQUE CHECK (objective_id BETWEEN 1 AND 7),
  name          TEXT NOT NULL,
  owner_name    TEXT NOT NULL,
  mandate       TEXT NOT NULL,
  score_matrix  JSONB NOT NULL DEFAULT '{}',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Role registry — mirrors FVI-Rubric.md
CREATE TABLE IF NOT EXISTS role_registry (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_name       TEXT NOT NULL,
  team_domain     TEXT NOT NULL CHECK (team_domain IN ('agency', 'brand')),
  influence_type  TEXT NOT NULL CHECK (influence_type IN ('DM', 'NDM')),
  weight          INT  NOT NULL CHECK (weight BETWEEN 1 AND 10),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

-- Assessment conversations (persisted, re-assessment aware)
CREATE TABLE IF NOT EXISTS assessment_conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'in_progress'
                  CHECK (status IN ('in_progress', 'complete', 'abandoned')),
  vault_context   JSONB,
  proposed_scores JSONB,
  final_scores    JSONB,
  effort          FLOAT,
  risk            FLOAT,
  fvi_score       FLOAT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

-- Assessment messages — the interview turns
CREATE TABLE IF NOT EXISTS assessment_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID NOT NULL REFERENCES assessment_conversations(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('assistant', 'user')),
  content           TEXT NOT NULL,
  objective_id      INT,
  proposed_score    INT,
  vault_evidence    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Role selections per conversation
CREATE TABLE IF NOT EXISTS conversation_role_assessments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID NOT NULL REFERENCES assessment_conversations(id) ON DELETE CASCADE,
  role_id           UUID NOT NULL REFERENCES role_registry(id),
  usage_frequency   INT NOT NULL CHECK (usage_frequency BETWEEN 1 AND 4),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assessment_conversations_task ON assessment_conversations(task_id);
CREATE INDEX IF NOT EXISTS idx_assessment_messages_conv ON assessment_messages(conversation_id);

-- ── Seed objectives_registry ──────────────────────────────────────────────────

INSERT INTO objectives_registry (objective_id, name, owner_name, mandate, score_matrix) VALUES
(1, 'Data-Backed Decisions', 'Architect of Truth',
 'Every user action must leave a structured data trail usable for decisions.',
 '{"5":"Source of Truth — fundamentally improves data foundation","3":"Strong Signal — adds valuable structured data","1":"Data Hygiene — prevents future data loss","0":"Neutral — no data impact","-1":"Data Friction — introduces minor ambiguity","-3":"Data Debt — breaks attribution or creates inconsistencies","-5":"Truth Breaker — undermines system credibility"}'
),
(2, 'Modular Content Creation', 'The Invisible Hand',
 'The system handles complexity invisibly; users create naturally.',
 '{"5":"Full Automation — eliminates entire user-facing steps while increasing capability","3":"Workflow Acceleration — user does less, system does more","1":"Friction Reduction — removes minor constraints","0":"Neutral — no workflow impact","-1":"Additional Steps — exposes minor modular concepts","-3":"Workflow Rigidity — makes system more opinionated","-5":"Modular Disaster — users must learn internal structure"}'
),
(3, 'User Success', 'The User''s Advocate',
 'Move users from confused to successful in the shortest path possible.',
 '{"5":"Workflow Revolution — transforms how users work","3":"Significant Enhancement — noticeably better experience","1":"Incremental Improvement — small step forward","0":"Neutral — no user success impact","-1":"Minor Friction — slight step backward","-3":"Workflow Regression — meaningfully harder to succeed","-5":"Critical Damage — severely undermines user success"}'
),
(4, 'Optimized Onboarding', 'The First Impressionist',
 'Every user type finds value within their first 5 minutes.',
 '{"5":"It Just Works — dramatically improves first creative quality and speed","3":"Clarity and Momentum — removes key confusion point","1":"Improvement / Polish — prevents future friction","0":"Neutral — does not affect onboarding","-1":"Minor Friction — adds small effort to first session","-3":"Activation Drag — actively slows reaching first value","-5":"Trust Broken — undermines confidence, users may drop off"}'
),
(5, 'Third-Party Integrations', 'The Ecosystem Builder',
 'Buy proven tools; build only what differentiates Viscap.',
 '{"5":"Leverage Breakthrough — multiplies product power, native and frictionless","3":"Strategic Extension — meaningfully expands capabilities","1":"Tactical Connector — useful but narrow","0":"Neutral — no ecosystem impact","-1":"Integration Drag — adds friction or overhead","-3":"Leverage Debt — costs more than it saves","-5":"Integration Rot — actively harms platform"}'
),
(6, 'Quality Control', 'The Standard Bearer',
 'Nothing ships that can break the business silently.',
 '{"5":"Reliability Foundation — raises quality bar for everything","3":"Quality Multiplier — noticeably safer to build and ship","1":"Preventive Guardrail — keeps us out of trouble","0":"Quality Neutral — no impact on stability","-1":"Risk Introduction — manageable but real risk","-3":"Stability Debt — makes future work harder and riskier","-5":"Stability Violation — should not ship"}'
),
(7, 'Planning & ROI', 'Chad Terry + Artem Pavlushko',
 'Every feature is strategic, scoped, and resourced before work begins.',
 '{"5":"Proven Profit — evidence-backed ROI and perfect clarity","3":"Strategic Bet — confident speculation aligned with long-term vision","1":"Roadmap Integrity — keeps team aligned, maintains momentum","0":"Neutral — negligible resources, no strategy impact","-1":"Opportunity Cost — better spent elsewhere","-3":"Ambiguity Trap — vague specs, undefined why","-5":"Dead End — creates tech debt, burns cash with no path to profit"}'
)
ON CONFLICT (objective_id) DO UPDATE SET
  name       = EXCLUDED.name,
  owner_name = EXCLUDED.owner_name,
  mandate    = EXCLUDED.mandate,
  score_matrix = EXCLUDED.score_matrix,
  updated_at = NOW();

-- ── Seed role_registry (mirrors FVI-Rubric.md) ───────────────────────────────
-- Truncate and re-insert to stay in sync with the rubric

TRUNCATE role_registry CASCADE;

INSERT INTO role_registry (role_name, team_domain, influence_type, weight) VALUES
('Admin',                'agency', 'DM',  10),
('Creative Strategist',  'agency', 'DM',  10),
('Account Manager',      'agency', 'DM',   8),
('Director',             'agency', 'DM',   9),
('Content Director',     'agency', 'DM',   7),
('Casting Director',     'agency', 'DM',   5),
('Editing Director',     'agency', 'DM',   6),
('Editing Coordinator',  'agency', 'NDM',  5),
('DIT',                  'agency', 'NDM',  4),
('Client Admin',         'agency', 'NDM',  3),
('Client Team',          'agency', 'NDM',  1),
('Copywriter',           'agency', 'NDM',  7),
('Editor',               'agency', 'NDM',  4),
('Videographer',         'agency', 'NDM',  2),
('Remote Talent',        'agency', 'NDM',  1),
('In House Talent',      'agency', 'NDM',  1),
('Sales',                'agency', 'NDM',  1),
('Brand Owner',          'brand',  'DM',  10),
('Internal Team CS',     'brand',  'DM',  10),
('Director',             'brand',  'DM',   9),
('Casting Director',     'brand',  'DM',   5),
('Editing Director',     'brand',  'DM',   6),
('Editing Coordinator',  'brand',  'NDM',  5),
('DIT',                  'brand',  'NDM',  4),
('Collaborating Admin',  'brand',  'NDM',  3),
('Copywriter',           'brand',  'NDM',  7),
('Editor',               'brand',  'NDM',  4),
('Videographer',         'brand',  'NDM',  2),
('Remote Talent',        'brand',  'NDM',  1),
('In House Talent',      'brand',  'NDM',  1);

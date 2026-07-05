-- 035: unique constraint required by the confirm route's role upsert.
-- app/api/sprint/tasks/[id]/assess/[conversationId]/confirm/route.ts upserts
-- conversation_role_assessments with onConflict (conversation_id, role_id),
-- but 002 created the table without any unique constraint — Postgres rejects
-- the statement with 42P10 and every "Compute FVI & Save" fails.

-- Deduplicate first (keep the newest row per conversation/role pair) so the
-- constraint can be added even if plain inserts ever landed duplicates.
DELETE FROM conversation_role_assessments a
USING conversation_role_assessments b
WHERE a.conversation_id = b.conversation_id
  AND a.role_id = b.role_id
  AND (a.created_at < b.created_at
       OR (a.created_at = b.created_at AND a.id < b.id));

ALTER TABLE conversation_role_assessments
  ADD CONSTRAINT conversation_role_assessments_conv_role_key
  UNIQUE (conversation_id, role_id);

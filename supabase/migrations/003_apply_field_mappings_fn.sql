-- apply_field_mappings(mappings jsonb)
-- Applies custom field → DB column mappings across all tasks in a single SQL pass.
-- mappings format: { "ClickUp Field Name": "db_field_key", ... }
-- Returns the number of tasks updated.

CREATE OR REPLACE FUNCTION apply_field_mappings(mappings jsonb)
RETURNS int AS $$
DECLARE
  field_name text;
  db_field   text;
BEGIN
  FOR field_name, db_field IN
    SELECT key, value #>> '{}' FROM jsonb_each(mappings)
  LOOP
    CASE db_field
      -- Direct numeric task columns
      WHEN 'fvi_score', 'cost_effort', 'cost_risk', 'inverted_influence' THEN
        EXECUTE format(
          'UPDATE tasks
           SET %I = (
             SELECT CASE
               WHEN (elem->>''value'') ~ ''^-?[0-9]+(\.[0-9]+)?$''
               THEN (elem->>''value'')::float
               ELSE NULL
             END
             FROM jsonb_array_elements(COALESCE(custom_fields, ''[]''::jsonb)) AS elem
             WHERE elem->>''name'' = $1
             LIMIT 1
           )
           WHERE TRUE',
          db_field
        ) USING field_name;

      -- Numeric values stored in mapped_fields JSONB
      WHEN 'decision_maker_score', 'nondecision_maker_score',
           'obj_1_score', 'obj_2_score', 'obj_3_score', 'obj_4_score',
           'obj_5_score', 'obj_6_score', 'obj_7_score' THEN
        UPDATE tasks
        SET mapped_fields = jsonb_set(
          COALESCE(mapped_fields, '{}'),
          ARRAY[db_field],
          COALESCE(
            to_jsonb(
              (SELECT CASE
                 WHEN (elem->>'value') ~ '^-?[0-9]+(\.[0-9]+)?$'
                 THEN (elem->>'value')::float
                 ELSE NULL
               END
               FROM jsonb_array_elements(COALESCE(custom_fields, '[]'::jsonb)) AS elem
               WHERE elem->>'name' = field_name
               LIMIT 1)
            ),
            'null'::jsonb
          )
        )
        WHERE TRUE;

      -- Text values stored in mapped_fields JSONB
      WHEN 'figma_link',
           'obj_1_desc', 'obj_2_desc', 'obj_3_desc', 'obj_4_desc',
           'obj_5_desc', 'obj_6_desc', 'obj_7_desc' THEN
        UPDATE tasks
        SET mapped_fields = jsonb_set(
          COALESCE(mapped_fields, '{}'),
          ARRAY[db_field],
          COALESCE(
            to_jsonb(
              (SELECT elem->>'value'
               FROM jsonb_array_elements(COALESCE(custom_fields, '[]'::jsonb)) AS elem
               WHERE elem->>'name' = field_name
               LIMIT 1)
            ),
            'null'::jsonb
          )
        )
        WHERE TRUE;

      ELSE
        -- Unknown db_field — skip silently
        NULL;
    END CASE;
  END LOOP;

  RETURN (SELECT COUNT(*)::int FROM tasks);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

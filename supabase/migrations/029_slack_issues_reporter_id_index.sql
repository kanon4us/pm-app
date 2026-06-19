-- 029_slack_issues_reporter_id_index.sql
-- Reporter ticket history looks up slack_issues by reporter_id. The table
-- previously indexed only status and updated_at (see 010_slack_issues.sql).
-- Non-breaking; apply to prod manually per repo convention.
CREATE INDEX IF NOT EXISTS idx_slack_issues_reporter_id
  ON slack_issues (reporter_id);

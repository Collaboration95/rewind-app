-- Rebuilt with foreign keys disabled by the migration runner, inside its
-- transaction. Only targets are nullable: reporter, reason and time survive.
CREATE TABLE member_reports_next (
  id TEXT PRIMARY KEY,
  reporter_account_id TEXT NOT NULL REFERENCES real_accounts(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
  reported_account_id TEXT REFERENCES real_accounts(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  created_at TEXT NOT NULL,
  CHECK (reporter_account_id <> reported_account_id),
  UNIQUE (reporter_account_id, group_id, reported_account_id)
);
INSERT INTO member_reports_next SELECT * FROM member_reports;
DROP TABLE member_reports;
ALTER TABLE member_reports_next RENAME TO member_reports;

CREATE TABLE content_reports_next (
  id TEXT PRIMARY KEY,
  reporter_account_id TEXT NOT NULL REFERENCES real_accounts(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  contribution_id TEXT REFERENCES contributions(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  created_at TEXT NOT NULL,
  -- After target deletion both may be null; both may never be non-null.
  CHECK (message_id IS NULL OR contribution_id IS NULL),
  UNIQUE (reporter_account_id, message_id),
  UNIQUE (reporter_account_id, contribution_id)
);
INSERT INTO content_reports_next SELECT * FROM content_reports;
DROP TABLE content_reports;
ALTER TABLE content_reports_next RENAME TO content_reports;

CREATE INDEX member_reports_created_idx ON member_reports (created_at);
CREATE INDEX member_reports_reported_account_idx ON member_reports (reported_account_id);
CREATE INDEX member_reports_group_idx ON member_reports (group_id);
CREATE INDEX content_reports_created_idx ON content_reports (created_at);
CREATE INDEX content_reports_message_idx ON content_reports (message_id);
CREATE INDEX content_reports_contribution_idx ON content_reports (contribution_id);
CREATE INDEX content_reports_group_idx ON content_reports (group_id);
CREATE INDEX account_blocks_blocked_account_idx ON account_blocks (blocked_account_id);
CREATE INDEX film_segments_contribution_idx ON film_segments (contribution_id);
CREATE INDEX contributions_removed_by_account_idx ON contributions (removed_by_account_id);

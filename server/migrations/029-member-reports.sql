-- Members can report a person in a shared group, and a group owner can remove
-- a moment. Removal is its own marker (not the author's deleted_at tombstone)
-- so it never touches the author's weekly allowance or correction; the row
-- keeps who removed it and when as the moderation record.
CREATE TABLE IF NOT EXISTS member_reports (
  id TEXT PRIMARY KEY,
  reporter_account_id TEXT NOT NULL REFERENCES real_accounts(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  reported_account_id TEXT NOT NULL REFERENCES real_accounts(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  created_at TEXT NOT NULL,
  CHECK (reporter_account_id <> reported_account_id),
  UNIQUE (reporter_account_id, group_id, reported_account_id)
);

CREATE INDEX IF NOT EXISTS member_reports_created_idx ON member_reports (created_at);

ALTER TABLE contributions ADD COLUMN removed_at TEXT;
ALTER TABLE contributions ADD COLUMN removed_by_account_id TEXT
  REFERENCES real_accounts(id) ON DELETE SET NULL;

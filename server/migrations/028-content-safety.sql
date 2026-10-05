-- Group members can report shared content and block other members
-- (App Store Guideline 1.2). Both are keyed to real accounts so deleting an
-- account removes its reports and blocks.
CREATE TABLE IF NOT EXISTS content_reports (
  id TEXT PRIMARY KEY,
  reporter_account_id TEXT NOT NULL REFERENCES real_accounts(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  contribution_id TEXT REFERENCES contributions(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  created_at TEXT NOT NULL,
  CHECK ((message_id IS NULL) <> (contribution_id IS NULL)),
  UNIQUE (reporter_account_id, message_id),
  UNIQUE (reporter_account_id, contribution_id)
);

CREATE INDEX IF NOT EXISTS content_reports_created_idx ON content_reports (created_at);

CREATE TABLE IF NOT EXISTS account_blocks (
  blocker_account_id TEXT NOT NULL REFERENCES real_accounts(id) ON DELETE CASCADE,
  blocked_account_id TEXT NOT NULL REFERENCES real_accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_account_id, blocked_account_id),
  CHECK (blocker_account_id <> blocked_account_id)
);

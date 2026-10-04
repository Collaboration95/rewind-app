CREATE TABLE IF NOT EXISTS real_group_invites (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES real_group_metadata(group_id) ON DELETE CASCADE,
  owner_account_id TEXT NOT NULL REFERENCES real_accounts(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS real_group_invites_group_created_idx
  ON real_group_invites (group_id, created_at);

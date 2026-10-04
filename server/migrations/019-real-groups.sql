-- Real identities, memberships and current-group choice stay separate from
-- synthetic Demo fixtures and their query-string session authority.
CREATE TABLE IF NOT EXISTS real_profiles (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE REFERENCES real_accounts(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (account_id, id)
);

CREATE TABLE IF NOT EXISTS real_group_metadata (
  group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  owner_account_id TEXT NOT NULL REFERENCES real_accounts(id),
  max_members INTEGER NOT NULL CHECK (max_members BETWEEN 2 AND 10),
  cycle_duration_ms INTEGER NOT NULL CHECK (cycle_duration_ms = 2419200000),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS real_group_memberships (
  group_id TEXT NOT NULL REFERENCES real_group_metadata(group_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (group_id, account_id),
  FOREIGN KEY (account_id, profile_id)
    REFERENCES real_profiles(account_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS real_account_group_selections (
  account_id TEXT PRIMARY KEY REFERENCES real_accounts(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  FOREIGN KEY (group_id, account_id)
    REFERENCES real_group_memberships(group_id, account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS real_group_memberships_account_idx
  ON real_group_memberships (account_id, accepted_at);

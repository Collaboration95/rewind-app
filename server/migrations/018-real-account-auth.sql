-- Real pilot identities deliberately live outside Demo profiles and sessions.
CREATE TABLE IF NOT EXISTS real_accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  normalized_username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_salt TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_scrypt_n INTEGER NOT NULL,
  password_scrypt_r INTEGER NOT NULL,
  password_scrypt_p INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS real_account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES real_accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS real_account_sessions_account_idx
  ON real_account_sessions (account_id, revoked_at);

CREATE TABLE IF NOT EXISTS auth_login_throttles (
  scope TEXT NOT NULL CHECK (scope IN ('account', 'source')),
  subject_hash TEXT NOT NULL,
  failures INTEGER NOT NULL CHECK (failures >= 0),
  window_started_at TEXT NOT NULL,
  cooldown_until TEXT,
  cooldown_level INTEGER NOT NULL DEFAULT 0 CHECK (cooldown_level >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, subject_hash)
);

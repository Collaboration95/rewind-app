-- Immutable private-upload intent identity and bounded cleanup state.
CREATE TABLE IF NOT EXISTS upload_intents (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES real_group_metadata(group_id),
  account_id TEXT NOT NULL REFERENCES real_accounts(id),
  profile_id TEXT NOT NULL REFERENCES real_profiles(id),
  cycle_id TEXT NOT NULL REFERENCES cycles(id),
  quota_window_start_at TEXT NOT NULL,
  idempotency_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  target_json TEXT NOT NULL,
  reserved_seconds REAL NOT NULL CHECK (reserved_seconds > 0 AND reserved_seconds <= 15),
  state TEXT NOT NULL CHECK (state IN ('open','pinned','completed','expired')),
  pinned_ref TEXT,
  contribution_id TEXT UNIQUE REFERENCES contributions(id),
  job_id TEXT UNIQUE REFERENCES media_jobs(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cleanup_cursor TEXT,
  cleanup_complete INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_complete IN (0,1)),
  UNIQUE (environment, group_id, profile_id, idempotency_hash),
  CHECK ((state = 'open' AND pinned_ref IS NULL)
      OR state = 'expired'
      OR (state IN ('pinned','completed') AND pinned_ref IS NOT NULL)),
  CHECK ((state = 'completed' AND contribution_id IS NOT NULL AND job_id IS NOT NULL)
      OR (state <> 'completed' AND contribution_id IS NULL AND job_id IS NULL))
);
CREATE INDEX IF NOT EXISTS upload_intents_expiry_idx ON upload_intents(environment, cleanup_complete, expires_at, id);
CREATE INDEX IF NOT EXISTS upload_intents_quota_idx ON upload_intents(cycle_id, profile_id, quota_window_start_at, state, expires_at);

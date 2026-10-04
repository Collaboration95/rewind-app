-- Private destinations belong to a registering real session. Never expose
-- destination_json or session_token_hash in application status responses.
CREATE TABLE IF NOT EXISTS reminder_destinations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES real_accounts(id) ON DELETE CASCADE,
  session_token_hash TEXT NOT NULL REFERENCES real_account_sessions(token_hash) ON DELETE CASCADE,
  device_key TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('expo','webpush')),
  destination_hash TEXT NOT NULL,
  destination_json TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id,device_key),
  UNIQUE(provider,destination_hash)
);
CREATE TABLE IF NOT EXISTS reminder_outbox (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  local_sunday TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  destination_id TEXT REFERENCES reminder_destinations(id) ON DELETE SET NULL,
  destination_generation INTEGER NOT NULL CHECK(destination_generation > 0),
  state TEXT NOT NULL CHECK(state IN ('pending','sending','retry','awaiting_receipt','accepted','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  receipt_attempts INTEGER NOT NULL DEFAULT 0 CHECK(receipt_attempts BETWEEN 0 AND 3),
  provider_receipt TEXT,
  response_category TEXT,
  next_attempt_at TEXT NOT NULL,
  lease_id TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(group_id,account_id,local_sunday),
  FOREIGN KEY(group_id,account_id) REFERENCES real_group_memberships(group_id,account_id) ON DELETE CASCADE,
  CHECK((lease_id IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS reminder_outbox_due_idx ON reminder_outbox(state,next_attempt_at,id);
CREATE INDEX IF NOT EXISTS reminder_destinations_account_idx ON reminder_destinations(account_id,enabled,updated_at);

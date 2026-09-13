-- Contribution allowance is durable state, scoped to a member and to a
-- seven-day window anchored at the cycle start. The hard limits are policy
-- limits; cycle metadata may only make an allowance smaller.
ALTER TABLE contributions ADD COLUMN quota_window_start_at TEXT;

-- Media metadata is written by the server's media intake/probe boundary. It
-- is intentionally separate from the client upload request, whose duration
-- is only a hint and must never drive quota reservation.
CREATE TABLE IF NOT EXISTS media_metadata (
  source_uri TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  duration_seconds REAL NOT NULL CHECK (duration_seconds > 0 AND duration_seconds <= 15),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  has_audio INTEGER NOT NULL CHECK (has_audio = 1),
  verified_at TEXT NOT NULL
);

-- A staged source is an opaque, owner-bound capability. The source URI alone
-- is not authorization: both group and member are checked at submission.
CREATE TABLE IF NOT EXISTS staged_sources (
  source_id TEXT PRIMARY KEY,
  source_uri TEXT NOT NULL UNIQUE,
  idempotency_key_hash TEXT NOT NULL UNIQUE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source_path TEXT,
  byte_length INTEGER CHECK (byte_length IS NULL OR byte_length > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'staged')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS staged_sources_owner_idx
  ON staged_sources (group_id, member_id, created_at DESC);

CREATE TABLE IF NOT EXISTS contribution_quota_windows (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  window_start_at TEXT NOT NULL,
  window_end_at TEXT NOT NULL,
  max_count INTEGER NOT NULL CHECK (max_count > 0 AND max_count <= 5),
  max_seconds INTEGER NOT NULL CHECK (max_seconds > 0 AND max_seconds <= 30),
  count_used INTEGER NOT NULL DEFAULT 0 CHECK (count_used >= 0),
  seconds_used INTEGER NOT NULL DEFAULT 0 CHECK (seconds_used >= 0),
  UNIQUE (cycle_id, member_id, window_start_at)
);

CREATE INDEX IF NOT EXISTS contribution_quota_windows_member_idx
  ON contribution_quota_windows (cycle_id, member_id, window_start_at);

-- Preserve all existing contribution consumption when upgrading. Rows are
-- grouped using the cycle start as the weekly-window anchor rather than the
-- server/calendar week. The legacy cycle counters remain intact for older
-- readers, while the new ledger becomes authoritative for uploads.
INSERT OR IGNORE INTO contribution_quota_windows
  (id, cycle_id, member_id, window_start_at, window_end_at,
   max_count, max_seconds, count_used, seconds_used)
SELECT
  'contribution-quota-legacy-' || c.cycle_id || '-' || c.member_id || '-' ||
    CAST(MAX(0, (julianday(c.created_at) - julianday(cy.starts_at)) / 7) AS INTEGER),
  c.cycle_id,
  c.member_id,
  strftime(
    '%Y-%m-%dT%H:%M:%fZ',
    cy.starts_at,
    printf('+%d days', 7 * CAST(MAX(0, (julianday(c.created_at) - julianday(cy.starts_at)) / 7) AS INTEGER))
  ),
  strftime(
    '%Y-%m-%dT%H:%M:%fZ',
    cy.starts_at,
    printf('+%d days', 7 * (CAST(MAX(0, (julianday(c.created_at) - julianday(cy.starts_at)) / 7) AS INTEGER) + 1))
  ),
  MIN(5, MAX(1, cy.max_count)),
  MIN(30, MAX(1, cy.max_seconds)),
  COUNT(*),
  SUM(c.duration_seconds)
FROM contributions c
JOIN cycles cy ON cy.id = c.cycle_id
GROUP BY
  c.cycle_id,
  c.member_id,
  CAST(MAX(0, (julianday(c.created_at) - julianday(cy.starts_at)) / 7) AS INTEGER);

UPDATE contributions
SET quota_window_start_at = (
  SELECT strftime(
    '%Y-%m-%dT%H:%M:%fZ',
    cy.starts_at,
    printf('+%d days', 7 * CAST(MAX(0, (julianday(contributions.created_at) - julianday(cy.starts_at)) / 7) AS INTEGER))
  )
  FROM cycles cy
  WHERE cy.id = contributions.cycle_id
)
WHERE quota_window_start_at IS NULL;

ALTER TABLE sessions
  ADD COLUMN access_kind TEXT NOT NULL DEFAULT 'demo' CHECK (access_kind = 'demo');

ALTER TABLE sessions
  ADD COLUMN expires_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

ALTER TABLE sessions ADD COLUMN invalidated_at TEXT;

-- Existing Sprint 0 rows are upgraded to the same finite demo lifetime as new
-- sessions. They are never treated as secure authentication credentials.
UPDATE sessions
SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '+8 hours')
WHERE expires_at = '1970-01-01T00:00:00.000Z';

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'session.created',
      'session.validated',
      'session.rejected',
      'session.expired',
      'session.invalidated',
      'job.started',
      'job.completed',
      'job.failed'
    )
  ),
  actor_member_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  resource_id TEXT,
  occurred_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('success', 'failure', 'denied'))
);

CREATE INDEX IF NOT EXISTS audit_events_occurred_at_idx
  ON audit_events (occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_events_resource_id_idx
  ON audit_events (resource_id);

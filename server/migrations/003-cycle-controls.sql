-- Demo cycle controls are local, auditable state. They are not an
-- authentication or authorization substitute; the runtime checks membership
-- and the persisted owner role before every mutation.
UPDATE memberships
SET role = 'owner'
WHERE group_id = 'demo-group' AND member_id = 'demo-1' AND role = 'member';

CREATE TABLE IF NOT EXISTS cycle_control_events (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  actor_member_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  advance_seconds INTEGER NOT NULL CHECK (advance_seconds > 0),
  previous_starts_at TEXT NOT NULL,
  previous_ends_at TEXT NOT NULL,
  next_starts_at TEXT NOT NULL,
  next_ends_at TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS cycle_control_events_cycle_idx
  ON cycle_control_events (cycle_id, occurred_at DESC, id DESC);

-- Durable release publication and idempotent cycle-lifecycle receipts.
-- This migration intentionally uses version 009: historical #54 builds
-- briefly claimed version 006, while #44 owns 006 in the integrated schema.
ALTER TABLE cycles ADD COLUMN release_status TEXT NOT NULL DEFAULT 'unpublished'
  CHECK (release_status IN ('unpublished', 'published'));
ALTER TABLE cycles ADD COLUMN release_published_at TEXT;
ALTER TABLE cycles ADD COLUMN previous_cycle_id TEXT REFERENCES cycles(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cycles_previous_cycle_idx
  ON cycles (previous_cycle_id)
  WHERE previous_cycle_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cycle_lifecycle_events (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  transition TEXT NOT NULL CHECK (
    transition IN ('collecting_to_revealing', 'revealing_to_archived', 'next_cycle_created')
  ),
  occurred_at TEXT NOT NULL,
  UNIQUE (cycle_id, transition)
);

CREATE INDEX IF NOT EXISTS cycle_lifecycle_events_group_idx
  ON cycle_lifecycle_events (group_id, occurred_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS cycle_lifecycle_events_receipt_idx
  ON cycle_lifecycle_events (cycle_id, transition);

-- A contribution is tombstoned rather than removed so every later compiler
-- can exclude it, while the quota ledger records the one correction consumed
-- in this cycle-start-anchored weekly window.
ALTER TABLE contributions ADD COLUMN deleted_at TEXT;
ALTER TABLE media_jobs ADD COLUMN deleted_at TEXT;
ALTER TABLE contribution_quota_windows ADD COLUMN deletions_used INTEGER NOT NULL DEFAULT 0
  CHECK (deletions_used >= 0 AND deletions_used <= 1);

CREATE INDEX IF NOT EXISTS contributions_active_cycle_idx
  ON contributions (cycle_id, member_id, deleted_at, created_at);

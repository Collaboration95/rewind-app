ALTER TABLE invites ADD COLUMN code TEXT;
ALTER TABLE invites ADD COLUMN expires_at TEXT;
ALTER TABLE invites ADD COLUMN used_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS invites_code_idx
  ON invites (code)
  WHERE code IS NOT NULL;

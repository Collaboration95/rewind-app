ALTER TABLE real_group_invites
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'accepted', 'expired'));

ALTER TABLE real_group_invites
  ADD COLUMN accepted_by_account_id TEXT REFERENCES real_accounts(id);

ALTER TABLE real_group_invites
  ADD COLUMN accepted_at TEXT;

CREATE INDEX IF NOT EXISTS real_group_invites_status_expiry_idx
  ON real_group_invites (status, expires_at);

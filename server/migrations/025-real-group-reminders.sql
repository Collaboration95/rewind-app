-- Group-local schedules and private per-member preferences. No device tokens
-- or provider credentials are stored by this capability.
CREATE TABLE IF NOT EXISTS real_group_reminder_preferences (
  group_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  snoozed_until TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (group_id, account_id),
  FOREIGN KEY (group_id, account_id)
    REFERENCES real_group_memberships(group_id, account_id) ON DELETE CASCADE
);

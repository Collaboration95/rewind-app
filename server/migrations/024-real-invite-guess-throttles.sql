CREATE TABLE IF NOT EXISTS real_invite_guess_throttles (
  scope TEXT NOT NULL CHECK (scope IN ('account', 'source')),
  subject_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  window_started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, subject_hash)
);

CREATE INDEX IF NOT EXISTS real_invite_guess_throttles_window_idx
  ON real_invite_guess_throttles (window_started_at);

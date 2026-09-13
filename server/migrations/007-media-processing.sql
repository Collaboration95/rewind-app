ALTER TABLE media_jobs ADD COLUMN source_path TEXT;
ALTER TABLE media_jobs ADD COLUMN trim_start_seconds REAL;
ALTER TABLE media_jobs ADD COLUMN trim_end_seconds REAL;
ALTER TABLE media_jobs ADD COLUMN mode TEXT;
ALTER TABLE media_jobs ADD COLUMN error_code TEXT;

-- The server-side intake probe writes this metadata. It is deliberately
-- separate from client request hints so quota and processing never trust them.
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

CREATE TABLE IF NOT EXISTS staged_media_sources (
  source_uri TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

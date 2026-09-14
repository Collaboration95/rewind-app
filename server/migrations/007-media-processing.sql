ALTER TABLE media_jobs ADD COLUMN source_path TEXT;
ALTER TABLE media_jobs ADD COLUMN trim_start_seconds REAL;
ALTER TABLE media_jobs ADD COLUMN trim_end_seconds REAL;
ALTER TABLE media_jobs ADD COLUMN mode TEXT;
ALTER TABLE media_jobs ADD COLUMN error_code TEXT;
ALTER TABLE media_jobs ADD COLUMN processing_started_at TEXT;

ALTER TABLE media_jobs ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS media_jobs_idempotency_idx
  ON media_jobs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

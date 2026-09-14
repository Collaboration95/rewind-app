-- A clip job must retain the exact staged capability generation it consumed.
-- The URI alone is not enough: recovery may reclaim the same capability to a
-- new path while an old worker is still finishing or being retried.
ALTER TABLE media_jobs ADD COLUMN source_uri TEXT;
ALTER TABLE media_jobs ADD COLUMN source_generation INTEGER;

CREATE INDEX IF NOT EXISTS media_jobs_source_binding_idx
  ON media_jobs (source_uri, source_generation, source_path);

-- Bind rows created by the original staged-source implementation where the
-- path is still present. Direct/local legacy paths intentionally remain
-- unbound and are handled by the compatibility worker path.
UPDATE media_jobs
SET source_uri = (
      SELECT source_uri FROM staged_sources
      WHERE staged_sources.source_path = media_jobs.source_path
      LIMIT 1
    ),
    source_generation = (
      SELECT claim_generation FROM staged_sources
      WHERE staged_sources.source_path = media_jobs.source_path
      LIMIT 1
    )
WHERE source_path IS NOT NULL AND source_uri IS NULL;

// Cleanup of staged source files orphaned by interrupted intake jobs.
import { readdir, stat } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import type { RewindDatabase } from '../db';
import {
  cleanupStagedSource,
  cleanupUnclaimedStagedPath,
  findStagedSource,
  removeStagedSource,
} from '../media';

/** Remove a bounded number of staged files left by interrupted intake jobs. */
export async function cleanupOrphanedStagedSources(
  database: RewindDatabase,
  stagingDir: string,
  limit = 25,
  maxAgeMs = 60 * 60 * 1000,
): Promise<number> {
  const names = await readdir(stagingDir, { withFileTypes: true }).catch(() => []);
  const boundedLimit = Math.max(0, Math.min(100, Math.floor(limit)));
  let removed = 0;
  for (const entry of names) {
    const sourceMatch = /^source-([a-f0-9]{24}|[a-f0-9]{32})(?:-([0-9]+))?\.mp4$/.exec(entry.name);
    const partialMatch =
      /^source-([a-f0-9]{24}|[a-f0-9]{32})(?:-([0-9]+))?\.mp4\.[a-f0-9-]+\.part$/.exec(entry.name);
    if (removed >= boundedLimit || !entry.isFile() || (!sourceMatch && !partialMatch)) {
      continue;
    }
    const sourcePath = resolve(stagingDir, entry.name);
    const remainder = relative(resolve(stagingDir), sourcePath);
    if (!remainder || remainder.startsWith('..') || isAbsolute(remainder)) continue;
    const details = await stat(sourcePath).catch(() => null);
    if (!details || Date.now() - details.mtimeMs < maxAgeMs) continue;
    const matched = sourceMatch ?? partialMatch;
    const sourceId = matched?.[1];
    const sourceUri = sourceId ? `staged://${sourceId}` : null;
    const generation = matched?.[2] ? Number(matched[2]) : undefined;
    const staged = sourceUri ? findStagedSource(database, sourceUri) : null;
    const protectedPath = partialMatch ? sourcePath.replace(/\.[a-f0-9-]+\.part$/, '') : sourcePath;
    // A live intake lease protects both its final path and any random-suffix
    // partial path. Cleanup may remove an expired claim, but its generation
    // fence prevents the old request from touching a later reclaim.
    if (
      staged &&
      staged.status === 'pending' &&
      staged.sourcePath === protectedPath &&
      staged.claimExpiresAt &&
      Date.parse(staged.claimExpiresAt) > Date.now()
    ) {
      continue;
    }
    // A partial file is never a job input and can be removed once stale. A
    // completed source is retained only while a job still claims its path.
    if (sourceMatch) {
      const active = database
        .prepare(
          `SELECT 1 FROM media_jobs
           WHERE kind = 'clip' AND status IN ('pending', 'failed', 'processing')
             AND source_path = ?
           LIMIT 1`,
        )
        .get(sourcePath);
      if (active) continue;
    }
    if (sourceMatch && staged && sourceUri) {
      // Do not clean by URI alone. An old generation can remain on disk after
      // reclaim has moved the capability to a new physical path; deleting by
      // URI in that case would remove the current generation instead.
      if (staged.sourcePath !== sourcePath) {
        const removedFile = cleanupUnclaimedStagedPath(database, sourcePath, stagingDir);
        if (removedFile) removed += 1;
        continue;
      }
      const before = await stat(sourcePath).catch(() => null);
      cleanupStagedSource(database, sourceUri, stagingDir, {
        expectedSourcePath: sourcePath,
        ...(generation === undefined ? {} : { expectedClaimGeneration: generation }),
      });
      const after = await stat(sourcePath).catch(() => null);
      if (before && !after) removed += 1;
      continue;
    }
    const removedFile = cleanupUnclaimedStagedPath(
      database,
      sourcePath,
      stagingDir,
      protectedPath,
      partialMatch ? { releaseExpiredPendingClaim: true } : undefined,
    );
    if (!removedFile) continue;
    if (sourceMatch && !staged && sourceUri) {
      database.prepare('DELETE FROM media_metadata WHERE source_uri = ?').run(sourceUri);
      removeStagedSource(database, sourceUri);
    }
    removed += 1;
  }
  // A process can die after claiming a token but before writing the final
  // file. Remove stale pending claims too; the same owner/key can claim again.
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const stale = database
    .prepare(
      `SELECT source_uri AS sourceUri, source_path AS sourcePath,
              claim_generation AS claimGeneration
       FROM staged_sources
       WHERE status = 'pending' AND created_at < ?
         AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
         AND NOT EXISTS (
           SELECT 1 FROM media_jobs WHERE media_jobs.source_path = staged_sources.source_path
         )`,
    )
    .all(cutoff, new Date().toISOString()) as {
    sourceUri?: string;
    sourcePath?: string | null;
    claimGeneration?: number;
  }[];
  for (const row of stale) {
    if (removed >= boundedLimit || !row.sourceUri) break;
    const before = findStagedSource(database, row.sourceUri);
    cleanupStagedSource(database, row.sourceUri, stagingDir, {
      expectedSourcePath: row.sourcePath ?? null,
      expectedClaimGeneration: Number(row.claimGeneration ?? 0),
    });
    if (!findStagedSource(database, row.sourceUri) && before) removed += 1;
  }
  return removed;
}

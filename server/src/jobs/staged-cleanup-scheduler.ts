import type { RewindDatabase } from '../db';
import { cleanupOrphanedStagedSources } from './index';

const CLEANUP_INTERVAL_MS = 10 * 60 * 1_000;
let lastSuccessfulSweepAt = 0;
let sweepInFlight: Promise<number> | null = null;

/** Amortize the fenced directory sweep across intake requests in this runtime. */
export async function maybeCleanupOrphanedStagedSources(
  database: RewindDatabase,
  stagingDir: string,
  now = Date.now(),
): Promise<number> {
  if (sweepInFlight) return sweepInFlight;
  if (now - lastSuccessfulSweepAt < CLEANUP_INTERVAL_MS) return 0;
  sweepInFlight = cleanupOrphanedStagedSources(database, stagingDir)
    .then((removed) => {
      lastSuccessfulSweepAt = now;
      return removed;
    })
    .catch(() => {
      // Let the next eligible intake retry after a transient filesystem error.
      return 0;
    })
    .finally(() => {
      sweepInFlight = null;
    });
  return sweepInFlight;
}

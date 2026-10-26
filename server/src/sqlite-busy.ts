// Writer-lock helpers shared by every module that opens a write transaction.
import type { RewindDatabase } from './db';

const BEGIN_ATTEMPTS = 8;

/** SQLite (and the PostgreSQL adapter's emulation) report a held writer lock this way. */
export function isBusyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; message?: string };
  return (
    candidate.code === 'SQLITE_BUSY' ||
    /database is locked|SQLITE_BUSY/i.test(candidate.message ?? '')
  );
}

/** BEGIN IMMEDIATE, retrying a busy writer lock with short exponential waits
 * (1, 2, 4 ... 64 ms) before giving up with the last error. */
export function beginImmediate(database: RewindDatabase): void {
  for (let attempt = 0; attempt < BEGIN_ATTEMPTS; attempt += 1) {
    try {
      database.exec('BEGIN IMMEDIATE');
      return;
    } catch (error) {
      if (!isBusyError(error) || attempt === BEGIN_ATTEMPTS - 1) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2 ** attempt);
    }
  }
}

import { createHash } from 'node:crypto';
import { lstatSync, opendirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { RewindDatabase } from '../db';

export const PROCESSED_RETENTION_AGE_MS = 24 * 60 * 60 * 1000;
export const PROCESSED_RETENTION_DEFAULT_LIMIT = 100;
export const PROCESSED_RETENTION_MAX_LIMIT = 500;
export const PROCESSED_RETENTION_SCAN_LIMIT = 5000;

export interface RetentionCandidate {
  path: string;
  device: number;
  inode: number;
  size: number;
  modifiedAtMs: number;
  reportName: string;
  databasePaths: [string, string];
}

export interface RetentionPlan {
  cutoff: string;
  limit: number;
  candidates: RetentionCandidate[];
  skippedUnsafe: string[];
}

function within(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return (
    remainder !== '' &&
    remainder !== '..' &&
    !remainder.startsWith(`..${sep}`) &&
    !isAbsolute(remainder)
  );
}

function reportName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return safe || createHash('sha256').update(name).digest('hex').slice(0, 16);
}

function isReferenced(database: RewindDatabase, paths: [string, string]): boolean {
  const result = database
    .prepare(
      `SELECT EXISTS (
         SELECT 1 FROM media_jobs
          WHERE status IN ('pending', 'processing', 'ready') AND output_path IN (?, ?)
       ) OR EXISTS (
         SELECT 1 FROM compilation_job_inputs input
         JOIN media_jobs clip ON clip.id = input.clip_job_id
          WHERE clip.output_path IN (?, ?)
       ) AS referenced`,
    )
    .get(...paths, ...paths) as { referenced: number };
  return Boolean(result.referenced);
}

function safelyStatCandidate(root: string, path: string) {
  const linkDetails = lstatSync(path);
  if (!linkDetails.isFile() || linkDetails.isSymbolicLink()) return null;
  const actual = realpathSync(path);
  if (!within(root, actual)) return null;
  const details = statSync(actual);
  if (!details.isFile()) return null;
  return details;
}

/** Build a read-only candidate list from current DB references and top-level files. */
export function planProcessedMediaRetention(
  database: RewindDatabase,
  processedDir: string,
  options: { now?: Date; limit?: number } = {},
): RetentionPlan {
  const limit = options.limit ?? PROCESSED_RETENTION_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > PROCESSED_RETENTION_MAX_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${PROCESSED_RETENTION_MAX_LIMIT}`);
  }
  const root = realpathSync(processedDir);
  const requestedRoot = resolve(processedDir);
  const cutoffMs = (options.now ?? new Date()).getTime() - PROCESSED_RETENTION_AGE_MS;
  const candidates: RetentionCandidate[] = [];
  const skippedUnsafe: string[] = [];
  const directory = opendirSync(root);
  try {
    for (let scanned = 0; scanned < PROCESSED_RETENTION_SCAN_LIMIT; scanned += 1) {
      const entry = directory.readSync();
      if (!entry) break;
      const name = entry.name;
      const path = resolve(root, name);
      try {
        const details = safelyStatCandidate(root, path);
        if (!details) {
          if (skippedUnsafe.length < limit) skippedUnsafe.push(reportName(name));
          continue;
        }
        const databasePaths: [string, string] = [resolve(requestedRoot, name), realpathSync(path)];
        if (
          candidates.length < limit &&
          !isReferenced(database, databasePaths) &&
          details.mtimeMs <= cutoffMs
        ) {
          candidates.push({
            path: realpathSync(path),
            device: details.dev,
            inode: details.ino,
            size: details.size,
            modifiedAtMs: details.mtimeMs,
            reportName: reportName(name),
            databasePaths,
          });
        }
      } catch {
        if (skippedUnsafe.length < limit) skippedUnsafe.push(reportName(name));
      }
    }
  } finally {
    directory.closeSync();
  }
  return { cutoff: new Date(cutoffMs).toISOString(), limit, candidates, skippedUnsafe };
}

/** Delete planned entries only after obtaining the SQLite writer lock and rechecking references and inode identity. */
export function applyProcessedMediaRetention(
  database: RewindDatabase,
  processedDir: string,
  plan: RetentionPlan,
): { deleted: string[]; skipped: string[] } {
  const root = realpathSync(processedDir);
  const deleted: string[] = [];
  const skipped: string[] = [];
  database.exec('BEGIN IMMEDIATE');
  try {
    const cutoffMs = Date.parse(plan.cutoff);
    for (const candidate of plan.candidates) {
      try {
        const path = resolve(candidate.path);
        if (!within(root, path) || isReferenced(database, candidate.databasePaths)) {
          skipped.push(candidate.reportName);
          continue;
        }
        const details = safelyStatCandidate(root, path);
        if (
          !details ||
          details.dev !== candidate.device ||
          details.ino !== candidate.inode ||
          details.size !== candidate.size ||
          details.mtimeMs !== candidate.modifiedAtMs ||
          details.mtimeMs > cutoffMs
        ) {
          skipped.push(candidate.reportName);
          continue;
        }
        unlinkSync(path);
        deleted.push(candidate.reportName);
      } catch {
        skipped.push(candidate.reportName);
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return { deleted, skipped };
}

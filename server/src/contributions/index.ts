import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import type { RewindDatabase } from '../db';
import { cyclePhase } from '../cycles/engine';

export const MAX_CONTRIBUTION_COUNT = 5;
export const MAX_CONTRIBUTION_SECONDS = 30;
export const MAX_CONTRIBUTION_DURATION_SECONDS = 15;
export const CONTRIBUTION_QUOTA_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface ContributionQuotaCycle {
  id: string;
  startsAt: string;
  endsAt: string;
  maxCount: number;
  maxSeconds: number;
}

export interface ContributionQuotaWindow {
  id: string;
  cycleId: string;
  memberId: string;
  startsAt: string;
  endsAt: string;
  maxCount: number;
  maxSeconds: number;
  countUsed: number;
  secondsUsed: number;
}

export type ContributionQuotaFailure = 'quota_exceeded' | 'invalid_duration';

export type DeleteContributionFailure =
  'not_found' | 'already_deleted' | 'deletion_used' | 'not_eligible' | 'processing';

export type DeleteContributionResult =
  | {
      ok: true;
      contributionId: string;
      jobId: string;
      restored: { count: 1; seconds: number };
    }
  | { ok: false; reason: DeleteContributionFailure };

export interface DeleteContributionOptions {
  /** Server-owned roots used only for idempotent post-commit file cleanup. */
  stagingDir?: string;
  outputDir?: string;
}

interface WindowBoundary {
  startsAt: string;
  endsAt: string;
}

function parseInstant(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new RangeError('Contribution instants must be valid dates.');
  return date;
}

function windowId(cycleId: string, memberId: string, startsAt: string): string {
  const digest = createHash('sha256')
    .update(`${cycleId}\0${memberId}\0${startsAt}`)
    .digest('hex')
    .slice(0, 24);
  return `contribution-quota-${digest}`;
}

function policyLimit(value: number, hardLimit: number): number {
  return Math.max(1, Math.min(hardLimit, Math.floor(value)));
}

export function contributionQuotaWindow(
  cycle: Pick<ContributionQuotaCycle, 'startsAt' | 'endsAt'>,
  now: Date | string,
): WindowBoundary {
  const cycleStart = parseInstant(cycle.startsAt).getTime();
  const cycleEnd = parseInstant(cycle.endsAt).getTime();
  const current = parseInstant(now).getTime();
  if (current < cycleStart || current >= cycleEnd) {
    throw new RangeError('Contribution quota is only available while the cycle is active.');
  }
  const index = Math.floor((current - cycleStart) / CONTRIBUTION_QUOTA_WINDOW_MS);
  const startsAt = new Date(cycleStart + index * CONTRIBUTION_QUOTA_WINDOW_MS);
  const endsAt = new Date(startsAt.getTime() + CONTRIBUTION_QUOTA_WINDOW_MS);
  return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
}

function mapWindow(row: Record<string, unknown>): ContributionQuotaWindow {
  return {
    id: String(row.id),
    cycleId: String(row.cycleId),
    memberId: String(row.memberId),
    startsAt: String(row.startsAt),
    endsAt: String(row.endsAt),
    maxCount: Number(row.maxCount),
    maxSeconds: Number(row.maxSeconds),
    countUsed: Number(row.countUsed),
    secondsUsed: Number(row.secondsUsed),
  };
}

export function ensureContributionQuotaWindow(
  database: RewindDatabase,
  cycle: ContributionQuotaCycle,
  memberId: string,
  now: Date | string,
): ContributionQuotaWindow {
  const boundary = contributionQuotaWindow(cycle, now);
  const maxCount = policyLimit(cycle.maxCount, MAX_CONTRIBUTION_COUNT);
  const maxSeconds = policyLimit(cycle.maxSeconds, MAX_CONTRIBUTION_SECONDS);
  database
    .prepare(
      `INSERT OR IGNORE INTO contribution_quota_windows
        (id, cycle_id, member_id, window_start_at, window_end_at, max_count, max_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      windowId(cycle.id, memberId, boundary.startsAt),
      cycle.id,
      memberId,
      boundary.startsAt,
      boundary.endsAt,
      maxCount,
      maxSeconds,
    );
  const row = database
    .prepare(
      `SELECT id, cycle_id AS cycleId, member_id AS memberId,
          window_start_at AS startsAt, window_end_at AS endsAt,
          max_count AS maxCount, max_seconds AS maxSeconds,
          count_used AS countUsed, seconds_used AS secondsUsed
       FROM contribution_quota_windows
       WHERE cycle_id = ? AND member_id = ? AND window_start_at = ?`,
    )
    .get(cycle.id, memberId, boundary.startsAt) as Record<string, unknown> | undefined;
  if (!row) throw new Error('Contribution quota window could not be persisted.');
  return mapWindow(row);
}

export function reserveContributionAllowance(
  database: RewindDatabase,
  cycle: ContributionQuotaCycle,
  memberId: string,
  durationSeconds: number,
  now: Date | string,
): ContributionQuotaWindow | { reason: ContributionQuotaFailure } {
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > MAX_CONTRIBUTION_DURATION_SECONDS
  ) {
    return { reason: 'invalid_duration' };
  }
  const window = ensureContributionQuotaWindow(database, cycle, memberId, now);
  const update = database
    .prepare(
      `UPDATE contribution_quota_windows
       SET count_used = count_used + 1, seconds_used = seconds_used + ?
       WHERE id = ?
         AND count_used < max_count
         AND seconds_used + ? <= max_seconds`,
    )
    .run(durationSeconds, window.id, durationSeconds);
  if (Number(update.changes) !== 1) return { reason: 'quota_exceeded' };
  return {
    ...window,
    countUsed: window.countUsed + 1,
    secondsUsed: window.secondsUsed + durationSeconds,
  };
}

export function releaseContributionAllowance(
  database: RewindDatabase,
  cycleId: string,
  memberId: string,
  windowStartsAt: string,
  durationSeconds: number,
): void {
  database
    .prepare(
      `UPDATE contribution_quota_windows
       SET count_used = MAX(0, count_used - 1),
           seconds_used = MAX(0, seconds_used - ?)
       WHERE cycle_id = ? AND member_id = ? AND window_start_at = ?`,
    )
    .run(durationSeconds, cycleId, memberId, windowStartsAt);
}

interface DeletableContributionRow {
  contributionId: string;
  memberId: string;
  groupId: string;
  cycleId: string;
  cycleStartsAt: string;
  cycleEndsAt: string;
  cycleStatus: string;
  durationSeconds: number;
  deletedAt: string | null;
  windowStartsAt: string | null;
  jobId: string | null;
  jobStatus: string | null;
  outputPath: string | null;
  sourceUri: string | null;
  sourcePath: string | null;
}

function safeRemoveOwnedPath(path: string | null, root: string | undefined): void {
  if (!path || !root) return;
  const remainder = relative(resolve(root), resolve(path));
  if (!remainder || remainder.startsWith('..') || isAbsolute(remainder)) return;
  rmSync(resolve(path), { force: true });
}

function beginDeletionTransaction(database: RewindDatabase): void {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      database.exec('BEGIN IMMEDIATE');
      return;
    } catch (error) {
      const candidate = error as { code?: string; message?: string };
      const busy =
        candidate.code === 'SQLITE_BUSY' ||
        /database is locked|SQLITE_BUSY/i.test(candidate.message ?? '');
      if (!busy || attempt === 7) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2 ** attempt);
    }
  }
}

/**
 * Tombstone one current-week contribution and return exactly its reserved
 * allowance. The whole eligibility check and ledger mutation run under one
 * writer transaction, so a second delete or a reveal boundary cannot race it.
 */
export function deleteContribution(
  database: RewindDatabase,
  groupId: string,
  memberId: string,
  contributionId: string,
  now = new Date(),
  options: DeleteContributionOptions = {},
): DeleteContributionResult {
  let cleanup: { outputPath: string | null; sourcePath: string | null; sourceUri: string | null } =
    {
      outputPath: null,
      sourcePath: null,
      sourceUri: null,
    };
  let result: DeleteContributionResult;
  beginDeletionTransaction(database);
  try {
    const row = database
      .prepare(
        `SELECT c.id AS contributionId, c.member_id AS memberId,
                cy.group_id AS groupId, c.cycle_id AS cycleId,
                cy.starts_at AS cycleStartsAt, cy.ends_at AS cycleEndsAt,
                cy.status AS cycleStatus, c.duration_seconds AS durationSeconds,
                c.deleted_at AS deletedAt, c.quota_window_start_at AS windowStartsAt,
                j.id AS jobId, j.status AS jobStatus, j.output_path AS outputPath,
                j.source_uri AS sourceUri, j.source_path AS sourcePath
         FROM contributions c
         JOIN cycles cy ON cy.id = c.cycle_id AND cy.group_id = ?
         LEFT JOIN media_jobs j ON j.contribution_id = c.id AND j.kind = 'clip'
         WHERE c.id = ? AND c.member_id = ?
         LIMIT 1`,
      )
      .get(groupId, contributionId, memberId) as DeletableContributionRow | undefined;
    if (!row) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    if (row.deletedAt) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'already_deleted' };
    }
    if (!row.jobId || !row.jobStatus) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'not_eligible' };
    }
    if (row.jobStatus === 'processing') {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'processing' };
    }
    if (!['pending', 'failed', 'ready'].includes(row.jobStatus)) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'not_eligible' };
    }
    const phase = cyclePhase(
      {
        startsAt: row.cycleStartsAt,
        endsAt: row.cycleEndsAt,
        status: row.cycleStatus as 'collecting' | 'revealing' | 'archived',
      },
      now,
    );
    if (phase !== 'collecting' || !row.windowStartsAt) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'not_eligible' };
    }
    const currentWindow = contributionQuotaWindow(
      { startsAt: row.cycleStartsAt, endsAt: row.cycleEndsAt },
      now,
    );
    // A correction belongs to the same seven-day allowance in which the
    // contribution was accepted; this prevents deleting last week's clip to
    // manufacture a second replacement in the current week.
    if (row.windowStartsAt !== currentWindow.startsAt) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'not_eligible' };
    }
    const allowance = database
      .prepare(
        `UPDATE contribution_quota_windows
         SET count_used = MAX(0, count_used - 1),
             seconds_used = MAX(0, seconds_used - ?),
             deletions_used = deletions_used + 1
         WHERE cycle_id = ? AND member_id = ? AND window_start_at = ?
           AND deletions_used < 1`,
      )
      .run(row.durationSeconds, row.cycleId, memberId, row.windowStartsAt);
    if (Number(allowance.changes) !== 1) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'deletion_used' };
    }
    const deletedAt = now.toISOString();
    database
      .prepare('UPDATE contributions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(deletedAt, contributionId);
    database
      .prepare(
        `UPDATE media_jobs
         SET status = 'deleted', deleted_at = ?, output_path = NULL,
             source_uri = NULL, source_generation = NULL, source_path = NULL,
             error_code = 'contribution_deleted'
         WHERE id = ? AND kind = 'clip' AND status IN ('pending', 'failed', 'ready')`,
      )
      .run(deletedAt, row.jobId);
    database
      .prepare(
        'UPDATE cycles SET count_used = MAX(0, count_used - 1), seconds_used = MAX(0, seconds_used - ?) WHERE id = ?',
      )
      .run(row.durationSeconds, row.cycleId);
    if (row.sourceUri) {
      database.prepare('DELETE FROM media_metadata WHERE source_uri = ?').run(row.sourceUri);
      database
        .prepare(
          'DELETE FROM staged_sources WHERE source_uri = ? AND group_id = ? AND member_id = ?',
        )
        .run(row.sourceUri, groupId, memberId);
    }
    cleanup = {
      outputPath: row.outputPath,
      sourcePath: row.sourcePath,
      sourceUri: row.sourceUri,
    };
    database.exec('COMMIT');
    result = {
      ok: true,
      contributionId,
      jobId: row.jobId,
      restored: { count: 1, seconds: Number(row.durationSeconds) },
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  // The DB tombstone is authoritative. File cleanup is bounded to configured
  // server-owned roots and is idempotent, so a failed cleanup cannot make the
  // allowance appear consumed or let the deleted job be compiled.
  safeRemoveOwnedPath(cleanup.outputPath, options.outputDir);
  safeRemoveOwnedPath(cleanup.sourcePath, options.stagingDir);
  return result;
}

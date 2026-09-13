import { createHash } from 'node:crypto';

import type { RewindDatabase } from '../db';

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

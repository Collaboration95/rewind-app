import { randomUUID } from 'node:crypto';

import type { RewindDatabase } from '../db';
import type { CycleClock } from './engine';

type StoredCycle = {
  id: string;
  groupId: string;
  prompt: string;
  startsAt: string;
  endsAt: string;
  status: string;
  lockState: string;
  quota: { maxCount: number; maxSeconds: number };
  contributionUsage: { countUsed: number; secondsUsed: number };
  releaseStatus: string;
  releasePublishedAt: string | null;
  previousCycleId: string | null;
};

class CycleTimeError extends Error {
  constructor(readonly reason: 'invalid_request' | 'invalid_state') {
    super('Cycle time data is invalid.');
    this.name = 'CycleTimeError';
  }
}

export type CycleLifecycleAction =
  'waiting_for_boundary' | 'revealing' | 'waiting_for_release' | 'archived' | 'already_archived';

export interface AdvanceCycleLifecycleInput {
  groupId: string;
  /** Defaults to the group's persisted current cycle. */
  cycleId?: string;
  clock?: CycleClock;
}

export type AdvanceCycleLifecycleResult =
  | {
      ok: true;
      action: CycleLifecycleAction;
      cycle: StoredCycle;
      nextCycle: StoredCycle | null;
    }
  | { ok: false; reason: 'not_found' | 'invalid_request' | 'invalid_state' };

export interface PublishCycleReleaseInput {
  groupId: string;
  cycleId: string;
  publishedAt?: Date | string;
  clock?: CycleClock;
}

export type PublishCycleReleaseResult =
  | { ok: true; action: 'published' | 'already_published'; cycle: StoredCycle }
  | {
      ok: false;
      reason: 'not_found' | 'not_ready' | 'too_early' | 'invalid_request' | 'invalid_state';
    };

function instant(value: Date | string, reason: 'invalid_request' | 'invalid_state'): Date {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new CycleTimeError(reason);
  return result;
}

function readCycle(database: RewindDatabase, cycleId: string, groupId: string): StoredCycle | null {
  const row = database
    .prepare(
      `SELECT id, group_id AS groupId, prompt, starts_at AS startsAt, ends_at AS endsAt,
        status, lock_state AS lockState, max_count AS maxCount, max_seconds AS maxSeconds,
        count_used AS countUsed, seconds_used AS secondsUsed,
        release_status AS releaseStatus, release_published_at AS releasePublishedAt,
        previous_cycle_id AS previousCycleId
       FROM cycles WHERE id = ? AND group_id = ?`,
    )
    .get(cycleId, groupId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const startsAt = String(row.startsAt);
  const endsAt = String(row.endsAt);
  const releaseStatus = String(row.releaseStatus ?? 'unpublished');
  const releasePublishedAt =
    row.releasePublishedAt === null || row.releasePublishedAt === undefined
      ? null
      : String(row.releasePublishedAt);
  instant(startsAt, 'invalid_state');
  instant(endsAt, 'invalid_state');
  if (releasePublishedAt !== null) instant(releasePublishedAt, 'invalid_state');
  if (releaseStatus === 'published' && !releasePublishedAt)
    throw new CycleTimeError('invalid_state');
  return {
    id: String(row.id),
    groupId: String(row.groupId),
    prompt: String(row.prompt),
    startsAt,
    endsAt,
    status: String(row.status),
    lockState: String(row.lockState),
    quota: { maxCount: Number(row.maxCount), maxSeconds: Number(row.maxSeconds) },
    contributionUsage: {
      countUsed: Number(row.countUsed),
      secondsUsed: Number(row.secondsUsed),
    },
    releaseStatus,
    releasePublishedAt,
    previousCycleId: row.previousCycleId ? String(row.previousCycleId) : null,
  };
}

function readSuccessor(
  database: RewindDatabase,
  cycleId: string,
  groupId: string,
): StoredCycle | null {
  const row = database
    .prepare('SELECT id FROM cycles WHERE previous_cycle_id = ? AND group_id = ?')
    .get(cycleId, groupId) as { id?: string } | undefined;
  return row?.id ? readCycle(database, row.id, groupId) : null;
}

function currentCycleId(database: RewindDatabase, groupId: string): string | null {
  const row = database
    .prepare('SELECT current_cycle_id AS currentCycleId FROM groups WHERE id = ?')
    .get(groupId) as { currentCycleId?: string | null } | undefined;
  return row?.currentCycleId ? String(row.currentCycleId) : null;
}

function addEvent(
  database: RewindDatabase,
  cycleId: string,
  groupId: string,
  transition: 'collecting_to_revealing' | 'revealing_to_archived' | 'next_cycle_created',
  occurredAt: string,
): void {
  database
    .prepare(
      `INSERT INTO cycle_lifecycle_events (id, cycle_id, group_id, transition, occurred_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(cycle_id, transition) DO NOTHING`,
    )
    .run(`cycle-lifecycle-${randomUUID()}`, cycleId, groupId, transition, occurredAt);
}

export function publishCycleRelease(
  database: RewindDatabase,
  input: PublishCycleReleaseInput,
): PublishCycleReleaseResult {
  let publishedAt: Date;
  try {
    publishedAt = instant(
      input.publishedAt ?? (input.clock ?? (() => new Date()))(),
      'invalid_request',
    );
  } catch (error) {
    if (error instanceof CycleTimeError) return { ok: false, reason: 'invalid_request' };
    throw error;
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    const cycle = readCycle(database, input.cycleId, input.groupId);
    if (!cycle) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    if (cycle.releaseStatus === 'published') {
      database.exec('COMMIT');
      return { ok: true, action: 'already_published', cycle };
    }
    if (cycle.status !== 'revealing') {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'not_ready' };
    }
    if (publishedAt.getTime() < instant(cycle.endsAt, 'invalid_state').getTime()) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'too_early' };
    }
    database
      .prepare(
        `UPDATE cycles SET release_status = 'published', release_published_at = ?
         WHERE id = ? AND group_id = ? AND status = 'revealing' AND release_status = 'unpublished'`,
      )
      .run(publishedAt.toISOString(), input.cycleId, input.groupId);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    if (error instanceof CycleTimeError) return { ok: false, reason: 'invalid_state' };
    throw error;
  }
  const cycle = readCycle(database, input.cycleId, input.groupId);
  if (!cycle) return { ok: false, reason: 'not_found' };
  return { ok: true, action: 'published', cycle };
}

export function advanceCycleLifecycle(
  database: RewindDatabase,
  input: AdvanceCycleLifecycleInput,
): AdvanceCycleLifecycleResult {
  let now: Date;
  try {
    now = instant((input.clock ?? (() => new Date()))(), 'invalid_request');
  } catch (error) {
    if (error instanceof CycleTimeError) return { ok: false, reason: 'invalid_request' };
    throw error;
  }
  const cycleId = input.cycleId ?? currentCycleId(database, input.groupId);
  if (!cycleId) return { ok: false, reason: 'not_found' };

  database.exec('BEGIN IMMEDIATE');
  try {
    const cycle = readCycle(database, cycleId, input.groupId);
    if (!cycle) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    if (cycle.status === 'collecting') {
      if (now.getTime() < instant(cycle.endsAt, 'invalid_state').getTime()) {
        database.exec('COMMIT');
        return { ok: true, action: 'waiting_for_boundary', cycle, nextCycle: null };
      }
      database
        .prepare(
          `UPDATE cycles SET status = 'revealing', lock_state = 'locked'
           WHERE id = ? AND group_id = ? AND status = 'collecting'`,
        )
        .run(cycle.id, input.groupId);
      addEvent(database, cycle.id, input.groupId, 'collecting_to_revealing', now.toISOString());
      database.exec('COMMIT');
      const revealing = readCycle(database, cycle.id, input.groupId);
      if (!revealing) return { ok: false, reason: 'not_found' };
      return { ok: true, action: 'revealing', cycle: revealing, nextCycle: null };
    }

    if (cycle.status === 'revealing') {
      if (cycle.releaseStatus !== 'published') {
        database.exec('COMMIT');
        return { ok: true, action: 'waiting_for_release', cycle, nextCycle: null };
      }
      const successor = readSuccessor(database, cycle.id, input.groupId);
      if (successor) {
        database
          .prepare("UPDATE cycles SET status = 'archived', lock_state = 'locked' WHERE id = ?")
          .run(cycle.id);
        addEvent(database, cycle.id, input.groupId, 'revealing_to_archived', now.toISOString());
        database.exec('COMMIT');
        return {
          ok: true,
          action: 'archived',
          cycle: readCycle(database, cycle.id, input.groupId)!,
          nextCycle: successor,
        };
      }
      database
        .prepare(
          "UPDATE cycles SET status = 'archived', lock_state = 'locked' WHERE id = ? AND status = 'revealing'",
        )
        .run(cycle.id);
      addEvent(database, cycle.id, input.groupId, 'revealing_to_archived', now.toISOString());

      const publishedAt = cycle.releasePublishedAt
        ? instant(cycle.releasePublishedAt, 'invalid_state')
        : now;
      const startAt = new Date(
        Math.max(
          now.getTime(),
          publishedAt.getTime(),
          instant(cycle.endsAt, 'invalid_state').getTime(),
        ),
      );
      const durationMs =
        instant(cycle.endsAt, 'invalid_state').getTime() -
        instant(cycle.startsAt, 'invalid_state').getTime();
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        database.exec('ROLLBACK');
        return { ok: false, reason: 'invalid_state' };
      }
      const nextEndsAt = new Date(startAt.getTime() + durationMs).toISOString();
      const nextId = `local-cycle-${randomUUID()}`;
      database
        .prepare(
          `INSERT INTO cycles
            (id, group_id, prompt, starts_at, ends_at, status, lock_state,
             max_count, max_seconds, count_used, seconds_used, previous_cycle_id)
           VALUES (?, ?, ?, ?, ?, 'collecting', 'locked', ?, ?, 0, 0, ?)`,
        )
        .run(
          nextId,
          input.groupId,
          cycle.prompt,
          startAt.toISOString(),
          nextEndsAt,
          cycle.quota.maxCount,
          cycle.quota.maxSeconds,
          cycle.id,
        );
      database
        .prepare('UPDATE groups SET current_cycle_id = ? WHERE id = ? AND current_cycle_id = ?')
        .run(nextId, input.groupId, cycle.id);
      addEvent(database, cycle.id, input.groupId, 'next_cycle_created', now.toISOString());
      database.exec('COMMIT');
      const archived = readCycle(database, cycle.id, input.groupId);
      const nextCycle = readCycle(database, nextId, input.groupId);
      if (!archived || !nextCycle) return { ok: false, reason: 'not_found' };
      return { ok: true, action: 'archived', cycle: archived, nextCycle };
    }

    if (cycle.status === 'archived') {
      const successor = readSuccessor(database, cycle.id, input.groupId);
      database.exec('COMMIT');
      return { ok: true, action: 'already_archived', cycle, nextCycle: successor };
    }

    database.exec('ROLLBACK');
    return { ok: false, reason: 'invalid_state' };
  } catch (error) {
    database.exec('ROLLBACK');
    if (error instanceof CycleTimeError) return { ok: false, reason: 'invalid_state' };
    throw error;
  }
}

export const transitionCycleLifecycle = advanceCycleLifecycle;
export const processCycleLifecycle = advanceCycleLifecycle;

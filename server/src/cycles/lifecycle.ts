import { randomUUID } from 'node:crypto';

import type { RewindDatabase } from '../db';
import { hashFileSync } from '../media/integrity';
import type { CycleClock } from './engine';
import { ensureCompilationJob, verifyReadyJobOutput, type StoredJobOptions } from '../jobs';

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
  | 'waiting_for_boundary'
  | 'revealing'
  | 'waiting_for_release'
  | 'premiere'
  | 'archived'
  | 'already_archived';

export const PREMIERE_DURATION_MS = 24 * 60 * 60 * 1000;

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

type OutputRow = {
  id: string;
  status: string;
  outputPath: string;
  sha256: string;
  byteLength: number;
  verifiedAt: string;
};
interface VerifiedOutputProof {
  database: RewindDatabase;
  row: OutputRow;
}
function compilationOutput(
  database: RewindDatabase,
  groupId: string,
  cycleId: string,
): OutputRow | undefined {
  return database
    .prepare(
      `SELECT id, status, output_path AS outputPath, output_sha256 AS sha256,
    output_bytes AS byteLength, output_verified_at AS verifiedAt FROM media_jobs
    WHERE kind = 'film' AND cycle_id = ? AND group_id = ? ORDER BY id ASC LIMIT 1`,
    )
    .get(cycleId, groupId) as OutputRow | undefined;
}
/** Proofs are constructed only here after a pinned verified read. They never cross the public API. */
async function verifyCompilationOutput(
  database: RewindDatabase,
  groupId: string,
  cycleId: string,
  options: StoredJobOptions & { outputDir: string },
): Promise<VerifiedOutputProof | undefined> {
  const row = compilationOutput(database, groupId, cycleId);
  if (!row || !(await verifyReadyJobOutput(database, row.id, options))) return undefined;
  const current = compilationOutput(database, groupId, cycleId);
  return JSON.stringify(row) === JSON.stringify(current) ? { database, row } : undefined;
}
/** A release is only safe once the durable film job has committed its exact output. */
function hasReadyCompilationOutput(
  database: RewindDatabase,
  groupId: string,
  cycleId: string,
  verifyBytes = true,
  proof?: VerifiedOutputProof,
): boolean {
  const job = compilationOutput(database, groupId, cycleId);
  if (
    job?.status !== 'ready' ||
    !job.outputPath ||
    !job.verifiedAt ||
    !Number.isFinite(Date.parse(job.verifiedAt)) ||
    !/^[a-f0-9]{64}$/.test(job.sha256 ?? '') ||
    !Number.isSafeInteger(job.byteLength) ||
    job.byteLength <= 0
  )
    return false;
  if (!verifyBytes) return true;
  if (proof)
    return proof.database === database && JSON.stringify(proof.row) === JSON.stringify(job);
  const observed = hashFileSync(job.outputPath);
  return observed?.sha256 === job.sha256 && observed.byteLength === job.byteLength;
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

function publishCycleReleaseVerified(
  database: RewindDatabase,
  input: PublishCycleReleaseInput,
  proof?: VerifiedOutputProof,
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
      if (!hasReadyCompilationOutput(database, input.groupId, input.cycleId, true, proof)) {
        database.exec('ROLLBACK');
        return { ok: false, reason: 'not_ready' };
      }
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
    if (!hasReadyCompilationOutput(database, input.groupId, input.cycleId, true, proof)) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'not_ready' };
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

/** Called inside the lifecycle transaction, including for legacy closed rows. */
function ensureSuccessor(database: RewindDatabase, cycle: StoredCycle): StoredCycle {
  let successor = readSuccessor(database, cycle.id, cycle.groupId);
  if (!successor) {
    const startAt = instant(cycle.endsAt, 'invalid_state');
    const durationMs = startAt.getTime() - instant(cycle.startsAt, 'invalid_state').getTime();
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
      throw new CycleTimeError('invalid_state');
    const nextId = `local-cycle-${randomUUID()}`;
    const endsAt = new Date(startAt.getTime() + durationMs).toISOString();
    database
      .prepare(
        `INSERT INTO cycles
        (id, group_id, prompt, starts_at, ends_at, status, lock_state,
         max_count, max_seconds, count_used, seconds_used, previous_cycle_id)
       VALUES (?, ?, ?, ?, ?, 'collecting', 'locked', ?, ?, 0, 0, ?)`,
      )
      .run(
        nextId,
        cycle.groupId,
        cycle.prompt,
        startAt.toISOString(),
        endsAt,
        cycle.quota.maxCount,
        cycle.quota.maxSeconds,
        cycle.id,
      );
    successor = readCycle(database, nextId, cycle.groupId)!;
    addEvent(database, cycle.id, cycle.groupId, 'next_cycle_created', startAt.toISOString());
  }
  // Never rewind the group's pointer when replaying an older transition.
  database
    .prepare('UPDATE groups SET current_cycle_id = ? WHERE id = ? AND current_cycle_id = ?')
    .run(successor.id, cycle.groupId, cycle.id);
  return successor;
}

function advanceCycleLifecycleVerified(
  database: RewindDatabase,
  input: AdvanceCycleLifecycleInput,
  proof?: VerifiedOutputProof,
): AdvanceCycleLifecycleResult {
  let now: Date;
  try {
    now = instant((input.clock ?? (() => new Date()))(), 'invalid_request');
  } catch (error) {
    if (error instanceof CycleTimeError) return { ok: false, reason: 'invalid_request' };
    throw error;
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    // Resolve the pointer under the same writer fence as closure and rollover.
    const cycleId = input.cycleId ?? currentCycleId(database, input.groupId);
    const cycle = cycleId ? readCycle(database, cycleId, input.groupId) : null;
    if (!cycle) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    if (
      cycle.status === 'collecting' &&
      now.getTime() < instant(cycle.endsAt, 'invalid_state').getTime()
    ) {
      database.exec('COMMIT');
      return { ok: true, action: 'waiting_for_boundary', cycle, nextCycle: null };
    }
    if (!['collecting', 'revealing', 'archived'].includes(cycle.status)) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'invalid_state' };
    }
    const closing = cycle.status === 'collecting';
    if (closing) {
      database
        .prepare(
          "UPDATE cycles SET status = 'revealing', lock_state = 'locked' WHERE id = ? AND group_id = ?",
        )
        .run(cycle.id, input.groupId);
      addEvent(database, cycle.id, input.groupId, 'collecting_to_revealing', cycle.endsAt);
    }
    if (
      cycle.status !== 'archived' &&
      !ensureCompilationJob(database, {
        groupId: input.groupId,
        cycleId: cycle.id,
        createdAt: instant(cycle.endsAt, 'invalid_state'),
      })
    ) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'invalid_state' };
    }
    const nextCycle = ensureSuccessor(database, cycle);
    let action: CycleLifecycleAction;
    if (closing) action = 'revealing';
    else if (cycle.status === 'archived') action = 'already_archived';
    else if (
      cycle.releaseStatus !== 'published' ||
      !hasReadyCompilationOutput(database, input.groupId, cycle.id, false)
    )
      action = 'waiting_for_release';
    else if (
      now.getTime() <
      instant(cycle.releasePublishedAt!, 'invalid_state').getTime() + PREMIERE_DURATION_MS
    )
      action = 'premiere';
    else if (!hasReadyCompilationOutput(database, input.groupId, cycle.id, true, proof)) {
      action = 'waiting_for_release';
    } else {
      action = 'archived';
      database
        .prepare(
          "UPDATE cycles SET status = 'archived', lock_state = 'locked' WHERE id = ? AND group_id = ?",
        )
        .run(cycle.id, input.groupId);
      addEvent(
        database,
        cycle.id,
        input.groupId,
        'revealing_to_archived',
        new Date(
          instant(cycle.releasePublishedAt!, 'invalid_state').getTime() + PREMIERE_DURATION_MS,
        ).toISOString(),
      );
    }
    const result = {
      ok: true as const,
      action,
      cycle: readCycle(database, cycle.id, input.groupId)!,
      nextCycle,
    };
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    if (error instanceof CycleTimeError || error instanceof RangeError)
      return { ok: false, reason: 'invalid_state' };
    throw error;
  }
}

export function publishCycleRelease(
  database: RewindDatabase,
  input: PublishCycleReleaseInput,
): PublishCycleReleaseResult {
  return publishCycleReleaseVerified(database, input);
}
export function advanceCycleLifecycle(
  database: RewindDatabase,
  input: AdvanceCycleLifecycleInput,
): AdvanceCycleLifecycleResult {
  return advanceCycleLifecycleVerified(database, input);
}
/** Network/storage reads occur before the short transaction, then every persisted field is compared under its fence. */
export async function publishCycleReleaseWithStore(
  database: RewindDatabase,
  input: PublishCycleReleaseInput,
  options: StoredJobOptions & { outputDir: string },
): Promise<PublishCycleReleaseResult> {
  const proof = await verifyCompilationOutput(database, input.groupId, input.cycleId, options);
  if (!proof) return { ok: false, reason: 'not_ready' };
  return publishCycleReleaseVerified(database, input, proof);
}
export async function advanceCycleLifecycleWithStore(
  database: RewindDatabase,
  input: AdvanceCycleLifecycleInput,
  options: StoredJobOptions & { outputDir: string },
): Promise<AdvanceCycleLifecycleResult> {
  const cycleId = input.cycleId ?? currentCycleId(database, input.groupId);
  const row = cycleId
    ? (database
        .prepare(
          'SELECT status, release_published_at AS publishedAt FROM cycles WHERE id = ? AND group_id = ?',
        )
        .get(cycleId, input.groupId) as { status: string; publishedAt: string | null } | undefined)
    : undefined;
  const now = (input.clock ?? (() => new Date()))();
  const proof =
    row?.status === 'revealing' &&
    row.publishedAt &&
    now.getTime() >= Date.parse(row.publishedAt) + PREMIERE_DURATION_MS
      ? await verifyCompilationOutput(database, input.groupId, cycleId!, options)
      : undefined;
  return advanceCycleLifecycleVerified(database, { ...input, clock: () => now }, proof);
}

export const transitionCycleLifecycle = advanceCycleLifecycle;
export const processCycleLifecycle = advanceCycleLifecycle;

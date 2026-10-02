import type { RewindDatabase } from '../db';
import { runWorkerTick, type WorkerOptions, type WorkerTickResult } from '../jobs/worker';
import { advanceCycleLifecycleWithStore, publishCycleReleaseWithStore } from './lifecycle';

export const CYCLE_SCAN_DEFAULT_LIMIT = 16;
export const CYCLE_SCAN_MAX_LIMIT = 100;
export const CYCLE_SCAN_INTERVAL_MS = 1_000;

export interface CycleScanCursor {
  cycleId: string;
  groupId: string;
}

export interface CycleSchedulerOptions extends Pick<
  WorkerOptions,
  'ffmpegBin' | 'stagingDir' | 'outputDir' | 'mediaStore' | 'mediaEnvironment'
> {
  now?: () => Date;
  limit?: number;
  /** Persisted transitions, not this cursor, provide correctness after restart. */
  cursor?: CycleScanCursor;
  shouldStop?: () => boolean;
}

export interface CycleScanOutcome {
  groupId: string;
  cycleId: string;
  action: string;
}

export interface CycleSchedulerTick {
  cursor: CycleScanCursor;
  transitions: CycleScanOutcome[];
  worker: WorkerTickResult;
}

function scanLimit(limit: number | undefined): number {
  if (limit === undefined) return CYCLE_SCAN_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CYCLE_SCAN_MAX_LIMIT)
    throw new RangeError(`Cycle scan limit must be from 1 to ${CYCLE_SCAN_MAX_LIMIT}.`);
  return limit;
}

/** One bounded pass. Real groups alone are eligible; Demo stays owner-driven. */
export async function runCycleSchedulerTick(
  database: RewindDatabase,
  options: CycleSchedulerOptions,
): Promise<CycleSchedulerTick> {
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new RangeError('Invalid scheduler clock.');
  const limit = scanLimit(options.limit);
  const cursor = options.cursor ?? { cycleId: '', groupId: '' };
  const candidates = database
    .prepare(
      `SELECT c.id AS cycleId, c.group_id AS groupId FROM cycles c
     JOIN real_group_metadata real ON real.group_id = c.group_id
     JOIN groups g ON g.id = c.group_id
     WHERE c.id > ? AND (
       (c.status = 'collecting' AND c.ends_at <= ?)
       OR c.status = 'revealing'
       OR (c.status = 'archived' AND g.current_cycle_id = c.id))
     ORDER BY c.id LIMIT ?`,
    )
    .all(cursor.cycleId, now.toISOString(), limit) as { cycleId: string; groupId: string }[];
  const transitions: CycleScanOutcome[] = [];
  for (const candidate of candidates) {
    if (options.shouldStop?.()) break;
    const input = { ...candidate, clock: () => now };
    const advanced = await advanceCycleLifecycleWithStore(database, input, options);
    if (!advanced.ok) {
      transitions.push({ ...candidate, action: advanced.reason });
      continue;
    }
    let action: string = advanced.action;
    if (advanced.cycle.status === 'revealing' && advanced.cycle.releaseStatus !== 'published') {
      const publication = await publishCycleReleaseWithStore(database, input, options);
      if (publication.ok) action = publication.action;
      else if (publication.reason !== 'not_ready') action = publication.reason;
    }
    transitions.push({ ...candidate, action });
  }
  // Round-robin real groups so one permanently unavailable release cannot starve capture or other jobs.
  const groups = database
    .prepare(
      'SELECT group_id AS groupId FROM real_group_metadata WHERE group_id > ? ORDER BY group_id LIMIT ?',
    )
    .all(cursor.groupId, limit) as { groupId: string }[];
  let worker: WorkerTickResult = { claimed: false, reason: 'idle' };
  let lastGroupId = '';
  for (const group of groups) {
    if (options.shouldStop?.()) break;
    lastGroupId = group.groupId;
    worker = await runWorkerTick(database, { ...options, groupId: group.groupId, now: () => now });
    if (worker.claimed) break;
  }
  return {
    cursor: {
      cycleId: candidates.length === limit ? candidates[candidates.length - 1].cycleId : '',
      groupId: worker.claimed || groups.length === limit ? lastGroupId : '',
    },
    transitions,
    worker,
  };
}

export interface CycleSchedulerLoopOptions extends CycleSchedulerOptions {
  intervalMs?: number;
  onTick?: (tick: CycleSchedulerTick) => void;
  onError?: (category: 'database_busy' | 'cycle_scheduler_failed') => void;
}

/** Serial local passes plus durable writer/claim fences make duplicate runtimes safe. */
export function startCycleSchedulerLoop(
  database: RewindDatabase,
  options: CycleSchedulerLoopOptions,
) {
  const intervalMs = options.intervalMs ?? CYCLE_SCAN_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 50 || intervalMs > 60_000)
    throw new RangeError('Cycle scan interval must be from 50 to 60000 ms.');
  scanLimit(options.limit);
  let stopping = false;
  let wake: (() => void) | undefined;
  let cursor = options.cursor;
  const done = (async () => {
    let failures = 0;
    while (!stopping) {
      try {
        const tick = await runCycleSchedulerTick(database, {
          ...options,
          cursor,
          shouldStop: () => stopping,
        });
        cursor = tick.cursor;
        failures = 0;
        options.onTick?.(tick);
      } catch (error) {
        failures += 1;
        const busy = /SQLITE_BUSY|database is locked/i.test(String((error as Error)?.message));
        options.onError?.(busy ? 'database_busy' : 'cycle_scheduler_failed');
        if (failures >= 3) throw new Error('cycle_scheduler_failed');
      }
      if (stopping) break;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
        const timer = setTimeout(finish, intervalMs);
        wake = finish;
        if (stopping) finish();
      });
    }
  })();
  return {
    done,
    async stop() {
      stopping = true;
      wake?.();
      await done;
    },
  };
}

import type { RewindDatabase } from '../db';
import { processClipJob, processCompilationJob, PROCESSING_CLAIM_LEASE_MS } from './index';
import { QUEUE_MAX_FILM_ATTEMPTS, type QueueJobKind } from './queue';

/**
 * Durable local worker loop for media and film jobs.
 *
 * The loop is deliberately a thin claim-and-run shell over the existing
 * exported job processors. Those processors already own the durable lease and
 * generation fences, so this module never writes job state itself. That keeps
 * the request-driven routes usable as rollback: stopping this loop leaves every
 * job pending or retryable for POST /contributions/jobs/:id/process and
 * POST /demo/reveal.
 */

/** Clip jobs retry up to this many durable attempts, then stop being claimed. */
export const WORKER_MAX_CLIP_ATTEMPTS = 3;

/** A failed film at its durable cap is terminal and is never reclaimed. */
export const WORKER_MAX_FILM_ATTEMPTS = QUEUE_MAX_FILM_ATTEMPTS;

/** Default pause between claims when no work is claimable. */
export const WORKER_DEFAULT_IDLE_MS = 1_000;

/** Bounded candidate window so one tick never scans an unbounded queue. */
export const WORKER_DEFAULT_BATCH_SIZE = 8;
export const WORKER_MAX_BATCH_SIZE = 50;

export const WORKER_FAILURE_CATEGORIES = [
  'invalid_metadata',
  'source_unavailable',
  'processing_failed',
  'unknown',
] as const;

export type WorkerFailureCategory = (typeof WORKER_FAILURE_CATEGORIES)[number];

export interface WorkerCandidate {
  id: string;
  kind: QueueJobKind;
  groupId: string;
  status: string;
  attempts: number;
  processingStartedAt: string | null;
}

export interface WorkerRunRecord {
  jobId: string;
  jobKind: QueueJobKind;
  groupId: string;
  /** Durable status observed after the attempt. */
  status: 'ready' | 'failed' | 'processing' | 'deleted' | 'not_found';
  /** busy means another live worker owns the claim. */
  outcome: 'ready' | 'retryable' | 'terminal' | 'busy';
  attempts: number;
  failureCategory: WorkerFailureCategory | null;
  /** A terminal job is never claimed again by any worker. */
  terminal: boolean;
}

export interface WorkerOptions {
  ffmpegBin: string;
  stagingDir: string;
  outputDir: string;
  /** Restrict claiming to one group. Omit to serve every local group. */
  groupId?: string;
  actorMemberId?: string | null;
  /** Overridable for tests; defaults to the durable clip attempt cap. */
  maxClipAttempts?: number;
  maxFilmAttempts?: number;
  /** Lease length used to treat an abandoned processing claim as stale. */
  leaseMs?: number;
  batchSize?: number;
  now?: () => Date;
}

export type WorkerTickResult =
  { claimed: false; reason: 'idle' } | { claimed: true; record: WorkerRunRecord };

export interface WorkerLoopHandle {
  /** Stop claiming new work; an in-flight job is allowed to finish. */
  stop(): Promise<void>;
  /** Resolves once the loop has stopped and any in-flight job settled. */
  readonly done: Promise<void>;
  /** Jobs this loop claimed and finished. */
  readonly completed: () => number;
}

export interface WorkerLoopOptions extends WorkerOptions {
  idleMs?: number;
  /** Stop after claiming and finishing this many jobs. Used by tests and --once. */
  maxJobs?: number;
  onResult?: (record: WorkerRunRecord) => void;
  onError?: (error: unknown) => void;
}

interface WorkerJobStateRow {
  status?: unknown;
  attempts?: unknown;
  errorCode?: unknown;
}

function resolveCap(options: WorkerOptions, kind: QueueJobKind): number {
  const configured = kind === 'film' ? options.maxFilmAttempts : options.maxClipAttempts;
  const fallback = kind === 'film' ? WORKER_MAX_FILM_ATTEMPTS : WORKER_MAX_CLIP_ATTEMPTS;
  const cap = configured ?? fallback;
  return Number.isSafeInteger(cap) && cap >= 1 ? cap : fallback;
}

function boundedBatchSize(value: number | undefined): number {
  if (value === undefined) return WORKER_DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(value) || value < 1) return WORKER_DEFAULT_BATCH_SIZE;
  return Math.min(value, WORKER_MAX_BATCH_SIZE);
}

/** Map durable error codes onto the same safe categories the queue read model uses. */
export function workerFailureCategory(errorCode: unknown): WorkerFailureCategory | null {
  switch (String(errorCode ?? '')) {
    case 'invalid_metadata':
      return 'invalid_metadata';
    case 'source_unavailable':
      return 'source_unavailable';
    case 'process_failed':
    case 'cleanup_failed':
      return 'processing_failed';
    case '':
      return null;
    default:
      return 'unknown';
  }
}

/**
 * Claimable work in deterministic order. A job is claimable when it is
 * pending, retryable below its attempt cap, or owns an expired processing
 * lease. Terminal and freshly claimed jobs are excluded.
 */
export function listWorkerCandidates(
  database: RewindDatabase,
  options: WorkerOptions,
): WorkerCandidate[] {
  const now = options.now?.() ?? new Date();
  const leaseMs =
    options.leaseMs !== undefined && Number.isFinite(options.leaseMs) && options.leaseMs > 0
      ? options.leaseMs
      : PROCESSING_CLAIM_LEASE_MS;
  const staleBefore = new Date(now.getTime() - leaseMs).toISOString();
  const claimable = [
    "status = 'pending'",
    "OR (status = 'failed' AND attempt_count < CASE WHEN kind = 'film' THEN ? ELSE ? END)",
    "OR (status = 'processing' AND (processing_started_at IS NULL OR processing_started_at <= ?))",
  ].join(' ');
  const clauses = [
    "kind IN ('clip', 'film')",
    "(kind = 'clip' OR cycle_id IS NOT NULL)",
    '(' + claimable + ')',
  ];
  const parameters: (string | number)[] = [
    resolveCap(options, 'film'),
    resolveCap(options, 'clip'),
    staleBefore,
  ];
  if (options.groupId) {
    clauses.push('group_id = ?');
    parameters.push(options.groupId);
  }
  const statement = [
    'SELECT id, kind, group_id AS groupId, status, attempt_count AS attempts,',
    '       processing_started_at AS processingStartedAt',
    'FROM media_jobs',
    'WHERE ' + clauses.join(' AND '),
    'ORDER BY created_at ASC, id ASC',
    'LIMIT ?',
  ].join(' ');
  const rows = database
    .prepare(statement)
    .all(...parameters, boundedBatchSize(options.batchSize)) as {
    id?: unknown;
    kind?: unknown;
    groupId?: unknown;
    status?: unknown;
    attempts?: unknown;
    processingStartedAt?: unknown;
  }[];
  return rows.map((row) => ({
    id: String(row.id ?? ''),
    kind: String(row.kind) === 'film' ? 'film' : 'clip',
    groupId: String(row.groupId ?? ''),
    status: String(row.status ?? ''),
    attempts: Math.max(0, Number(row.attempts ?? 0)),
    processingStartedAt: row.processingStartedAt ? String(row.processingStartedAt) : null,
  }));
}

function readWorkerJobState(database: RewindDatabase, jobId: string): WorkerJobStateRow | null {
  const row = database
    .prepare(
      [
        'SELECT status, attempt_count AS attempts, error_code AS errorCode',
        'FROM media_jobs WHERE id = ?',
      ].join(' '),
    )
    .get(jobId) as WorkerJobStateRow | undefined;
  return row ?? null;
}

function toRecord(
  candidate: WorkerCandidate,
  state: WorkerJobStateRow | null,
  cap: number,
): WorkerRunRecord {
  const rawStatus = String(state?.status ?? candidate.status);
  const status: WorkerRunRecord['status'] =
    rawStatus === 'ready' || rawStatus === 'failed' || rawStatus === 'processing'
      ? rawStatus
      : rawStatus === 'deleted'
        ? 'deleted'
        : 'not_found';
  const attempts = Math.max(0, Number(state?.attempts ?? candidate.attempts));
  const terminal = status === 'ready' || (status === 'failed' && attempts >= cap);
  const outcome: WorkerRunRecord['outcome'] =
    status === 'ready'
      ? 'ready'
      : status === 'processing'
        ? 'busy'
        : status === 'failed' && attempts >= cap
          ? 'terminal'
          : 'retryable';
  return {
    jobId: candidate.id,
    jobKind: candidate.kind,
    groupId: candidate.groupId,
    status,
    outcome,
    attempts,
    failureCategory: status === 'failed' ? workerFailureCategory(state?.errorCode) : null,
    terminal,
  };
}

/**
 * Run one claimable job to a durable resting state. The durable processors
 * decide the outcome; this wrapper only reads the committed state back so
 * callers get deterministic retry and terminal classification.
 */
export async function runWorkerTick(
  database: RewindDatabase,
  options: WorkerOptions,
): Promise<WorkerTickResult> {
  const candidates = listWorkerCandidates(database, options);
  for (const candidate of candidates) {
    const cap = resolveCap(options, candidate.kind);
    const result =
      candidate.kind === 'film'
        ? await processCompilationJob(database, {
            jobId: candidate.id,
            groupId: candidate.groupId || undefined,
            ffmpegBin: options.ffmpegBin,
            outputDir: options.outputDir,
            actorMemberId: options.actorMemberId ?? null,
          })
        : await processClipJob(database, {
            jobId: candidate.id,
            groupId: candidate.groupId || undefined,
            ffmpegBin: options.ffmpegBin,
            stagingDir: options.stagingDir,
            outputDir: options.outputDir,
            actorMemberId: options.actorMemberId ?? null,
          });
    // A live claim owned by another worker is not this loop's result. Skip it
    // so one tick can still serve other work and duplicate workers never
    // report a second outcome for the same job.
    if (!result.ok && result.reason === 'already_processing') continue;
    const state = readWorkerJobState(database, candidate.id);
    return { claimed: true, record: toRecord(candidate, state, cap) };
  }
  return { claimed: false, reason: 'idle' };
}

/**
 * Start a durable worker loop. Claiming stops as soon as stop() is called; an
 * in-flight FFmpeg job is awaited so shutdown never abandons a committed
 * output mid-finalization.
 */
export function startWorkerLoop(
  database: RewindDatabase,
  options: WorkerLoopOptions,
): WorkerLoopHandle {
  const idleMs =
    options.idleMs !== undefined && Number.isFinite(options.idleMs) && options.idleMs >= 0
      ? options.idleMs
      : WORKER_DEFAULT_IDLE_MS;
  const maxJobs =
    options.maxJobs !== undefined && Number.isSafeInteger(options.maxJobs) && options.maxJobs >= 1
      ? options.maxJobs
      : Number.POSITIVE_INFINITY;
  let stopping = false;
  let completed = 0;
  let settleStop: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    settleStop = resolve;
  });
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  // An idle wait resolves on its own timer or as soon as stop() is requested,
  // so shutdown never depends on an unref'd timer and is never left pending.
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      void stopped.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });

  void (async () => {
    try {
      while (!stopping && completed < maxJobs) {
        const tick = await runWorkerTick(database, options);
        if (tick.claimed) {
          completed += 1;
          options.onResult?.(tick.record);
          continue;
        }
        if (stopping) break;
        await sleep(idleMs);
      }
    } catch (error) {
      options.onError?.(error);
    } finally {
      resolveDone();
    }
  })();

  return {
    async stop() {
      if (!stopping) {
        stopping = true;
        settleStop();
      }
      // Wait for the in-flight job and the loop's own exit before returning.
      await done;
    },
    get done() {
      return done;
    },
    completed: () => completed,
  };
}

/**
 * A stable, path-free label for a loop-level failure. Loop failures can carry
 * SQLite or filesystem detail, so callers log this label instead of the raw
 * message.
 */
export function safeWorkerErrorLabel(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^SQLITE_BUSY$/i.test(code)) return 'database_busy';
  const name = (error as { name?: unknown } | null)?.name;
  if (typeof name === 'string' && /busy|locks?ed/i.test(name)) return 'database_busy';
  return 'worker_loop_failed';
}

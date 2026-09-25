import { createHash, randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';

import type { RewindDatabase } from '../db';
import { recordAuditEvent } from '../audit';
import {
  cleanupStagedSource,
  cleanupUnclaimedStagedPath,
  findStagedSource,
  cleanupStagedSourcePath,
  removeStagedSource,
} from '../media';
import {
  compileFilmWithFfmpeg,
  processClipWithFfmpeg,
  probeClipWithFfmpeg,
  resolveStagedMediaPath,
  type CaptureMode,
  FfmpegProcessingError,
} from '../ffmpeg';

export interface AuditedJobInput<T> {
  jobId: string;
  actorMemberId?: string | null;
  run: () => Promise<T> | T;
}

function jobResourceId(jobId: string): string {
  return `job:${jobId}`;
}

export function recordJobStarted(
  database: RewindDatabase,
  jobId: string,
  actorMemberId?: string | null,
): void {
  recordAuditEvent(database, {
    eventType: 'job.started',
    actorMemberId,
    resourceId: jobResourceId(jobId),
    result: 'success',
  });
}

export function recordJobCompleted(
  database: RewindDatabase,
  jobId: string,
  actorMemberId?: string | null,
): void {
  recordAuditEvent(database, {
    eventType: 'job.completed',
    actorMemberId,
    resourceId: jobResourceId(jobId),
    result: 'success',
  });
}

export function recordJobFailed(
  database: RewindDatabase,
  jobId: string,
  actorMemberId?: string | null,
): void {
  recordAuditEvent(database, {
    eventType: 'job.failed',
    actorMemberId,
    resourceId: jobResourceId(jobId),
    result: 'failure',
  });
}

/** Run a local job while preserving its failure semantics and safe trace. */
export async function runAuditedJob<T>(
  database: RewindDatabase,
  input: AuditedJobInput<T>,
): Promise<T> {
  recordJobStarted(database, input.jobId, input.actorMemberId);
  try {
    const value = await input.run();
    recordJobCompleted(database, input.jobId, input.actorMemberId);
    return value;
  } catch (error) {
    recordJobFailed(database, input.jobId, input.actorMemberId);
    throw error;
  }
}

export interface ProcessClipJobOptions {
  jobId: string;
  ffmpegBin: string;
  groupId?: string;
  /** Server-owned temporary source directory. Client paths are never removed. */
  stagingDir?: string;
  /** Directory for retained processed media. It must be server-owned. */
  outputDir?: string;
  actorMemberId?: string | null;
  /** Automatic worker retries are capped; request-driven retries omit this. */
  workerAttemptCap?: number;
}

type WorkerWorkObserver = () => void;

export type CompilationJobStatus = 'pending' | 'processing' | 'ready' | 'failed';

/** Three explicit compile attempts prevent a broken cycle from retrying forever. */
export const MAX_COMPILATION_ATTEMPTS = 3;

/** A one-clip cycle gets one clearly labelled clip from its own group's archive. */
export const ARCHIVE_FILLER_MINIMUM_CLIP_COUNT = 2;

export interface CompilationJobInput {
  groupId: string;
  cycleId: string;
  createdAt?: Date | string;
}

export interface CompilationJobRecord {
  id: string;
  groupId: string;
  cycleId: string;
  kind: 'film';
  status: CompilationJobStatus;
  progress: number;
  inputCount: number;
  completedCount: number;
  claimGeneration: number;
  attemptCount: number;
  /** A safe, stable category without FFmpeg or filesystem detail. */
  failureCategory: string | null;
  /** An intentional retry is allowed only before the durable attempt cap. */
  retryable: boolean;
  /** A failed, exhausted film must remain visibly delayed and unpublished. */
  delayed: boolean;
  processingStartedAt: string | null;
  outputPath: string | null;
  createdAt: string;
  clipJobIds: string[];
}

export type CompilationJobResult =
  | { ok: true; job: CompilationJobRecord; created: boolean }
  | { ok: false; reason: 'not_found' | 'invalid_state' };

export type CompilationJobClaimResult =
  | {
      ok: true;
      action: 'claimed' | 'already_processing' | 'already_ready';
      job: CompilationJobRecord;
    }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'retry_exhausted' };

export interface ClaimCompilationJobInput {
  jobId: string;
  groupId?: string;
  now?: Date | string;
  leaseMs?: number;
}

export interface UpdateCompilationProgressInput {
  jobId: string;
  claimGeneration: number;
  completedCount: number;
  progress?: number;
  /** Timestamp at which this worker heartbeat renews its processing lease. */
  now?: Date | string;
}

interface CompilationJobRow {
  id: string;
  groupId: string;
  cycleId: string;
  status: string;
  progress: number;
  inputCount: number;
  completedCount: number;
  claimGeneration: number;
  attemptCount: number;
  errorCode: string | null;
  processingStartedAt: string | null;
  outputPath: string | null;
  createdAt: string;
}

function compilationJobId(groupId: string, cycleId: string): string {
  return `film-${createHash('sha256').update(`${groupId}:${cycleId}`).digest('hex').slice(0, 24)}`;
}

function readCompilationJob(
  database: RewindDatabase,
  jobId: string,
  groupId?: string,
): CompilationJobRecord | null {
  const row = database
    .prepare(
      `SELECT id, group_id AS groupId, cycle_id AS cycleId, status,
              progress, input_count AS inputCount, completed_count AS completedCount,
              claim_generation AS claimGeneration, attempt_count AS attemptCount,
              error_code AS errorCode,
              processing_started_at AS processingStartedAt,
              output_path AS outputPath, created_at AS createdAt
       FROM media_jobs
       WHERE id = ? AND kind = 'film' AND cycle_id IS NOT NULL
         ${groupId ? 'AND group_id = ?' : ''}`,
    )
    .get(...(groupId ? [jobId, groupId] : [jobId])) as CompilationJobRow | undefined;
  if (!row) return null;
  const clipJobIds = database
    .prepare(
      `SELECT clip_job_id AS clipJobId
       FROM compilation_job_inputs WHERE job_id = ? ORDER BY position ASC, clip_job_id ASC`,
    )
    .all(row.id)
    .map((input) => String((input as { clipJobId: string }).clipJobId));
  const status: CompilationJobStatus =
    row.status === 'processing' || row.status === 'ready' || row.status === 'failed'
      ? row.status
      : 'pending';
  const attemptCount = Math.max(0, Number(row.attemptCount));
  const retryable =
    (status === 'pending' || status === 'failed') && attemptCount < MAX_COMPILATION_ATTEMPTS;
  return {
    id: row.id,
    groupId: row.groupId,
    cycleId: row.cycleId,
    kind: 'film',
    status,
    progress: Number(row.progress),
    inputCount: Number(row.inputCount),
    completedCount: Number(row.completedCount),
    claimGeneration: Number(row.claimGeneration),
    attemptCount,
    failureCategory: status === 'failed' && row.errorCode ? String(row.errorCode) : null,
    retryable,
    delayed: status === 'failed' && !retryable,
    processingStartedAt: row.processingStartedAt ?? null,
    outputPath: row.outputPath ?? null,
    createdAt: row.createdAt,
    clipJobIds,
  };
}

export function getCompilationJob(
  database: RewindDatabase,
  jobId: string,
  groupId?: string,
): CompilationJobRecord | null {
  return readCompilationJob(database, jobId, groupId);
}

/**
 * Reconcile the durable input snapshot immediately before a film worker uses
 * it. Contributions are intentionally tombstoned, so a foreign or deleted
 * input can remain in the snapshot after a correction without being removed
 * by a cascading delete. This writer-locked pass removes every input that no
 * longer belongs to this film's group/cycle or is not a processed clip, then
 * compacts positions and the progress counters as one state transition.
 *
 * The returned record is the only input snapshot a caller should consume.
 */
function reconcileCompilationJobInputsLocked(
  database: RewindDatabase,
  jobId: string,
): CompilationJobRecord | null {
  const job = readCompilationJob(database, jobId);
  if (!job) return null;
  const rows = database
    .prepare(
      `SELECT i.clip_job_id AS clipJobId, i.contribution_id AS contributionId,
              i.position AS position,
              CASE WHEN c.id IS NOT NULL
                    AND c.deleted_at IS NULL
                    AND cy.group_id = film.group_id
                    AND (c.cycle_id = film.cycle_id
                      OR (c.cycle_id <> film.cycle_id
                        AND cy.status = 'archived'
                        AND cy.release_status = 'published'))
                    AND clip.id IS NOT NULL
                    AND clip.group_id = film.group_id
                    AND clip.kind = 'clip'
                    AND clip.contribution_id = c.id
                    AND clip.deleted_at IS NULL
                    AND clip.status = 'ready'
                    AND clip.source_path IS NULL
                    AND clip.output_path IS NOT NULL
                   THEN 1 ELSE 0 END AS valid
       FROM compilation_job_inputs i
       JOIN media_jobs film ON film.id = i.job_id
       LEFT JOIN contributions c ON c.id = i.contribution_id
       LEFT JOIN cycles cy ON cy.id = c.cycle_id
       LEFT JOIN media_jobs clip ON clip.id = i.clip_job_id
       WHERE i.job_id = ?
       ORDER BY i.position ASC, i.clip_job_id ASC`,
    )
    .all(jobId) as {
    clipJobId: string;
    contributionId: string;
    position: number;
    valid: number;
  }[];
  const validRows = rows.filter((row) => row.valid === 1);
  const completedBefore = Math.max(0, Math.min(job.completedCount, rows.length));
  const invalidCompleted = rows.filter(
    (row) => row.valid !== 1 && Number(row.position) < completedBefore,
  ).length;
  const completedCount = Math.max(
    0,
    Math.min(validRows.length, completedBefore - invalidCompleted),
  );

  const deleteInput = database.prepare(
    'DELETE FROM compilation_job_inputs WHERE job_id = ? AND clip_job_id = ?',
  );
  const validIds = new Set(validRows.map((row) => row.clipJobId));
  for (const row of rows) {
    if (!validIds.has(row.clipJobId)) deleteInput.run(jobId, row.clipJobId);
  }
  const updatePosition = database.prepare(
    'UPDATE compilation_job_inputs SET position = ? WHERE job_id = ? AND clip_job_id = ?',
  );
  for (const [position, row] of validRows.entries()) {
    updatePosition.run(position, jobId, row.clipJobId);
  }
  const progress =
    validRows.length === 0 ? 0 : Math.floor((completedCount / validRows.length) * 100);
  database
    .prepare(
      `UPDATE media_jobs
       SET input_count = ?, completed_count = ?, progress = ?
       WHERE id = ? AND kind = 'film' AND cycle_id IS NOT NULL`,
    )
    .run(validRows.length, completedCount, progress, jobId);
  return readCompilationJob(database, jobId);
}

/** Reconcile a film's input snapshot in its own writer transaction. */
export function reconcileCompilationJobInputs(
  database: RewindDatabase,
  jobId: string,
): CompilationJobRecord | null {
  beginJobTransaction(database);
  try {
    const job = reconcileCompilationJobInputsLocked(database, jobId);
    database.exec(job ? 'COMMIT' : 'ROLLBACK');
    return job;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Create the one cycle-scoped film job and snapshot only processed clip job
 * ids. This helper deliberately assumes that its caller already owns the
 * SQLite writer transaction; the public createCompilationJob wrapper below
 * supplies that transaction for standalone callers and lifecycle uses this
 * helper to keep cycle transition + job creation atomic.
 */
export function ensureCompilationJob(
  database: RewindDatabase,
  input: CompilationJobInput,
): CompilationJobRecord | null {
  const cycle = database
    .prepare('SELECT id, group_id AS groupId, status FROM cycles WHERE id = ? AND group_id = ?')
    .get(input.cycleId, input.groupId) as
    { id: string; groupId: string; status: string } | undefined;
  if (!cycle || !['revealing', 'archived'].includes(cycle.status)) return null;

  const existingId = database
    .prepare(
      `SELECT id FROM media_jobs
       WHERE kind = 'film' AND cycle_id = ? AND group_id = ? LIMIT 1`,
    )
    .get(input.cycleId, input.groupId) as { id?: string } | undefined;
  if (existingId?.id) return readCompilationJob(database, existingId.id, input.groupId);

  const currentCycleClips = database
    .prepare(
      `SELECT clip.id AS clipJobId, c.id AS contributionId
       FROM contributions c
       JOIN cycles cy ON cy.id = c.cycle_id AND cy.group_id = ?
       JOIN media_jobs clip
         ON clip.contribution_id = c.id AND clip.group_id = cy.group_id
        AND clip.kind = 'clip' AND clip.status = 'ready'
        AND clip.deleted_at IS NULL
       WHERE c.cycle_id = ?
         AND c.deleted_at IS NULL
         -- A ready clip has completed processing only when its raw staged
         -- path is no longer retained. No source path is copied to the film
         -- job or its input snapshot.
         AND clip.source_path IS NULL
         AND clip.output_path IS NOT NULL
       ORDER BY c.created_at ASC, c.id ASC, clip.id ASC`,
    )
    .all(input.groupId, input.cycleId) as { clipJobId: string; contributionId: string }[];
  const archiveFiller =
    currentCycleClips.length > 0 && currentCycleClips.length < ARCHIVE_FILLER_MINIMUM_CLIP_COUNT
      ? (database
          .prepare(
            `SELECT clip.id AS clipJobId, c.id AS contributionId
             FROM contributions c
             JOIN cycles cy ON cy.id = c.cycle_id AND cy.group_id = ?
             JOIN media_jobs clip
               ON clip.contribution_id = c.id AND clip.group_id = cy.group_id
              AND clip.kind = 'clip' AND clip.status = 'ready'
              AND clip.deleted_at IS NULL
             WHERE c.cycle_id <> ?
               AND cy.status = 'archived'
               AND cy.release_status = 'published'
               AND cy.release_published_at IS NOT NULL
               AND c.deleted_at IS NULL
               AND clip.source_path IS NULL
               AND clip.output_path IS NOT NULL
             ORDER BY cy.release_published_at DESC, c.created_at DESC, c.id DESC, clip.id DESC
             LIMIT 1`,
          )
          .get(input.groupId, input.cycleId) as
          { clipJobId: string; contributionId: string } | undefined)
      : undefined;
  const eligible = archiveFiller ? [...currentCycleClips, archiveFiller] : currentCycleClips;
  const createdAt = new Date(input.createdAt ?? new Date());
  if (!Number.isFinite(createdAt.getTime())) return null;
  const jobId = compilationJobId(input.groupId, input.cycleId);
  database
    .prepare(
      `INSERT INTO media_jobs
        (id, group_id, contribution_id, kind, status, output_path, created_at,
         idempotency_key, cycle_id, progress, input_count, completed_count,
         claim_generation, processing_started_at, updated_at)
       VALUES (?, ?, NULL, 'film', 'pending', NULL, ?, NULL, ?, 0, ?, 0, 0, NULL, ?)`,
    )
    .run(
      jobId,
      input.groupId,
      createdAt.toISOString(),
      input.cycleId,
      eligible.length,
      createdAt.toISOString(),
    );
  const insertInput = database.prepare(
    `INSERT INTO compilation_job_inputs (job_id, clip_job_id, contribution_id, position)
     VALUES (?, ?, ?, ?)`,
  );
  for (const [position, clip] of eligible.entries()) {
    insertInput.run(jobId, clip.clipJobId, clip.contributionId, position);
  }
  return readCompilationJob(database, jobId, input.groupId);
}

/** Create or retrieve the single persistent film job for a completed cycle. */
export function createCompilationJob(
  database: RewindDatabase,
  input: CompilationJobInput,
): CompilationJobResult {
  beginJobTransaction(database);
  try {
    const existing = database
      .prepare(
        `SELECT id FROM media_jobs
         WHERE kind = 'film' AND cycle_id = ? AND group_id = ? LIMIT 1`,
      )
      .get(input.cycleId, input.groupId) as { id?: string } | undefined;
    if (existing?.id) {
      const job = readCompilationJob(database, existing.id, input.groupId);
      database.exec('COMMIT');
      return job ? { ok: true, job, created: false } : { ok: false, reason: 'invalid_state' };
    }
    const cycle = database
      .prepare('SELECT status FROM cycles WHERE id = ? AND group_id = ?')
      .get(input.cycleId, input.groupId) as { status?: string } | undefined;
    if (!cycle) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    if (!['revealing', 'archived'].includes(String(cycle.status))) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'invalid_state' };
    }
    const job = ensureCompilationJob(database, input);
    if (!job) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'invalid_state' };
    }
    database.exec('COMMIT');
    return { ok: true, job, created: true };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/** Atomically claim a pending/failed job, or reclaim a stale worker claim. */
export function claimCompilationJob(
  database: RewindDatabase,
  input: ClaimCompilationJobInput,
): CompilationJobClaimResult {
  const now = new Date(input.now ?? new Date());
  if (!Number.isFinite(now.getTime())) return { ok: false, reason: 'invalid_state' };
  const leaseMs = input.leaseMs ?? PROCESSING_CLAIM_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) return { ok: false, reason: 'invalid_state' };
  beginJobTransaction(database);
  try {
    let job = readCompilationJob(database, input.jobId, input.groupId);
    if (!job) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    job = reconcileCompilationJobInputsLocked(database, job.id);
    if (!job) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'invalid_state' };
    }
    if (job.status === 'ready') {
      database.exec('COMMIT');
      return { ok: true, action: 'already_ready', job };
    }
    if (job.status === 'processing') {
      const startedAt = job.processingStartedAt ? Date.parse(job.processingStartedAt) : Number.NaN;
      if (Number.isFinite(startedAt) && now.getTime() - startedAt < leaseMs) {
        database.exec('COMMIT');
        return { ok: true, action: 'already_processing', job };
      }
    } else if (!['pending', 'failed'].includes(job.status)) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'invalid_state' };
    }
    if (job.status === 'failed' && job.attemptCount >= MAX_COMPILATION_ATTEMPTS) {
      database.exec('COMMIT');
      return { ok: false, reason: 'retry_exhausted' };
    }
    const generation = job.claimGeneration + 1;
    // A stale worker reclaim resumes the same attempt; only a pending/failed
    // job starts an intentional new retry.
    const startsNewAttempt = job.status === 'pending' || job.status === 'failed';
    const attemptCount = job.attemptCount + (startsNewAttempt ? 1 : 0);
    database
      .prepare(
        `UPDATE media_jobs
         SET status = 'processing', error_code = NULL,
             processing_started_at = ?, claim_generation = ?, attempt_count = ?,
             updated_at = ?, failed_at = NULL
         WHERE id = ? AND kind = 'film' AND status IN ('pending', 'failed', 'processing')`,
      )
      .run(now.toISOString(), generation, attemptCount, now.toISOString(), job.id);
    job = readCompilationJob(database, job.id, input.groupId);
    if (!job) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'invalid_state' };
    }
    database.exec('COMMIT');
    return { ok: true, action: 'claimed', job };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/** Persist monotonic progress for the worker that owns a specific claim. */
export function updateCompilationJobProgress(
  database: RewindDatabase,
  input: UpdateCompilationProgressInput,
): CompilationJobRecord | null {
  const now = new Date(input.now ?? new Date());
  if (!Number.isFinite(now.getTime())) return null;
  const completedCount = Math.max(0, Math.floor(input.completedCount));
  if (!Number.isSafeInteger(input.claimGeneration) || completedCount !== input.completedCount)
    return null;
  beginJobTransaction(database);
  try {
    // Read and update under the same writer lock. This prevents a stale
    // worker from renewing a lease after another worker has reclaimed it.
    const current = readCompilationJob(database, input.jobId);
    if (
      !current ||
      current.status !== 'processing' ||
      current.claimGeneration !== input.claimGeneration ||
      completedCount < current.completedCount ||
      completedCount > current.inputCount
    ) {
      database.exec('ROLLBACK');
      return null;
    }
    if (
      input.progress !== undefined &&
      (!Number.isFinite(input.progress) || !Number.isSafeInteger(input.progress))
    ) {
      database.exec('ROLLBACK');
      return null;
    }
    const progress =
      input.progress === undefined
        ? current.inputCount === 0
          ? 0
          : Math.floor((completedCount / current.inputCount) * 100)
        : Math.max(0, Math.min(100, Math.floor(input.progress)));
    if (progress < current.progress) {
      database.exec('ROLLBACK');
      return null;
    }
    const result = database
      .prepare(
        `UPDATE media_jobs
         SET completed_count = ?, progress = ?, processing_started_at = ?, updated_at = ?
         WHERE id = ? AND kind = 'film' AND status = 'processing'
           AND claim_generation = ?`,
      )
      .run(
        completedCount,
        progress,
        now.toISOString(),
        now.toISOString(),
        input.jobId,
        input.claimGeneration,
      );
    if (Number(result.changes) !== 1) {
      database.exec('ROLLBACK');
      return null;
    }
    const updated = readCompilationJob(database, input.jobId);
    if (!updated) {
      database.exec('ROLLBACK');
      return null;
    }
    database.exec('COMMIT');
    return updated;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export type ProcessCompilationJobResult =
  | { ok: true; jobId: string; status: 'ready' }
  | {
      ok: false;
      jobId: string;
      status: 'failed' | 'processing' | 'not_found';
      reason: 'not_found' | 'already_processing' | 'processing_failed' | 'retry_exhausted';
      message: string;
    };

export interface ProcessCompilationJobOptions {
  jobId: string;
  ffmpegBin: string;
  groupId?: string;
  /** Directory for retained processed clips and final films. */
  outputDir?: string;
  actorMemberId?: string | null;
}

interface CompilationInputOutput {
  clipJobId: string;
  outputPath: string;
  isArchiveFiller: boolean;
}

function filmOutputName(jobId: string): string {
  const suffix = createHash('sha256').update(jobId).digest('hex').slice(0, 24);
  return `film-${suffix}.mp4`;
}

function readCompilationInputOutputs(
  database: RewindDatabase,
  jobId: string,
): CompilationInputOutput[] {
  return database
    .prepare(
      `SELECT i.clip_job_id AS clipJobId, clip.output_path AS outputPath,
              CASE WHEN contribution.cycle_id <> film.cycle_id THEN 1 ELSE 0 END AS isArchiveFiller
       FROM compilation_job_inputs i
       JOIN media_jobs film ON film.id = i.job_id
       JOIN media_jobs clip ON clip.id = i.clip_job_id
       JOIN contributions contribution ON contribution.id = i.contribution_id
       WHERE i.job_id = ?
         AND clip.kind = 'clip' AND clip.status = 'ready'
         AND clip.source_path IS NULL AND clip.output_path IS NOT NULL
         AND clip.deleted_at IS NULL
       ORDER BY i.position ASC, i.clip_job_id ASC`,
    )
    .all(jobId)
    .map((row) => ({
      clipJobId: String((row as { clipJobId: string }).clipJobId),
      outputPath: String((row as { outputPath: string }).outputPath),
      isArchiveFiller: Number((row as { isArchiveFiller: number }).isArchiveFiller) === 1,
    }));
}

async function resolveProcessedMediaPath(value: string, outputDir: string): Promise<string> {
  try {
    const [source, processed] = await Promise.all([realpath(value), realpath(outputDir)]);
    const remainder = relative(processed, source);
    if (!remainder || remainder.startsWith('..') || isAbsolute(remainder)) {
      throw new Error('outside processed directory');
    }
    return source;
  } catch {
    throw new FfmpegProcessingError(
      'source_unavailable',
      'A processed clip is unavailable for film compilation.',
    );
  }
}

function markCompilationFailed(
  database: RewindDatabase,
  jobId: string,
  claimGeneration: number,
  errorCode: string,
): void {
  const failedAt = new Date().toISOString();
  database
    .prepare(
      `UPDATE media_jobs
       SET status = 'failed', output_path = NULL, error_code = ?, processing_started_at = NULL,
           updated_at = ?, failed_at = ?
       WHERE id = ? AND kind = 'film' AND status = 'processing' AND claim_generation = ?`,
    )
    .run(errorCode, failedAt, failedAt, jobId, claimGeneration);
}

/**
 * Atomically publish a completed film only while the same worker generation
 * still owns the reconciled chronological input snapshot. A completed FFmpeg
 * temp file never becomes the durable output unless this fence succeeds.
 */
function publishCompilationOutput(
  database: RewindDatabase,
  job: CompilationJobRecord,
  expectedClipJobIds: string[],
  temporaryOutputPath: string,
  finalOutputPath: string,
): boolean {
  beginJobTransaction(database);
  try {
    const current = reconcileCompilationJobInputsLocked(database, job.id);
    if (
      !current ||
      current.status !== 'processing' ||
      current.claimGeneration !== job.claimGeneration ||
      current.inputCount === 0 ||
      current.clipJobIds.length !== expectedClipJobIds.length ||
      current.clipJobIds.some((id, index) => id !== expectedClipJobIds[index])
    ) {
      database.exec('ROLLBACK');
      return false;
    }
    renameSync(temporaryOutputPath, finalOutputPath);
    const result = database
      .prepare(
        `UPDATE media_jobs
         SET status = 'ready', output_path = ?, completed_count = input_count, progress = 100,
             error_code = NULL, processing_started_at = NULL, updated_at = ?, failed_at = NULL
         WHERE id = ? AND kind = 'film' AND status = 'processing' AND claim_generation = ?`,
      )
      .run(finalOutputPath, new Date().toISOString(), job.id, job.claimGeneration);
    if (Number(result.changes) !== 1) {
      database.exec('ROLLBACK');
      return false;
    }
    database.exec('COMMIT');
    return true;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/** Compile a cycle's reconciled, retained clips into one ready-only film. */
export function processCompilationJob(
  database: RewindDatabase,
  options: ProcessCompilationJobOptions,
): Promise<ProcessCompilationJobResult> {
  return processCompilationJobInternal(database, options);
}

/** @internal The worker observes claims separately from the request result. */
export function processCompilationJobForWorker(
  database: RewindDatabase,
  options: ProcessCompilationJobOptions,
  onWorkerWork: WorkerWorkObserver,
): Promise<ProcessCompilationJobResult> {
  return processCompilationJobInternal(database, options, onWorkerWork);
}

async function processCompilationJobInternal(
  database: RewindDatabase,
  options: ProcessCompilationJobOptions,
  onWorkerWork?: WorkerWorkObserver,
): Promise<ProcessCompilationJobResult> {
  const claim = claimCompilationJob(database, { jobId: options.jobId, groupId: options.groupId });
  if (!claim.ok) {
    const exhausted = claim.reason === 'retry_exhausted';
    return {
      ok: false,
      jobId: options.jobId,
      status: claim.reason === 'not_found' ? 'not_found' : 'failed',
      reason:
        claim.reason === 'not_found'
          ? 'not_found'
          : exhausted
            ? 'retry_exhausted'
            : 'processing_failed',
      message:
        claim.reason === 'not_found'
          ? 'The film job was not found.'
          : exhausted
            ? 'The film is delayed after the maximum number of compile attempts.'
            : 'The film job cannot be processed in its current state.',
    };
  }
  if (claim.action === 'already_ready') return { ok: true, jobId: claim.job.id, status: 'ready' };
  if (claim.action === 'already_processing') {
    return {
      ok: false,
      jobId: claim.job.id,
      status: 'processing',
      reason: 'already_processing',
      message: 'The film job is already processing.',
    };
  }
  onWorkerWork?.();

  const outputDir =
    options.outputDir ?? resolve(process.cwd(), '.local-data', 'media', 'processed');
  const finalOutputPath = resolve(outputDir, filmOutputName(claim.job.id));
  const temporaryOutputPath = resolve(
    outputDir,
    `.${filmOutputName(claim.job.id)}.${randomUUID()}.part.mp4`,
  );
  try {
    if (claim.job.inputCount === 0) {
      throw new FfmpegProcessingError(
        'invalid_metadata',
        'The film has no processed clips to compile.',
      );
    }
    const inputs = readCompilationInputOutputs(database, claim.job.id);
    if (
      inputs.length !== claim.job.clipJobIds.length ||
      inputs.some((input, index) => input.clipJobId !== claim.job.clipJobIds[index])
    ) {
      throw new FfmpegProcessingError(
        'source_unavailable',
        'A processed clip changed while preparing the film.',
      );
    }
    await mkdir(outputDir, { recursive: true });
    const inputPaths = await Promise.all(
      inputs.map((input) => resolveProcessedMediaPath(input.outputPath, outputDir)),
    );
    const archiveFillerIndexes = inputs.flatMap((input, index) =>
      input.isArchiveFiller ? [index] : [],
    );
    if (archiveFillerIndexes.length > 1) {
      throw new FfmpegProcessingError(
        'invalid_metadata',
        'The film has an invalid archive filler snapshot.',
      );
    }
    await runAuditedJob(database, {
      jobId: claim.job.id,
      actorMemberId: options.actorMemberId,
      run: async () => {
        await compileFilmWithFfmpeg(options.ffmpegBin, {
          inputPaths,
          archiveFillerIndex: archiveFillerIndexes[0],
          outputPath: temporaryOutputPath,
        });
        await probeClipWithFfmpeg(options.ffmpegBin, temporaryOutputPath);
        if (
          !publishCompilationOutput(
            database,
            claim.job,
            claim.job.clipJobIds,
            temporaryOutputPath,
            finalOutputPath,
          )
        ) {
          throw new FfmpegProcessingError(
            'source_unavailable',
            'The film inputs changed while finalizing.',
          );
        }
      },
    });
    return { ok: true, jobId: claim.job.id, status: 'ready' };
  } catch (error) {
    await rm(temporaryOutputPath, { force: true }).catch(() => undefined);
    if (getCompilationJob(database, claim.job.id)?.status !== 'ready') {
      await rm(finalOutputPath, { force: true }).catch(() => undefined);
      const errorCode = error instanceof FfmpegProcessingError ? error.code : 'cleanup_failed';
      markCompilationFailed(database, claim.job.id, claim.job.claimGeneration, errorCode);
    }
    const delayed = getCompilationJob(database, claim.job.id)?.delayed === true;
    return {
      ok: false,
      jobId: claim.job.id,
      status: 'failed',
      reason: delayed ? 'retry_exhausted' : 'processing_failed',
      message: delayed
        ? 'The film is delayed after the maximum number of compile attempts.'
        : 'The film could not be compiled. Retry the job.',
    };
  }
}

/** A worker claim is recoverable after a process dies without completing it. */
export const PROCESSING_CLAIM_LEASE_MS = 15 * 60 * 1000;

export type ProcessClipJobResult =
  | { ok: true; jobId: string; status: 'ready' }
  | {
      ok: false;
      jobId: string;
      status: 'failed' | 'processing' | 'not_found';
      reason: 'not_found' | 'already_processing' | 'processing_failed' | 'retry_exhausted';
      message: string;
    };

interface ClipJobRow {
  id: string;
  status: string;
  claimGeneration: number;
  outputPath: string | null;
  sourceUri: string | null;
  sourceGeneration: number | null;
  sourcePath: string | null;
  trimStartSeconds: number | null;
  trimEndSeconds: number | null;
  mode: string | null;
  processingStartedAt: string | null;
  attemptCount: number;
}

type ClipJobClaimResult =
  | { claimed: true; row: ClipJobRow }
  | {
      claimed: false;
      reason: 'not_found' | 'already_processing' | 'not_claimable' | 'retry_exhausted';
    };

function readClipJob(database: RewindDatabase, jobId: string, groupId?: string): ClipJobRow | null {
  const row = database
    .prepare(
      `SELECT id, status, claim_generation AS claimGeneration,
              output_path AS outputPath, source_uri AS sourceUri,
              source_generation AS sourceGeneration, source_path AS sourcePath,
              trim_start_seconds AS trimStartSeconds,
              trim_end_seconds AS trimEndSeconds, mode,
              processing_started_at AS processingStartedAt,
              attempt_count AS attemptCount
       FROM media_jobs
       WHERE id = ? AND kind = 'clip' ${groupId ? 'AND group_id = ?' : ''}`,
    )
    .get(...(groupId ? [jobId, groupId] : [jobId])) as ClipJobRow | undefined;
  return row ? { ...row, claimGeneration: Number(row.claimGeneration) } : null;
}

function beginJobTransaction(database: RewindDatabase): void {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      database.exec('BEGIN IMMEDIATE');
      return;
    } catch (error) {
      const candidate = error as { code?: string; message?: string };
      if (
        !(
          candidate.code === 'SQLITE_BUSY' ||
          /database is locked|SQLITE_BUSY/i.test(candidate.message ?? '')
        ) ||
        attempt === 7
      ) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2 ** attempt);
    }
  }
}

function stagedBindingMatches(database: RewindDatabase, row: ClipJobRow): boolean {
  if (!row.sourceUri) return true;
  if (row.sourceGeneration === null || !row.sourcePath) return false;
  const staged = findStagedSource(database, row.sourceUri);
  return Boolean(
    staged &&
    staged.status === 'staged' &&
    staged.claimGeneration === row.sourceGeneration &&
    staged.sourcePath === row.sourcePath,
  );
}

/** Persist the output before touching the raw source. This marker is the
 * durable hand-off that lets a restarted worker finish a partially completed
 * finalization without ever retrying against an already-deleted source. */
function markOutputPrepared(
  database: RewindDatabase,
  row: ClipJobRow,
  outputPath: string,
): boolean {
  beginJobTransaction(database);
  try {
    const locked = readClipJob(database, row.id);
    if (
      !locked ||
      locked.status !== 'processing' ||
      locked.claimGeneration !== row.claimGeneration ||
      locked.sourcePath !== row.sourcePath ||
      locked.sourceUri !== row.sourceUri ||
      locked.sourceGeneration !== row.sourceGeneration ||
      !stagedBindingMatches(database, locked)
    ) {
      database.exec('ROLLBACK');
      return false;
    }
    database
      .prepare(
        `UPDATE media_jobs SET output_path = ?, error_code = NULL, updated_at = ?
         WHERE id = ? AND kind = 'clip' AND status = 'processing'
           AND claim_generation = ? AND (output_path IS NULL OR output_path = ?)`,
      )
      .run(outputPath, new Date().toISOString(), row.id, row.claimGeneration, outputPath);
    database.exec('COMMIT');
    return true;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/** Complete the filesystem/DB hand-off under one writer lock. Filesystem
 * deletion is intentionally idempotent: a crash after deletion but before
 * COMMIT is recovered by the same output marker on the next worker run. */
function finalizePreparedOutput(
  database: RewindDatabase,
  row: ClipJobRow,
  stagingDir: string,
  outputPath: string,
  onFinalized?: WorkerWorkObserver,
): boolean {
  beginJobTransaction(database);
  try {
    const locked = readClipJob(database, row.id);
    if (!locked || locked.status === 'ready') {
      database.exec('COMMIT');
      return locked?.status === 'ready';
    }
    if (
      locked.status !== 'processing' ||
      locked.claimGeneration !== row.claimGeneration ||
      locked.outputPath !== outputPath ||
      locked.sourcePath !== row.sourcePath ||
      locked.sourceUri !== row.sourceUri ||
      locked.sourceGeneration !== row.sourceGeneration ||
      !stagedBindingMatches(database, locked)
    ) {
      database.exec('ROLLBACK');
      return false;
    }
    if (locked.sourcePath) {
      // cleanupStagedSourcePath enforces the server-owned staging boundary;
      // it is safe to call after a prior crash because force is idempotent.
      cleanupStagedSourcePath(locked.sourcePath, stagingDir);
    }
    if (locked.sourceUri) {
      database
        .prepare(
          `DELETE FROM media_metadata WHERE source_uri = ?
           AND EXISTS (
             SELECT 1 FROM staged_sources
             WHERE source_uri = ? AND claim_generation = ? AND source_path IS ?
           )`,
        )
        .run(locked.sourceUri, locked.sourceUri, locked.sourceGeneration, locked.sourcePath);
      database
        .prepare(
          `DELETE FROM staged_sources
           WHERE source_uri = ? AND claim_generation = ? AND source_path IS ?`,
        )
        .run(locked.sourceUri, locked.sourceGeneration, locked.sourcePath);
    }
    database
      .prepare(
        `UPDATE media_jobs
         SET status = 'ready', output_path = ?, source_path = NULL, error_code = NULL,
             processing_started_at = NULL, updated_at = ?, failed_at = NULL
         WHERE id = ? AND kind = 'clip' AND status = 'processing'
           AND claim_generation = ? AND output_path = ?`,
      )
      .run(outputPath, new Date().toISOString(), row.id, row.claimGeneration, outputPath);
    database.exec('COMMIT');
    onFinalized?.();
    return true;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function claimClipJob(
  database: RewindDatabase,
  row: ClipJobRow,
  workerAttemptCap?: number,
): ClipJobClaimResult {
  beginJobTransaction(database);
  try {
    const locked = readClipJob(database, row.id);
    if (!locked) {
      database.exec('ROLLBACK');
      return { claimed: false, reason: 'not_found' };
    }
    const processingStartedAt = locked.processingStartedAt
      ? Date.parse(locked.processingStartedAt)
      : Number.NaN;
    const stale =
      locked.status === 'processing' &&
      (!Number.isFinite(processingStartedAt) ||
        Date.now() - processingStartedAt >= PROCESSING_CLAIM_LEASE_MS);
    if (locked.status === 'processing' && !stale) {
      database.exec('ROLLBACK');
      return { claimed: false, reason: 'already_processing' };
    }
    if (!['pending', 'failed', 'processing'].includes(locked.status)) {
      database.exec('ROLLBACK');
      return { claimed: false, reason: 'not_claimable' };
    }
    if (
      Number.isSafeInteger(workerAttemptCap) &&
      Number(workerAttemptCap) >= 1 &&
      locked.status !== 'processing' &&
      locked.attemptCount >= Number(workerAttemptCap)
    ) {
      database.exec('ROLLBACK');
      return { claimed: false, reason: 'retry_exhausted' };
    }
    if (!stagedBindingMatches(database, locked)) {
      database.exec('ROLLBACK');
      return { claimed: false, reason: 'not_claimable' };
    }
    const startedAt = new Date().toISOString();
    const startsNewAttempt = locked.status === 'pending' || locked.status === 'failed';
    const result = database
      .prepare(
        `UPDATE media_jobs SET status = 'processing', error_code = NULL,
             processing_started_at = ?, updated_at = ?, failed_at = NULL,
             claim_generation = claim_generation + 1,
             attempt_count = attempt_count + CASE WHEN status IN ('pending', 'failed') THEN 1 ELSE 0 END
         WHERE id = ? AND kind = 'clip' AND status IN ('pending', 'failed', 'processing')
           AND (processing_started_at IS ? OR processing_started_at = ?)`,
      )
      .run(startedAt, startedAt, locked.id, locked.processingStartedAt, locked.processingStartedAt);
    if (Number(result.changes) !== 1) {
      database.exec('ROLLBACK');
      return { claimed: false, reason: 'already_processing' };
    }
    database.exec('COMMIT');
    return {
      claimed: true,
      row: {
        ...locked,
        status: 'processing',
        processingStartedAt: startedAt,
        claimGeneration: locked.claimGeneration + 1,
        attemptCount: locked.attemptCount + (startsNewAttempt ? 1 : 0),
      },
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function safeOutputName(jobId: string, claimGeneration: number): string {
  const suffix = createHash('sha256').update(jobId).digest('hex').slice(0, 24);
  return `clip-${suffix}-g${claimGeneration}.mp4`;
}

async function markFailed(
  database: RewindDatabase,
  row: ClipJobRow,
  outputPath: string,
  errorCode: string,
): Promise<boolean> {
  const failedAt = new Date().toISOString();
  beginJobTransaction(database);
  try {
    const current = readClipJob(database, row.id);
    if (
      !current ||
      current.status !== 'processing' ||
      current.claimGeneration !== row.claimGeneration ||
      (current.outputPath !== null && current.outputPath !== outputPath)
    ) {
      database.exec('ROLLBACK');
      return false;
    }
    // Hold the writer lock while removing this generation's private output so
    // a concurrent reclaim cannot make the cleanup target belong to it.
    await rm(outputPath, { force: true });
    const result = database
      .prepare(
        `UPDATE media_jobs
         SET status = 'failed', output_path = NULL, error_code = ?, processing_started_at = NULL,
             updated_at = ?, failed_at = ?
         WHERE id = ? AND kind = 'clip' AND status = 'processing' AND claim_generation = ?`,
      )
      .run(errorCode, failedAt, failedAt, row.id, row.claimGeneration);
    database.exec('COMMIT');
    return Number(result.changes) === 1;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/** Process one pending clip while preserving its established result shape. */
export function processClipJob(
  database: RewindDatabase,
  options: ProcessClipJobOptions,
): Promise<ProcessClipJobResult> {
  return processClipJobInternal(database, options);
}

/** @internal The worker observes claims separately from the request result. */
export function processClipJobForWorker(
  database: RewindDatabase,
  options: ProcessClipJobOptions,
  onWorkerWork: WorkerWorkObserver,
): Promise<ProcessClipJobResult> {
  return processClipJobInternal(database, options, onWorkerWork);
}

/**
 * Process one pending clip and retain only its transformed output on success.
 * The operation is claimable after a failure, so a transient FFmpeg or source
 * error leaves a retryable job instead of losing the contribution.
 */
async function processClipJobInternal(
  database: RewindDatabase,
  options: ProcessClipJobOptions,
  onWorkerWork?: WorkerWorkObserver,
): Promise<ProcessClipJobResult> {
  let row = readClipJob(database, options.jobId, options.groupId);
  if (!row) {
    return {
      ok: false,
      jobId: options.jobId,
      status: 'not_found',
      reason: 'not_found',
      message: 'The media job was not found.',
    };
  }
  if (row.status === 'ready') return { ok: true, jobId: row.id, status: 'ready' };
  const processingStartedAt = row.processingStartedAt
    ? Date.parse(row.processingStartedAt)
    : Number.NaN;
  const staleProcessing =
    row.status === 'processing' &&
    (!Number.isFinite(processingStartedAt) ||
      Date.now() - processingStartedAt >= PROCESSING_CLAIM_LEASE_MS);
  if (row.status === 'processing' && !staleProcessing) {
    return {
      ok: false,
      jobId: row.id,
      status: 'processing',
      reason: 'already_processing',
      message: 'The media job is already processing.',
    };
  }
  if (!['pending', 'failed', 'processing'].includes(row.status)) {
    return {
      ok: false,
      jobId: row.id,
      status: 'failed',
      reason: 'processing_failed',
      message: 'The media job cannot be processed in its current state.',
    };
  }

  const outputDir =
    options.outputDir ?? resolve(process.cwd(), '.local-data', 'media', 'processed');
  const stagingDir =
    options.stagingDir ?? resolve(process.cwd(), '.local-data', 'media', 'staging');
  // A stale worker may have already persisted the output marker. Finish that
  // hand-off first; rerunning FFmpeg would risk replacing a file while another
  // process is finalizing it.
  if (row.status === 'processing' && row.outputPath) {
    if (
      existsSync(row.outputPath) &&
      finalizePreparedOutput(database, row, stagingDir, row.outputPath, onWorkerWork)
    ) {
      return { ok: true, jobId: row.id, status: 'ready' };
    }
    row = readClipJob(database, options.jobId, options.groupId);
    if (!row || row.status === 'ready') return { ok: true, jobId: options.jobId, status: 'ready' };
  }
  const claim = claimClipJob(database, row, options.workerAttemptCap);
  if (!claim.claimed) {
    if (claim.reason === 'retry_exhausted') {
      return {
        ok: false,
        jobId: row.id,
        status: 'failed',
        reason: 'retry_exhausted',
        message: 'The clip is exhausted for automatic worker retries.',
      };
    }
    if (claim.reason === 'not_found') {
      return {
        ok: false,
        jobId: row.id,
        status: 'not_found',
        reason: 'not_found',
        message: 'The media job was not found.',
      };
    }
    if (claim.reason === 'not_claimable') {
      return {
        ok: false,
        jobId: row.id,
        status: 'failed',
        reason: 'processing_failed',
        message: 'The media job cannot be processed in its current state.',
      };
    }
    return {
      ok: false,
      jobId: row.id,
      status: 'processing',
      reason: 'already_processing',
      message: 'The media job is already processing.',
    };
  }
  row = claim.row;
  onWorkerWork?.();
  const outputPath =
    row.outputPath ?? resolve(outputDir, safeOutputName(row.id, row.claimGeneration));
  try {
    if (!row.sourcePath || row.trimStartSeconds === null || row.trimEndSeconds === null) {
      throw new FfmpegProcessingError(
        'invalid_metadata',
        'The clip processing metadata is invalid.',
      );
    }
    if (!stagedBindingMatches(database, row)) {
      throw new FfmpegProcessingError(
        'source_unavailable',
        'The temporary media source is unavailable.',
      );
    }
    const sourcePath = await resolveStagedMediaPath(row.sourcePath, stagingDir);
    await mkdir(outputDir, { recursive: true });
    await runAuditedJob(database, {
      jobId: row.id,
      actorMemberId: options.actorMemberId,
      run: async () => {
        await processClipWithFfmpeg(options.ffmpegBin, {
          inputPath: sourcePath,
          outputPath,
          trimStartSeconds: Number(row.trimStartSeconds),
          trimEndSeconds: Number(row.trimEndSeconds),
          mode: row.mode as CaptureMode,
        });
        if (!markOutputPrepared(database, row, outputPath)) {
          throw new FfmpegProcessingError(
            'source_unavailable',
            'The staged media source changed while processing.',
          );
        }
        if (!finalizePreparedOutput(database, row, stagingDir, outputPath)) {
          throw new FfmpegProcessingError(
            'source_unavailable',
            'The staged media source changed while finalizing.',
          );
        }
      },
    });
    return { ok: true, jobId: row.id, status: 'ready' };
  } catch (error) {
    // Failure recording and cleanup are fenced to this exact claim. A stale
    // worker must leave a reclaimed worker's state and private output alone.
    const errorCode = error instanceof FfmpegProcessingError ? error.code : 'cleanup_failed';
    await markFailed(database, row, outputPath, errorCode);
    return {
      ok: false,
      jobId: row.id,
      status: 'failed',
      reason: 'processing_failed',
      message: 'The clip could not be processed. Retry the job.',
    };
  }
}

export const processPendingClipJob = processClipJob;

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

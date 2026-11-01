// Film compilation jobs: input freezing, claiming, progress and processing.
import { createHash, randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RewindDatabase } from '../db';
import {
  decodeMediaRef,
  encodeMediaRef,
  isMediaRef,
  MediaStoreError,
  verifyStoredMedia,
  type MediaObjectRef,
  type MediaScope,
  type MediaStore,
} from '../media/store';
import { materializeStoredMedia, putProcessedFile } from '../media/store-files';
import {
  filePathMatchesIdentity,
  hashFile,
  hashFileWithIdentity,
  recordIntegrityFailure,
  type MediaIntegrityResult,
} from '../media/integrity';
import { compileFilmWithFfmpeg, probeClipWithFfmpeg, FfmpegProcessingError } from '../ffmpeg';
import { beginImmediate } from '../sqlite-busy';
import { PROCESSING_CLAIM_LEASE_MS, type WorkerWorkObserver } from './shared';
import { runAuditedJob } from './audited';
import { resolveProcessedMediaPath, storedContext, type StoredJobOptions } from './stored-output';

export type CompilationJobStatus = 'pending' | 'processing' | 'ready' | 'failed';

/** Three explicit compile attempts prevent a broken cycle from retrying forever. */
export const MAX_COMPILATION_ATTEMPTS = 3;

/** A one-clip cycle gets one clearly labelled clip from its own group's archive. */
const ARCHIVE_FILLER_MINIMUM_CLIP_COUNT = 2;

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
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'retry_exhausted' | 'waiting_for_inputs' };

export interface ClaimCompilationJobInput {
  jobId: string;
  groupId?: string;
  now?: Date | string;
  leaseMs?: number;
  /** Processing entry points settle/freeze accepted inputs; low-level lease callers retain their contract. */
  requireSettledInputs?: boolean;
  clipAttemptCap?: number;
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
                    AND c.deleted_at IS NULL AND c.removed_at IS NULL
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
  beginImmediate(database);
  try {
    const job = reconcileCompilationJobInputsLocked(database, jobId);
    database.exec(job ? 'COMMIT' : 'ROLLBACK');
    return job;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function eligibleCompilationInputs(
  database: RewindDatabase,
  input: CompilationJobInput,
): { clipJobId: string; contributionId: string }[] {
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
         AND c.deleted_at IS NULL AND c.removed_at IS NULL
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
               AND c.deleted_at IS NULL AND c.removed_at IS NULL
               AND clip.source_path IS NULL
               AND clip.output_path IS NOT NULL
             ORDER BY cy.release_published_at DESC, c.created_at DESC, c.id DESC, clip.id DESC
             LIMIT 1`,
          )
          .get(input.groupId, input.cycleId) as
          { clipJobId: string; contributionId: string } | undefined)
      : undefined;
  return archiveFiller ? [...currentCycleClips, archiveFiller] : currentCycleClips;
}

export const ACCEPTED_CLIP_AUTOMATIC_ATTEMPTS = 3;

function acceptedCompilationInputs(
  database: RewindDatabase,
  job: CompilationJobRecord,
  clipAttemptCap = ACCEPTED_CLIP_AUTOMATIC_ATTEMPTS,
): { state: 'waiting' | 'ready' | 'unavailable'; clipJobIds: string[] } {
  const rows = database
    .prepare(
      `SELECT clip.id, clip.status, clip.attempt_count AS attempts,
    clip.source_path AS sourcePath, clip.output_path AS outputPath
    FROM contributions c JOIN cycles cy ON cy.id = c.cycle_id AND cy.group_id = ?
    LEFT JOIN media_jobs clip ON clip.contribution_id = c.id AND clip.kind = 'clip'
      AND clip.group_id = cy.group_id AND clip.deleted_at IS NULL
    WHERE c.cycle_id = ? AND c.deleted_at IS NULL AND c.removed_at IS NULL
    ORDER BY c.created_at, c.id, clip.id`,
    )
    .all(job.groupId, job.cycleId) as {
    id: string | null;
    status: string | null;
    attempts: number;
    sourcePath: string | null;
    outputPath: string | null;
  }[];
  // A missing/exhausted accepted input takes precedence over ordinary queue wait.
  if (
    rows.some(
      (row) =>
        !row.id ||
        !['ready', 'pending', 'processing', 'failed'].includes(row.status ?? '') ||
        (row.status === 'failed' && row.attempts >= clipAttemptCap) ||
        (row.status === 'ready' && (row.sourcePath !== null || !row.outputPath)),
    )
  )
    return { state: 'unavailable', clipJobIds: [] };
  if (rows.some((row) => row.status !== 'ready')) return { state: 'waiting', clipJobIds: [] };
  return { state: 'ready', clipJobIds: rows.map((row) => row.id!) };
}

function frozenCompilationInputsComplete(
  database: RewindDatabase,
  job: CompilationJobRecord,
): boolean {
  const accepted = acceptedCompilationInputs(database, job);
  return (
    accepted.state === 'ready' && accepted.clipJobIds.every((id) => job.clipJobIds.includes(id))
  );
}

function freezeSettledCompilationInputsLocked(
  database: RewindDatabase,
  job: CompilationJobRecord,
): void {
  const inputs = eligibleCompilationInputs(database, {
    groupId: job.groupId,
    cycleId: job.cycleId,
  });
  database.prepare('DELETE FROM compilation_job_inputs WHERE job_id = ?').run(job.id);
  const insert = database.prepare(
    'INSERT INTO compilation_job_inputs (job_id, clip_job_id, contribution_id, position) VALUES (?, ?, ?, ?)',
  );
  inputs.forEach((clip, position) =>
    insert.run(job.id, clip.clipJobId, clip.contributionId, position),
  );
  database
    .prepare(
      'UPDATE media_jobs SET input_count = ?, completed_count = 0, progress = 0 WHERE id = ?',
    )
    .run(inputs.length, job.id);
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

  const eligible = eligibleCompilationInputs(database, input);
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
  beginImmediate(database);
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
  beginImmediate(database);
  try {
    let job = readCompilationJob(database, input.jobId, input.groupId);
    if (!job) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    if (input.requireSettledInputs && job.status !== 'ready') {
      const accepted = acceptedCompilationInputs(database, job, input.clipAttemptCap);
      if (accepted.state === 'waiting') {
        database.exec('COMMIT');
        return { ok: false, reason: 'waiting_for_inputs' };
      }
      if (accepted.state === 'ready' && job.claimGeneration === 0)
        freezeSettledCompilationInputsLocked(database, job);
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
  beginImmediate(database);
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
      reason:
        | 'not_found'
        | 'already_processing'
        | 'processing_failed'
        | 'retry_exhausted'
        | 'waiting_for_inputs';
      message: string;
    };

export interface ProcessCompilationJobOptions extends StoredJobOptions {
  clipAttemptCap?: number;
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
  sha256: string | null;
  byteLength: number | null;
}

function filmOutputName(jobId: string, claimGeneration: number): string {
  const suffix = createHash('sha256').update(jobId).digest('hex').slice(0, 24);
  return `film-${suffix}-g${claimGeneration}.mp4`;
}

function readCompilationInputOutputs(
  database: RewindDatabase,
  jobId: string,
): CompilationInputOutput[] {
  return database
    .prepare(
      `SELECT i.clip_job_id AS clipJobId, clip.output_path AS outputPath,
              clip.output_sha256 AS sha256, clip.output_bytes AS byteLength,
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
      sha256: (row as { sha256?: string | null }).sha256
        ? String((row as { sha256?: string | null }).sha256)
        : null,
      byteLength:
        (row as { byteLength?: number | null }).byteLength === null ||
        (row as { byteLength?: number | null }).byteLength === undefined
          ? null
          : Number((row as { byteLength?: number | null }).byteLength),
    }));
}

/**
 * Verify each retained film input against its persisted clip digest. Rows
 * finalized before #157 have no recorded digest; those are unverifiable and
 * are compiled from the retained bytes as before rather than being blocked.
 */
async function firstFailingInput(
  inputs: CompilationInputOutput[],
  inputPaths: string[],
): Promise<{ clipJobId: string; result: MediaIntegrityResult } | null> {
  for (const [index, input] of inputs.entries()) {
    if (!input.sha256 || input.byteLength === null || input.byteLength <= 0) continue;
    const observed = await hashFile(inputPaths[index]);
    if (!observed) {
      return {
        clipJobId: input.clipJobId,
        result: {
          outcome: 'unavailable',
          expectedSha256: input.sha256,
          expectedByteLength: input.byteLength,
          observedSha256: null,
          observedByteLength: null,
        },
      };
    }
    if (observed.byteLength !== input.byteLength || observed.sha256 !== input.sha256) {
      return {
        clipJobId: input.clipJobId,
        result: {
          outcome: 'mismatch',
          expectedSha256: input.sha256,
          expectedByteLength: input.byteLength,
          observedSha256: observed.sha256,
          observedByteLength: observed.byteLength,
        },
      };
    }
  }
  return null;
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
           output_sha256 = NULL, output_bytes = NULL, output_verified_at = NULL,
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
async function publishCompilationOutput(
  database: RewindDatabase,
  job: CompilationJobRecord,
  expectedClipJobIds: string[],
  temporaryOutputPath: string,
  finalOutputPath: string,
  stored?: { ref: MediaObjectRef; store: MediaStore; scope: MediaScope },
): Promise<boolean> {
  // FFmpeg has closed this unique temp file. Hash it before taking SQLite's
  // writer lock; the short publication transaction checks the same inode and
  // atomically renames it while applying the job-generation fence.
  const integrity = await hashFileWithIdentity(temporaryOutputPath);
  if (!integrity) return false;
  if (stored) await verifyStoredMedia(stored.store, stored.scope, stored.ref, integrity);
  beginImmediate(database);
  try {
    const current = reconcileCompilationJobInputsLocked(database, job.id);
    if (
      !current ||
      current.status !== 'processing' ||
      current.claimGeneration !== job.claimGeneration ||
      current.inputCount === 0 ||
      !frozenCompilationInputsComplete(database, current) ||
      current.clipJobIds.length !== expectedClipJobIds.length ||
      current.clipJobIds.some((id, index) => id !== expectedClipJobIds[index])
    ) {
      database.exec('ROLLBACK');
      return false;
    }
    if (!filePathMatchesIdentity(temporaryOutputPath, integrity.identity)) {
      database.exec('ROLLBACK');
      return false;
    }
    if (!stored) renameSync(temporaryOutputPath, finalOutputPath);
    const finalizedAt = new Date().toISOString();
    const result = database
      .prepare(
        `UPDATE media_jobs
         SET status = 'ready', output_path = ?, completed_count = input_count, progress = 100,
             error_code = NULL, processing_started_at = NULL, updated_at = ?, failed_at = NULL,
             output_sha256 = ?, output_bytes = ?, output_verified_at = ?
         WHERE id = ? AND kind = 'film' AND status = 'processing' AND claim_generation = ?`,
      )
      .run(
        stored ? encodeMediaRef(stored.ref) : finalOutputPath,
        finalizedAt,
        integrity.sha256,
        integrity.byteLength,
        finalizedAt,
        job.id,
        job.claimGeneration,
      );
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
  const claim = claimCompilationJob(database, {
    jobId: options.jobId,
    groupId: options.groupId,
    requireSettledInputs: true,
    clipAttemptCap: options.clipAttemptCap,
  });
  if (!claim.ok) {
    if (claim.reason === 'waiting_for_inputs')
      return {
        ok: false,
        jobId: options.jobId,
        status: 'processing',
        reason: 'waiting_for_inputs',
        message: 'The film is waiting for accepted clips to settle.',
      };
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
  const finalOutputPath = resolve(
    outputDir,
    filmOutputName(claim.job.id, claim.job.claimGeneration),
  );
  const temporaryOutputPath = resolve(
    outputDir,
    `.${filmOutputName(claim.job.id, claim.job.claimGeneration)}.${randomUUID()}.part.mp4`,
  );
  const snapshots: { dispose: () => Promise<void> }[] = [];
  let storedOutput: MediaObjectRef | undefined;
  let published = false;
  try {
    if (!frozenCompilationInputsComplete(database, claim.job))
      throw new FfmpegProcessingError(
        'source_unavailable',
        'An accepted clip is unavailable or absent from the frozen film inputs.',
      );
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
    const inputPaths: string[] = [];
    for (const input of inputs) {
      inputPaths.push(
        await (async () => {
          if (!isMediaRef(input.outputPath))
            return resolveProcessedMediaPath(input.outputPath, outputDir);
          const { store, scope } = storedContext(options, claim.job.groupId);
          const ref = decodeMediaRef(input.outputPath);
          if (
            ref.prefix !== 'processed' ||
            input.sha256 !== ref.sha256 ||
            input.byteLength !== ref.byteLength
          )
            throw new MediaStoreError('integrity_mismatch');
          const snapshot = await materializeStoredMedia(store, scope, ref, outputDir);
          snapshots.push(snapshot);
          return snapshot.path;
        })(),
      );
    }
    // A film is only as trustworthy as the clips it joins. Verify each
    // retained input against the digest persisted when that clip finalized,
    // so a tampered or truncated clip cannot be compiled into a "verified"
    // film under a fresh legitimate checksum.
    const unavailableInput = await firstFailingInput(inputs, inputPaths);
    if (unavailableInput) {
      recordIntegrityFailure(database, {
        jobId: unavailableInput.clipJobId,
        kind: 'clip',
        result: unavailableInput.result,
        actorMemberId: options.actorMemberId,
      });
      throw new FfmpegProcessingError(
        'source_unavailable',
        'A processed clip no longer matches its finalized integrity record.',
      );
    }
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
        const context = options.mediaStore ? storedContext(options, claim.job.groupId) : undefined;
        if (context)
          storedOutput = await putProcessedFile(
            context.store,
            context.scope,
            temporaryOutputPath,
            'films',
          );
        if (
          !(await publishCompilationOutput(
            database,
            claim.job,
            claim.job.clipJobIds,
            temporaryOutputPath,
            finalOutputPath,
            context && storedOutput ? { ...context, ref: storedOutput } : undefined,
          ))
        ) {
          throw new FfmpegProcessingError(
            'source_unavailable',
            'The film inputs changed while finalizing.',
          );
        }
        published = true;
      },
    });
    return { ok: true, jobId: claim.job.id, status: 'ready' };
  } catch (error) {
    await rm(temporaryOutputPath, { force: true }).catch(() => undefined);
    if (getCompilationJob(database, claim.job.id)?.status !== 'ready') {
      // The durable path is unique to this claim generation, so a stale
      // worker can clean its own output without unlinking a reclaimed worker's.
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
  } finally {
    for (const snapshot of snapshots) await snapshot.dispose();
    await rm(temporaryOutputPath, { force: true });
    if (storedOutput && !published) {
      const { store, scope } = storedContext(options, claim.job.groupId);
      await store.delete(scope, storedOutput).catch(() => undefined);
    }
  }
}

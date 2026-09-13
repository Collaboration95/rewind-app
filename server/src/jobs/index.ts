import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
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
  processClipWithFfmpeg,
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
}

export type CompilationJobStatus = 'pending' | 'processing' | 'ready' | 'failed';

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
  | { ok: false; reason: 'not_found' | 'invalid_state' };

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
              claim_generation AS claimGeneration,
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

  const eligible = database
    .prepare(
      `SELECT clip.id AS clipJobId, c.id AS contributionId
       FROM contributions c
       JOIN cycles cy ON cy.id = c.cycle_id AND cy.group_id = ?
       JOIN media_jobs clip
         ON clip.contribution_id = c.id AND clip.group_id = cy.group_id
        AND clip.kind = 'clip' AND clip.status = 'ready'
       WHERE c.cycle_id = ?
         -- A ready clip has completed processing only when its raw staged
         -- path is no longer retained. No source path is copied to the film
         -- job or its input snapshot.
         AND clip.source_path IS NULL
         AND clip.output_path IS NOT NULL
       ORDER BY c.created_at ASC, c.id ASC, clip.id ASC`,
    )
    .all(input.groupId, input.cycleId) as { clipJobId: string; contributionId: string }[];
  const createdAt = new Date(input.createdAt ?? new Date());
  if (!Number.isFinite(createdAt.getTime())) return null;
  const jobId = compilationJobId(input.groupId, input.cycleId);
  database
    .prepare(
      `INSERT INTO media_jobs
        (id, group_id, contribution_id, kind, status, output_path, created_at,
         idempotency_key, cycle_id, progress, input_count, completed_count,
         claim_generation, processing_started_at)
       VALUES (?, ?, NULL, 'film', 'pending', NULL, ?, NULL, ?, 0, ?, 0, 0, NULL)`,
    )
    .run(jobId, input.groupId, createdAt.toISOString(), input.cycleId, eligible.length);
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
    const generation = job.claimGeneration + 1;
    database
      .prepare(
        `UPDATE media_jobs
         SET status = 'processing', error_code = NULL,
             processing_started_at = ?, claim_generation = ?
         WHERE id = ? AND kind = 'film' AND status IN ('pending', 'failed', 'processing')`,
      )
      .run(now.toISOString(), generation, job.id);
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
  const completedCount = Math.max(0, Math.floor(input.completedCount));
  if (!Number.isSafeInteger(input.claimGeneration) || completedCount !== input.completedCount)
    return null;
  const current = readCompilationJob(database, input.jobId);
  if (
    !current ||
    current.status !== 'processing' ||
    current.claimGeneration !== input.claimGeneration ||
    completedCount < current.completedCount ||
    completedCount > current.inputCount
  )
    return null;
  if (
    input.progress !== undefined &&
    (!Number.isFinite(input.progress) || !Number.isSafeInteger(input.progress))
  )
    return null;
  const progress =
    input.progress === undefined
      ? current.inputCount === 0
        ? 0
        : Math.floor((completedCount / current.inputCount) * 100)
      : Math.max(0, Math.min(100, Math.floor(input.progress)));
  if (progress < current.progress) return null;
  database
    .prepare(
      `UPDATE media_jobs SET completed_count = ?, progress = ?
       WHERE id = ? AND kind = 'film' AND status = 'processing' AND claim_generation = ?`,
    )
    .run(completedCount, progress, input.jobId, input.claimGeneration);
  return readCompilationJob(database, input.jobId);
}

/** A worker claim is recoverable after a process dies without completing it. */
export const PROCESSING_CLAIM_LEASE_MS = 15 * 60 * 1000;

export type ProcessClipJobResult =
  | { ok: true; jobId: string; status: 'ready' }
  | {
      ok: false;
      jobId: string;
      status: 'failed' | 'processing' | 'not_found';
      reason: 'not_found' | 'already_processing' | 'processing_failed';
      message: string;
    };

interface ClipJobRow {
  id: string;
  status: string;
  outputPath: string | null;
  sourceUri: string | null;
  sourceGeneration: number | null;
  sourcePath: string | null;
  trimStartSeconds: number | null;
  trimEndSeconds: number | null;
  mode: string | null;
  processingStartedAt: string | null;
}

function readClipJob(database: RewindDatabase, jobId: string, groupId?: string): ClipJobRow | null {
  const row = database
    .prepare(
      `SELECT id, status, output_path AS outputPath, source_uri AS sourceUri,
              source_generation AS sourceGeneration, source_path AS sourcePath,
              trim_start_seconds AS trimStartSeconds,
              trim_end_seconds AS trimEndSeconds, mode,
              processing_started_at AS processingStartedAt
       FROM media_jobs
       WHERE id = ? AND kind = 'clip' ${groupId ? 'AND group_id = ?' : ''}`,
    )
    .get(...(groupId ? [jobId, groupId] : [jobId])) as ClipJobRow | undefined;
  return row ?? null;
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
        `UPDATE media_jobs SET output_path = ?, error_code = NULL
         WHERE id = ? AND kind = 'clip' AND status = 'processing'
           AND (output_path IS NULL OR output_path = ?)`,
      )
      .run(outputPath, row.id, outputPath);
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
             processing_started_at = NULL
         WHERE id = ? AND kind = 'clip' AND status = 'processing'
           AND output_path = ?`,
      )
      .run(outputPath, row.id, outputPath);
    database.exec('COMMIT');
    return true;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function claimClipJob(database: RewindDatabase, row: ClipJobRow): ClipJobRow | null {
  beginJobTransaction(database);
  try {
    const locked = readClipJob(database, row.id);
    if (!locked) {
      database.exec('ROLLBACK');
      return null;
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
      return null;
    }
    if (!['pending', 'failed', 'processing'].includes(locked.status)) {
      database.exec('ROLLBACK');
      return null;
    }
    if (!stagedBindingMatches(database, locked)) {
      database.exec('ROLLBACK');
      return null;
    }
    const result = database
      .prepare(
        `UPDATE media_jobs SET status = 'processing', error_code = NULL,
             processing_started_at = ?
         WHERE id = ? AND kind = 'clip' AND status IN ('pending', 'failed', 'processing')
           AND (processing_started_at IS ? OR processing_started_at = ?)`,
      )
      .run(
        new Date().toISOString(),
        locked.id,
        locked.processingStartedAt,
        locked.processingStartedAt,
      );
    if (Number(result.changes) !== 1) {
      database.exec('ROLLBACK');
      return null;
    }
    database.exec('COMMIT');
    return { ...locked, status: 'processing', processingStartedAt: new Date().toISOString() };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function safeOutputName(jobId: string): string {
  const suffix = createHash('sha256').update(jobId).digest('hex').slice(0, 24);
  return `clip-${suffix}.mp4`;
}

function markFailed(database: RewindDatabase, jobId: string, errorCode: string): void {
  database
    .prepare(
      `UPDATE media_jobs
       SET status = 'failed', output_path = NULL, error_code = ?, processing_started_at = NULL
       WHERE id = ? AND kind = 'clip' AND status = 'processing'`,
    )
    .run(errorCode, jobId);
}

/**
 * Process one pending clip and retain only its transformed output on success.
 * The operation is claimable after a failure, so a transient FFmpeg or source
 * error leaves a retryable job instead of losing the contribution.
 */
export async function processClipJob(
  database: RewindDatabase,
  options: ProcessClipJobOptions,
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
      finalizePreparedOutput(database, row, stagingDir, row.outputPath)
    ) {
      return { ok: true, jobId: row.id, status: 'ready' };
    }
    row = readClipJob(database, options.jobId, options.groupId);
    if (!row || row.status === 'ready') return { ok: true, jobId: options.jobId, status: 'ready' };
  }
  const claim = claimClipJob(database, row);
  if (!claim) {
    return {
      ok: false,
      jobId: row.id,
      status: 'processing',
      reason: 'already_processing',
      message: 'The media job is already processing.',
    };
  }
  row = claim;
  const outputPath = row.outputPath ?? resolve(outputDir, safeOutputName(row.id));
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
    // A competing stale worker may have completed the durable finalization
    // after this worker observed a binding change. Never delete an output
    // that is already committed as ready.
    if (readClipJob(database, row.id)?.status !== 'ready') {
      await rm(outputPath, { force: true }).catch(() => undefined);
    }
    const errorCode = error instanceof FfmpegProcessingError ? error.code : 'cleanup_failed';
    markFailed(database, row.id, errorCode);
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
    const sourceId = (sourceMatch ?? partialMatch)?.[1];
    const staged = sourceId ? findStagedSource(database, `staged://${sourceId}`) : null;
    // A live intake lease protects both its final path and any random-suffix
    // partial path. Cleanup may remove an expired claim, but its generation
    // fence prevents the old request from touching a later reclaim.
    if (
      staged &&
      staged.status === 'pending' &&
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
             AND (source_path = ? OR source_uri = ?)
           LIMIT 1`,
        )
        .get(sourcePath, sourceId ? `staged://${sourceId}` : null);
      if (active) continue;
    }
    if (sourceMatch && staged) {
      // This helper takes the writer lock, verifies the current row, and
      // removes the capability and path as one mutation. It is intentionally
      // generation/lease-aware instead of deleting by URI blindly.
      const before = await stat(sourcePath).catch(() => null);
      cleanupStagedSource(database, `staged://${sourceId}`, stagingDir);
      const after = await stat(sourcePath).catch(() => null);
      if (before && !after) removed += 1;
      continue;
    }
    const protectedPath = partialMatch ? sourcePath.replace(/\.[a-f0-9-]+\.part$/, '') : sourcePath;
    const removedFile = cleanupUnclaimedStagedPath(database, sourcePath, stagingDir, protectedPath);
    if (!removedFile) continue;
    if (sourceMatch) {
      const sourceUri = `staged://${sourceMatch[1]}`;
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
      `SELECT source_uri AS sourceUri FROM staged_sources
       WHERE status = 'pending' AND created_at < ?
         AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
         AND NOT EXISTS (
           SELECT 1 FROM media_jobs WHERE media_jobs.source_path = staged_sources.source_path
         )`,
    )
    .all(cutoff, new Date().toISOString()) as { sourceUri?: string }[];
  for (const row of stale) {
    if (removed >= boundedLimit || !row.sourceUri) break;
    const before = findStagedSource(database, row.sourceUri);
    cleanupStagedSource(database, row.sourceUri, stagingDir);
    if (!findStagedSource(database, row.sourceUri) && before) removed += 1;
  }
  return removed;
}

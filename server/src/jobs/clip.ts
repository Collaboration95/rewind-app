// Clip jobs: claiming, processing, finalising and the private-media branch.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
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
} from '../media/store';
import { materializeStoredMedia, putProcessedFile } from '../media/store-files';
import { findStagedSource, cleanupStagedSourcePath } from '../media';
import { filePathMatchesIdentity, hashFileWithIdentity } from '../media/integrity';
import {
  processClipWithFfmpeg,
  processPhotoWithFfmpeg,
  probeClipWithFfmpeg,
  resolveStagedMediaPath,
  type ProcessingMode,
  FfmpegProcessingError,
} from '../ffmpeg';
import { beginImmediate } from '../sqlite-busy';
import { PROCESSING_CLAIM_LEASE_MS, type WorkerWorkObserver } from './shared';
import { runAuditedJob, recordJobStarted, recordJobCompleted, recordJobFailed } from './audited';
import { storedContext, type StoredJobOptions } from './stored-output';

export interface ProcessClipJobOptions extends StoredJobOptions {
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
  groupId: string;
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
  mediaType: 'video' | 'photo';
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
      `SELECT id, group_id AS groupId, status, claim_generation AS claimGeneration,
              output_path AS outputPath, source_uri AS sourceUri,
              source_generation AS sourceGeneration, source_path AS sourcePath,
              trim_start_seconds AS trimStartSeconds,
              trim_end_seconds AS trimEndSeconds, mode,
              processing_started_at AS processingStartedAt,
              attempt_count AS attemptCount, media_type AS mediaType
       FROM media_jobs
       WHERE id = ? AND kind = 'clip' ${groupId ? 'AND group_id = ?' : ''}`,
    )
    .get(...(groupId ? [jobId, groupId] : [jobId])) as ClipJobRow | undefined;
  return row ? { ...row, claimGeneration: Number(row.claimGeneration) } : null;
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
  beginImmediate(database);
  try {
    const locked = readClipJob(database, row.id);
    if (
      !locked ||
      locked.status !== 'processing' ||
      locked.claimGeneration !== row.claimGeneration ||
      locked.processingStartedAt !== row.processingStartedAt ||
      locked.sourcePath !== row.sourcePath ||
      locked.sourceUri !== row.sourceUri ||
      locked.sourceGeneration !== row.sourceGeneration ||
      !stagedBindingMatches(database, locked)
    ) {
      database.exec('ROLLBACK');
      return false;
    }
    const result = database
      .prepare(
        `UPDATE media_jobs SET output_path = ?, error_code = NULL, updated_at = ?
         WHERE id = ? AND kind = 'clip' AND status = 'processing'
           AND claim_generation = ? AND processing_started_at = ?
           AND (output_path IS NULL OR output_path = ?)`,
      )
      .run(
        outputPath,
        new Date().toISOString(),
        row.id,
        row.claimGeneration,
        row.processingStartedAt,
        outputPath,
      );
    database.exec('COMMIT');
    return Number(result.changes) === 1;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/** Hash a prepared output outside the writer lock, then atomically publish
 * that same inode while validating the current claim and staged-source fence.
 * A crash after rename but before COMMIT leaves an unpublished orphan; a
 * retry writes a new unique temp file and resumes safely. */
async function finalizePreparedOutput(
  database: RewindDatabase,
  row: ClipJobRow,
  stagingDir: string,
  outputPath: string,
  finalOutputPath: string,
  onFinalized?: WorkerWorkObserver,
): Promise<boolean> {
  const integrity = await hashFileWithIdentity(outputPath);
  if (!integrity) return false;
  beginImmediate(database);
  try {
    const locked = readClipJob(database, row.id);
    if (!locked || locked.status === 'ready') {
      database.exec('COMMIT');
      return (
        locked?.status === 'ready' &&
        locked.claimGeneration === row.claimGeneration &&
        locked.outputPath === finalOutputPath
      );
    }
    if (
      locked.status !== 'processing' ||
      locked.claimGeneration !== row.claimGeneration ||
      locked.outputPath !== outputPath ||
      locked.processingStartedAt !== row.processingStartedAt ||
      locked.sourcePath !== row.sourcePath ||
      locked.sourceUri !== row.sourceUri ||
      locked.sourceGeneration !== row.sourceGeneration ||
      !stagedBindingMatches(database, locked) ||
      !filePathMatchesIdentity(outputPath, integrity.identity)
    ) {
      database.exec('ROLLBACK');
      return false;
    }
    // New workers write unique .part files; rename the hashed inode to its
    // deterministic ready path while the publication fence is held. Legacy
    // markers already at their final path remain supported.
    const publishedPath = outputPath.endsWith('.part.mp4') ? finalOutputPath : outputPath;
    if (publishedPath !== outputPath) renameSync(outputPath, publishedPath);
    const finalizedAt = new Date().toISOString();
    const result = database
      .prepare(
        `UPDATE media_jobs
         SET status = 'ready', output_path = ?, source_path = NULL, error_code = NULL,
             output_sha256 = ?, output_bytes = ?, output_verified_at = ?,
             processing_started_at = NULL, updated_at = ?, failed_at = NULL
         WHERE id = ? AND kind = 'clip' AND status = 'processing'
           AND claim_generation = ? AND output_path = ? AND processing_started_at = ?`,
      )
      .run(
        publishedPath,
        integrity.sha256,
        integrity.byteLength,
        finalizedAt,
        finalizedAt,
        row.id,
        row.claimGeneration,
        outputPath,
        row.processingStartedAt,
      );
    if (Number(result.changes) !== 1) {
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
  beginImmediate(database);
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
  finalOutputPath: string,
  errorCode: string,
): Promise<boolean> {
  const failedAt = new Date().toISOString();
  beginImmediate(database);
  try {
    const current = readClipJob(database, row.id);
    if (
      !current ||
      current.status !== 'processing' ||
      current.claimGeneration !== row.claimGeneration
    ) {
      database.exec('ROLLBACK');
      return false;
    }
    // The claim token is checked while holding the writer lock. This output
    // path is private to this invocation; remove the shared published path
    // only while this same generation still owns the processing row.
    await rm(outputPath, { force: true }).catch(() => undefined);
    await rm(finalOutputPath, { force: true }).catch(() => undefined);
    const result = database
      .prepare(
        `UPDATE media_jobs
         SET status = 'failed', output_path = NULL, error_code = ?, processing_started_at = NULL,
             output_sha256 = NULL, output_bytes = NULL, output_verified_at = NULL,
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
  if (row.sourcePath && isMediaRef(row.sourcePath))
    return processStoredClip(database, row, options, outputDir, onWorkerWork);
  let finalOutputPath = resolve(outputDir, safeOutputName(row.id, row.claimGeneration));
  // A stale worker may have already persisted the output marker. Finish that
  // hand-off first; rerunning FFmpeg would risk replacing a file while another
  // process is finalizing it.
  if (row.status === 'processing' && row.outputPath) {
    if (
      existsSync(row.outputPath) &&
      (await finalizePreparedOutput(
        database,
        row,
        stagingDir,
        row.outputPath,
        finalOutputPath,
        onWorkerWork,
      ))
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
  finalOutputPath = resolve(outputDir, safeOutputName(row.id, row.claimGeneration));
  onWorkerWork?.();
  // Each claim writes a distinct temp inode. A stale worker can therefore not
  // mutate bytes while a newer claim hashes or publishes its output.
  const outputPath = resolve(
    outputDir,
    `.${safeOutputName(row.id, row.claimGeneration)}.${randomUUID()}.part.mp4`,
  );
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
        if (row.mediaType === 'photo') {
          await processPhotoWithFfmpeg(options.ffmpegBin, {
            inputPath: sourcePath,
            outputPath,
            mode: row.mode as ProcessingMode,
          });
        } else {
          await processClipWithFfmpeg(options.ffmpegBin, {
            inputPath: sourcePath,
            outputPath,
            trimStartSeconds: Number(row.trimStartSeconds),
            trimEndSeconds: Number(row.trimEndSeconds),
            mode: row.mode as ProcessingMode,
          });
        }
        if (!markOutputPrepared(database, row, outputPath)) {
          throw new FfmpegProcessingError(
            'source_unavailable',
            'The staged media source changed while processing.',
          );
        }
        if (
          !(await finalizePreparedOutput(
            database,
            row,
            stagingDir,
            outputPath,
            finalOutputPath,
            onWorkerWork,
          ))
        ) {
          throw new FfmpegProcessingError(
            'source_unavailable',
            'The staged media source changed while finalizing.',
          );
        }
      },
    });
    return { ok: true, jobId: row.id, status: 'ready' };
  } catch (error) {
    const errorCode = error instanceof FfmpegProcessingError ? error.code : 'cleanup_failed';
    const ownedFailure = await markFailed(database, row, outputPath, finalOutputPath, errorCode);
    if (!ownedFailure) {
      // Each invocation has a unique private part path, so removing that
      // abandoned file cannot affect the output published by a later claim.
      await rm(outputPath, { force: true }).catch(() => undefined);
    }
    return {
      ok: false,
      jobId: row.id,
      status: 'failed',
      reason: 'processing_failed',
      message: 'The clip could not be processed. Retry the job.',
    };
  }
}

function storedClipFence(database: RewindDatabase, row: ClipJobRow, output: string): boolean {
  const current = readClipJob(database, row.id);
  return Boolean(
    current &&
    current.status === 'processing' &&
    current.claimGeneration === row.claimGeneration &&
    current.processingStartedAt === row.processingStartedAt &&
    current.sourcePath === row.sourcePath &&
    current.sourceUri === row.sourceUri &&
    current.sourceGeneration === row.sourceGeneration &&
    current.outputPath === output &&
    stagedBindingMatches(database, current),
  );
}

/** A committed prepared ref survives deletion/COMMIT crashes. Cleanup retries
 * verify that output first, and never fall back to the current object version. */
async function finalizeStoredClip(
  database: RewindDatabase,
  row: ClipJobRow,
  options: StoredJobOptions,
  output: MediaObjectRef,
): Promise<boolean> {
  const context = storedContext(options, row.groupId);
  if (output.prefix !== 'processed') throw new MediaStoreError('invalid_ref');
  await verifyStoredMedia(context.store, context.scope, output, output);
  const encoded = encodeMediaRef(output);
  if (!storedClipFence(database, row, encoded)) return false;
  const source = decodeMediaRef(row.sourcePath ?? '');
  if (source.prefix !== 'incoming') throw new MediaStoreError('invalid_ref');
  // No SQLite transaction is held over network I/O. A stale invocation can only
  // delete this exact accepted version, with its verified output already durable.
  await context.store.delete(context.scope, source);
  beginImmediate(database);
  try {
    if (!storedClipFence(database, row, encoded)) {
      database.exec('ROLLBACK');
      return false;
    }
    const now = new Date().toISOString();
    database
      .prepare(
        `UPDATE media_jobs SET status = 'ready', source_path = NULL,
      output_sha256 = ?, output_bytes = ?, output_verified_at = ?, error_code = NULL,
      processing_started_at = NULL, updated_at = ?, failed_at = NULL WHERE id = ?`,
      )
      .run(output.sha256, output.byteLength, now, now, row.id);
    if (row.sourceUri) {
      database.prepare('DELETE FROM media_metadata WHERE source_uri = ?').run(row.sourceUri);
      database
        .prepare(
          'DELETE FROM staged_sources WHERE source_uri = ? AND claim_generation = ? AND source_path IS ?',
        )
        .run(row.sourceUri, row.sourceGeneration, row.sourcePath);
    }
    database.exec('COMMIT');
    return true;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

async function processStoredClip(
  database: RewindDatabase,
  row: ClipJobRow,
  options: ProcessClipJobOptions,
  outputDir: string,
  onWorkerWork?: WorkerWorkObserver,
): Promise<ProcessClipJobResult> {
  const claim = claimClipJob(database, row, options.workerAttemptCap);
  if (!claim.claimed)
    return {
      ok: false,
      jobId: row.id,
      status: claim.reason === 'already_processing' ? 'processing' : 'failed',
      reason:
        claim.reason === 'retry_exhausted'
          ? 'retry_exhausted'
          : claim.reason === 'already_processing'
            ? 'already_processing'
            : 'processing_failed',
      message: 'The media job cannot be claimed.',
    };
  row = claim.row;
  onWorkerWork?.();
  let output: MediaObjectRef | undefined;
  let prepared = Boolean(row.outputPath && isMediaRef(row.outputPath));
  let snapshot: { dispose: () => Promise<void> } | undefined;
  const temp = resolve(
    outputDir,
    `.${safeOutputName(row.id, row.claimGeneration)}.${randomUUID()}.part.mp4`,
  );
  recordJobStarted(database, row.id, options.actorMemberId);
  try {
    const { store, scope } = storedContext(options, row.groupId);
    if (prepared) output = decodeMediaRef(row.outputPath!);
    else {
      if (row.trimStartSeconds === null || row.trimEndSeconds === null)
        throw new FfmpegProcessingError('invalid_metadata', 'Invalid processing metadata.');
      const source = decodeMediaRef(row.sourcePath!);
      if (source.prefix !== 'incoming') throw new MediaStoreError('invalid_ref');
      const materialized = await materializeStoredMedia(store, scope, source, outputDir);
      snapshot = materialized;
      if (row.mediaType === 'photo')
        await processPhotoWithFfmpeg(options.ffmpegBin, {
          inputPath: materialized.path,
          outputPath: temp,
          mode: row.mode as ProcessingMode,
        });
      else
        await processClipWithFfmpeg(options.ffmpegBin, {
          inputPath: materialized.path,
          outputPath: temp,
          trimStartSeconds: row.trimStartSeconds!,
          trimEndSeconds: row.trimEndSeconds!,
          mode: row.mode as ProcessingMode,
        });
      await probeClipWithFfmpeg(options.ffmpegBin, temp);
      output = await putProcessedFile(store, scope, temp, 'processed');
      prepared = markOutputPrepared(database, row, encodeMediaRef(output));
      if (!prepared) throw new MediaStoreError('scope_mismatch');
    }
    if (!output || !(await finalizeStoredClip(database, row, options, output)))
      throw new MediaStoreError('scope_mismatch');
    recordJobCompleted(database, row.id, options.actorMemberId);
    return { ok: true, jobId: row.id, status: 'ready' };
  } catch (error) {
    const code =
      error instanceof FfmpegProcessingError
        ? error.code
        : error instanceof MediaStoreError && error.code !== 'cleanup_failed'
          ? 'source_unavailable'
          : 'cleanup_failed';
    // Keep the prepared output for bounded cleanup/restart recovery, even when
    // the raw version was already deleted before a failed database COMMIT.
    database
      .prepare(
        `UPDATE media_jobs SET status = 'failed', error_code = ?,
      processing_started_at = NULL, failed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND claim_generation = ? AND processing_started_at IS ?`,
      )
      .run(
        code,
        new Date().toISOString(),
        new Date().toISOString(),
        row.id,
        row.claimGeneration,
        row.processingStartedAt,
      );
    recordJobFailed(database, row.id, options.actorMemberId);
    if (output && !prepared) {
      const { store, scope } = storedContext(options, row.groupId);
      await store.delete(scope, output).catch(() => undefined);
    }
    return {
      ok: false,
      jobId: row.id,
      status: 'failed',
      reason: 'processing_failed',
      message: 'The private media job could not be processed.',
    };
  } finally {
    await snapshot?.dispose();
    await rm(temp, { force: true });
  }
}

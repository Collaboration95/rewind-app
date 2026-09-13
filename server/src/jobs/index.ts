import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';

import type { RewindDatabase } from '../db';
import { recordAuditEvent } from '../audit';
import { removeStagedSource } from '../media';
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
  sourcePath: string | null;
  trimStartSeconds: number | null;
  trimEndSeconds: number | null;
  mode: string | null;
}

function safeOutputName(jobId: string): string {
  const suffix = createHash('sha256').update(jobId).digest('hex').slice(0, 24);
  return `clip-${suffix}.mp4`;
}

function markFailed(database: RewindDatabase, jobId: string, errorCode: string): void {
  database
    .prepare(
      `UPDATE media_jobs
       SET status = 'failed', output_path = NULL, error_code = ?
       WHERE id = ? AND kind = 'clip'`,
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
  const row = database
    .prepare(
      `SELECT id, status, source_path AS sourcePath,
              trim_start_seconds AS trimStartSeconds,
              trim_end_seconds AS trimEndSeconds, mode
       FROM media_jobs
       WHERE id = ? AND kind = 'clip' ${options.groupId ? 'AND group_id = ?' : ''}`,
    )
    .get(...(options.groupId ? [options.jobId, options.groupId] : [options.jobId])) as
    ClipJobRow | undefined;
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
  if (row.status === 'processing') {
    return {
      ok: false,
      jobId: row.id,
      status: 'processing',
      reason: 'already_processing',
      message: 'The media job is already processing.',
    };
  }
  if (!['pending', 'failed'].includes(row.status)) {
    return {
      ok: false,
      jobId: row.id,
      status: 'failed',
      reason: 'processing_failed',
      message: 'The media job cannot be processed in its current state.',
    };
  }

  const claim = database
    .prepare(
      `UPDATE media_jobs SET status = 'processing', error_code = NULL
       WHERE id = ? AND kind = 'clip' AND status IN ('pending', 'failed')`,
    )
    .run(row.id);
  if (Number(claim.changes) !== 1) {
    return {
      ok: false,
      jobId: row.id,
      status: 'processing',
      reason: 'already_processing',
      message: 'The media job is already processing.',
    };
  }

  const outputDir =
    options.outputDir ?? resolve(process.cwd(), '.local-data', 'media', 'processed');
  const outputPath = resolve(outputDir, safeOutputName(row.id));
  try {
    if (!row.sourcePath || row.trimStartSeconds === null || row.trimEndSeconds === null) {
      throw new FfmpegProcessingError(
        'invalid_metadata',
        'The clip processing metadata is invalid.',
      );
    }
    const stagingDir =
      options.stagingDir ?? resolve(process.cwd(), '.local-data', 'media', 'staging');
    const staged = findStagedSourceByPath(database, row.sourcePath);
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
        // Never claim success while the unfiltered source remains. If this
        // removal fails, the output is discarded and the job remains retryable.
        await rm(sourcePath, { force: false });
        if (staged) {
          database.prepare('DELETE FROM media_metadata WHERE source_uri = ?').run(staged.sourceUri);
          removeStagedSource(database, staged.sourceUri);
        }
        database
          .prepare(
            `UPDATE media_jobs
             SET status = 'ready', output_path = ?, source_path = NULL, error_code = NULL
             WHERE id = ? AND kind = 'clip' AND status = 'processing'`,
          )
          .run(outputPath, row.id);
      },
    });
    return { ok: true, jobId: row.id, status: 'ready' };
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => undefined);
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
    const sourceMatch = /^source-([a-f0-9]{24}|[a-f0-9]{32})\.mp4$/.exec(entry.name);
    const partialMatch = /^source-([a-f0-9]{24}|[a-f0-9]{32})\.mp4\.[a-f0-9-]+\.part$/.exec(
      entry.name,
    );
    if (removed >= boundedLimit || !entry.isFile() || (!sourceMatch && !partialMatch)) {
      continue;
    }
    const sourcePath = resolve(stagingDir, entry.name);
    const remainder = relative(resolve(stagingDir), sourcePath);
    if (!remainder || remainder.startsWith('..') || isAbsolute(remainder)) continue;
    const details = await stat(sourcePath).catch(() => null);
    if (!details || Date.now() - details.mtimeMs < maxAgeMs) continue;
    // A partial file is never a job input and can be removed once stale. A
    // completed source is retained only while a job still claims its path.
    if (sourceMatch) {
      const active = database
        .prepare("SELECT 1 FROM media_jobs WHERE kind = 'clip' AND source_path = ? LIMIT 1")
        .get(sourcePath);
      if (active) continue;
    }
    await rm(sourcePath, { force: true });
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
         AND NOT EXISTS (
           SELECT 1 FROM media_jobs WHERE media_jobs.source_path = staged_sources.source_path
         )`,
    )
    .all(cutoff) as { sourceUri?: string }[];
  for (const row of stale) {
    if (removed >= boundedLimit || !row.sourceUri) break;
    database.prepare('DELETE FROM media_metadata WHERE source_uri = ?').run(row.sourceUri);
    removeStagedSource(database, row.sourceUri);
    removed += 1;
  }
  return removed;
}

function findStagedSourceByPath(
  database: RewindDatabase,
  sourcePath: string,
): { sourceUri: string } | null {
  const row = database
    .prepare('SELECT source_uri AS sourceUri FROM staged_sources WHERE source_path = ?')
    .get(sourcePath) as { sourceUri?: string } | undefined;
  return row?.sourceUri ? { sourceUri: row.sourceUri } : null;
}

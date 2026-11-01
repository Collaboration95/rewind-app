// Clip upload validation, enqueue (createClipUpload) and cancellation.
import { cyclePhase } from '../cycles/engine';
import { releaseContributionAllowance, reserveContributionAllowance } from '../contributions';
import { linkContributionReplacement } from '../contributions/ledger';
import { getCurrentCycle, isMember } from '../db';
import type { RewindDatabase } from '../db';
import {
  DEFAULT_CAPTURE_MODE,
  isCaptureMode,
  processingModeFor,
  type CaptureMode,
  type ProcessingMode,
} from '../ffmpeg';
import { beginImmediate } from '../sqlite-busy';
import { keyHash, MAX_CLIP_BYTES, MAX_CLIP_DURATION_SECONDS } from './clip-policy';
import {
  cleanupStagedSourcePath,
  findStagedSource,
  stagedSourcePath,
  type StagedSource,
} from './staged-source';

const MIN_CLIP_DURATION_SECONDS = 0.5;

export interface ClipUploadInput {
  mediaType?: 'video' | 'photo';
  idempotencyKey: string;
  sourceUri: string;
  mimeType: string;
  byteLength: number;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Optional review metadata. The duration remains the quota duration. */
  mode?: CaptureMode;
  /** The client already applied `mode` before upload; the worker only normalizes. */
  clientProcessed?: boolean;
  trimStartSeconds?: number;
  trimEndSeconds?: number;
  /** Aliases accepted for clients that use the review metadata names. */
  startSeconds?: number;
  endSeconds?: number;
  sourceDurationSeconds?: number;
  /** Deleted contribution being replaced by this accepted upload. */
  replacesContributionId?: string;
}

export interface PendingClipUpload {
  contribution: {
    id: string;
    cycleId: string;
    groupId: string;
    memberId: string;
    durationSeconds: number;
    createdAt: string;
  };
  job: {
    id: string;
    groupId: string;
    contributionId: string;
    kind: 'clip';
    status: 'pending' | 'processing' | 'ready' | 'failed' | 'cancelled';
    createdAt: string;
  };
  existing: boolean;
}

export type ClipUploadResult =
  | { ok: true; upload: PendingClipUpload }
  | {
      ok: false;
      reason:
        | 'invalid_media'
        | 'invalid_mode'
        | 'invalid_key'
        | 'not_found'
        | 'quota_exceeded'
        | 'already_member'
        | 'invalid_replacement_target'
        | 'replacement_conflict';
    };

export type CancelClipUploadResult =
  { ok: true; contributionId: string; jobId: string } | { ok: false; reason: 'not_found' };

interface UploadRow {
  contributionId: string;
  cycleId: string;
  groupId: string;
  memberId: string;
  durationSeconds: number;
  contributionCreatedAt: string;
  jobId: string;
  jobStatus: string;
  jobCreatedAt: string;
  sourceUri?: string | null;
  sourceGeneration?: number | null;
  sourcePath?: string | null;
}

interface StoredClipMetadata {
  mediaType: 'video' | 'photo';
  sourceUri: string;
  mimeType: string;
  byteLength: number;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: number;
}

export interface ClipProcessingMetadata {
  mode: ProcessingMode;
  trimStartSeconds: number;
  trimEndSeconds: number;
}

export interface ClipUploadOptions {
  stagingDir?: string;
  requireVerifiedMetadata?: boolean;
}

export interface CancelClipUploadOptions {
  stagingDir?: string;
}

function storedClipMetadata(
  database: RewindDatabase,
  sourceUri: string,
): StoredClipMetadata | null {
  const row = database
    .prepare(
      `SELECT source_uri AS sourceUri, mime_type AS mimeType, media_type AS mediaType,
              byte_length AS byteLength,
              duration_seconds AS durationSeconds, width, height, has_audio AS hasAudio
       FROM media_metadata WHERE source_uri = ?`,
    )
    .get(sourceUri) as StoredClipMetadata | undefined;
  return row ?? null;
}

function idSuffix(key: string): string {
  return keyHash(key).slice(0, 16);
}

function mapUpload(row: UploadRow, existing: boolean): PendingClipUpload {
  return {
    contribution: {
      id: row.contributionId,
      cycleId: row.cycleId,
      groupId: row.groupId,
      memberId: row.memberId,
      durationSeconds: Number(row.durationSeconds),
      createdAt: row.contributionCreatedAt,
    },
    job: {
      id: row.jobId,
      groupId: row.groupId,
      contributionId: row.contributionId,
      kind: 'clip',
      status:
        row.jobStatus === 'cancelled'
          ? 'cancelled'
          : row.jobStatus === 'processing'
            ? 'processing'
            : row.jobStatus === 'ready'
              ? 'ready'
              : row.jobStatus === 'failed'
                ? 'failed'
                : 'pending',
      createdAt: row.jobCreatedAt,
    },
    existing,
  };
}

export function getClipProcessingMetadata(input: ClipUploadInput): ClipProcessingMetadata {
  const trimStartSeconds = input.trimStartSeconds ?? input.startSeconds ?? 0;
  const trimEndSeconds = input.trimEndSeconds ?? input.endSeconds ?? input.durationSeconds;
  return {
    mode: processingModeFor(input.mode ?? DEFAULT_CAPTURE_MODE, input.clientProcessed === true),
    trimStartSeconds,
    trimEndSeconds,
  };
}

export function validateClipUpload(
  input: ClipUploadInput,
  verifiedSourceDurationSeconds?: number,
): ClipUploadResult | null {
  const isPhoto = input.mediaType === 'photo';
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.idempotencyKey)) {
    return { ok: false, reason: 'invalid_key' };
  }
  if (
    input.replacesContributionId !== undefined &&
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.replacesContributionId)
  ) {
    return { ok: false, reason: 'invalid_replacement_target' };
  }
  if (
    !input.sourceUri ||
    (isPhoto
      ? !['image/jpeg', 'image/png'].includes(input.mimeType)
      : input.mimeType !== 'video/mp4') ||
    !Number.isInteger(input.byteLength) ||
    input.byteLength <= 0 ||
    input.byteLength > MAX_CLIP_BYTES ||
    !Number.isFinite(input.durationSeconds) ||
    input.durationSeconds <= 0 ||
    input.durationSeconds > MAX_CLIP_DURATION_SECONDS ||
    !Number.isInteger(input.width) ||
    input.width <= 0 ||
    !Number.isInteger(input.height) ||
    input.height <= 0 ||
    (isPhoto && (input.durationSeconds !== 3 || input.width > 12000 || input.height > 12000)) ||
    input.hasAudio !== true
  ) {
    return { ok: false, reason: 'invalid_media' };
  }
  if (
    !isCaptureMode(input.mode ?? DEFAULT_CAPTURE_MODE) ||
    (input.clientProcessed !== undefined && typeof input.clientProcessed !== 'boolean')
  ) {
    return { ok: false, reason: 'invalid_mode' };
  }
  const metadata = getClipProcessingMetadata(input);
  if (
    !Number.isFinite(metadata.trimStartSeconds) ||
    !Number.isFinite(metadata.trimEndSeconds) ||
    metadata.trimStartSeconds < 0 ||
    metadata.trimEndSeconds <= metadata.trimStartSeconds ||
    metadata.trimEndSeconds - metadata.trimStartSeconds < MIN_CLIP_DURATION_SECONDS ||
    metadata.trimEndSeconds - metadata.trimStartSeconds > MAX_CLIP_DURATION_SECONDS ||
    (verifiedSourceDurationSeconds !== undefined &&
      (!Number.isFinite(verifiedSourceDurationSeconds) ||
        metadata.trimEndSeconds > verifiedSourceDurationSeconds + 0.05))
  ) {
    return { ok: false, reason: 'invalid_media' };
  }
  return null;
}

function existingUpload(
  database: RewindDatabase,
  key: string,
  groupId: string,
  memberId: string,
): PendingClipUpload | null {
  const row = database
    .prepare(
      `SELECT c.id AS contributionId, c.cycle_id AS cycleId, cy.group_id AS groupId,
              c.member_id AS memberId, c.duration_seconds AS durationSeconds,
              c.created_at AS contributionCreatedAt, j.id AS jobId, j.status AS jobStatus,
              j.created_at AS jobCreatedAt, j.source_uri AS sourceUri,
              j.source_generation AS sourceGeneration, j.source_path AS sourcePath
       FROM media_jobs j
       JOIN contributions c ON c.id = j.contribution_id
       JOIN cycles cy ON cy.id = c.cycle_id
       WHERE j.idempotency_key = ? AND j.group_id = ? AND c.member_id = ? AND j.kind = 'clip'`,
    )
    .get(keyHash(key), groupId, memberId) as UploadRow | undefined;
  return row ? mapUpload(row, true) : null;
}

/** Rebind a retryable job to the current staged capability generation. The
 * caller must hold the writer transaction while it verifies the capability. */
function updateExistingStagedBinding(
  database: RewindDatabase,
  input: ClipUploadInput,
  groupId: string,
  staged: StagedSource,
): void {
  database
    .prepare(
      `UPDATE media_jobs
       SET source_uri = ?, source_generation = ?, source_path = ?, output_path = NULL,
           output_sha256 = NULL, output_bytes = NULL, output_verified_at = NULL,
           error_code = NULL
       WHERE idempotency_key = ? AND group_id = ? AND kind = 'clip'
         AND status IN ('pending', 'failed')`,
    )
    .run(
      staged.sourceUri,
      staged.claimGeneration,
      staged.sourcePath,
      keyHash(input.idempotencyKey),
      groupId,
    );
}

export function createClipUpload(
  database: RewindDatabase,
  groupId: string,
  memberId: string,
  input: ClipUploadInput,
  now = new Date(),
  options: ClipUploadOptions = {},
): ClipUploadResult {
  if (!isMember(database, groupId, memberId)) return { ok: false, reason: 'not_found' };
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.idempotencyKey)) {
    return { ok: false, reason: 'invalid_key' };
  }
  const key = keyHash(input.idempotencyKey);
  const isStagedSource = /^staged:\/\/(?:[a-f0-9]{24}|[a-f0-9]{32})$/.test(input.sourceUri);
  const existing = existingUpload(database, input.idempotencyKey, groupId, memberId);
  // Staged retries are revalidated inside the writer transaction below. A
  // preflight existing-row hit must not bypass recovery/generation checks.
  if (existing && (!isStagedSource || !['pending', 'failed'].includes(existing.job.status))) {
    return { ok: true, upload: existing };
  }
  let stagedRecord: StagedSource | null = null;
  if (isStagedSource && (!existing || ['pending', 'failed'].includes(existing.job.status))) {
    // Capability ownership and key binding are checked before reading or
    // probing any source. A token is not authorization by itself.
    stagedRecord = findStagedSource(database, input.sourceUri);
    if (
      !stagedRecord ||
      stagedRecord.status !== 'staged' ||
      stagedRecord.groupId !== groupId ||
      stagedRecord.memberId !== memberId ||
      stagedRecord.idempotencyKeyHash !== key
    ) {
      return { ok: false, reason: 'not_found' };
    }
  }
  const requestValidation = validateClipUpload(input);
  if (requestValidation) return requestValidation;
  const verified = storedClipMetadata(database, input.sourceUri);
  // Production enqueue paths must consume only a server-probed, owner-bound
  // staged capability. In particular, never let a caller substitute an
  // arbitrary absolute/file:// path when verification is required.
  if (options.requireVerifiedMetadata && (!isStagedSource || !verified)) {
    return { ok: false, reason: 'invalid_media' };
  }
  let effectiveInput = verified
    ? {
        ...input,
        mediaType: verified.mediaType,
        mimeType: verified.mimeType,
        byteLength: verified.byteLength,
        durationSeconds: verified.durationSeconds,
        width: verified.width,
        height: verified.height,
        hasAudio: verified.hasAudio === 1,
      }
    : input;
  // Only the duration reported by the trusted FFprobe metadata can bound the
  // requested trim. `input.sourceDurationSeconds` is deliberately ignored.
  const effectiveValidation = validateClipUpload(effectiveInput, verified?.durationSeconds);
  if (effectiveValidation) return effectiveValidation;
  const cycle = getCurrentCycle(database, groupId);
  const phase = cycle
    ? cyclePhase(
        {
          startsAt: cycle.startsAt,
          endsAt: cycle.endsAt,
          status: cycle.status as 'collecting' | 'revealing' | 'archived',
        },
        now,
      )
    : null;
  if (!cycle || phase !== 'collecting') return { ok: false, reason: 'not_found' };
  let processing = getClipProcessingMetadata(effectiveInput);
  let sourcePath =
    stagedRecord?.sourcePath ??
    (options.stagingDir && stagedSourcePath(input.sourceUri, options.stagingDir)) ??
    input.sourceUri;
  let sourceGeneration: number | null = stagedRecord?.claimGeneration ?? null;
  let durationSeconds = processing.trimEndSeconds - processing.trimStartSeconds;

  const suffix = idSuffix(input.idempotencyKey);
  const contributionId = `contribution-${suffix}`;
  const jobId = `clip-job-${suffix}`;
  const createdAt = now.toISOString();
  let transactionStarted = false;
  try {
    beginImmediate(database);
    transactionStarted = true;
    const retry = existingUpload(database, input.idempotencyKey, groupId, memberId);
    // Re-read every capability field while the writer lock is held. A source
    // may have been reclaimed between preflight and this transaction; using
    // the preflight path/generation would bind a retry to a deleted file.
    const verifyLockedStaged =
      isStagedSource && (!retry || ['pending', 'failed'].includes(retry.job.status));
    const lockedStaged = verifyLockedStaged ? findStagedSource(database, input.sourceUri) : null;
    const lockedMetadata = verifyLockedStaged
      ? storedClipMetadata(database, input.sourceUri)
      : null;
    if (verifyLockedStaged) {
      if (
        !lockedStaged ||
        lockedStaged.status !== 'staged' ||
        lockedStaged.groupId !== groupId ||
        lockedStaged.memberId !== memberId ||
        lockedStaged.idempotencyKeyHash !== key ||
        !lockedStaged.sourcePath ||
        !lockedStaged.byteLength ||
        !lockedMetadata ||
        lockedMetadata.byteLength !== lockedStaged.byteLength
      ) {
        database.exec('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      stagedRecord = lockedStaged;
      effectiveInput = {
        ...input,
        mediaType: lockedMetadata.mediaType,
        mimeType: lockedMetadata.mimeType,
        byteLength: lockedMetadata.byteLength,
        durationSeconds: lockedMetadata.durationSeconds,
        width: lockedMetadata.width,
        height: lockedMetadata.height,
        hasAudio: lockedMetadata.hasAudio === 1,
      };
      const lockedValidation = validateClipUpload(effectiveInput, lockedMetadata.durationSeconds);
      if (lockedValidation) {
        database.exec('ROLLBACK');
        return lockedValidation;
      }
      processing = getClipProcessingMetadata(effectiveInput);
      sourcePath = lockedStaged.sourcePath;
      sourceGeneration = lockedStaged.claimGeneration;
      durationSeconds = processing.trimEndSeconds - processing.trimStartSeconds;
    }
    if (retry) {
      if (verifyLockedStaged && stagedRecord) {
        updateExistingStagedBinding(database, input, groupId, stagedRecord);
      }
      const committedRetry = existingUpload(database, input.idempotencyKey, groupId, memberId);
      database.exec('COMMIT');
      // Re-read after the optional binding update so the response describes
      // the durable job state committed by this transaction.
      return {
        ok: true,
        upload: committedRetry ?? retry,
      };
    }
    const lockedCycle = getCurrentCycle(database, groupId);
    const lockedPhase = lockedCycle
      ? cyclePhase(
          {
            startsAt: lockedCycle.startsAt,
            endsAt: lockedCycle.endsAt,
            status: lockedCycle.status as 'collecting' | 'revealing' | 'archived',
          },
          now,
        )
      : null;
    if (!lockedCycle || lockedCycle.id !== cycle.id || lockedPhase !== 'collecting') {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    const reservation = reserveContributionAllowance(
      database,
      {
        id: lockedCycle.id,
        startsAt: lockedCycle.startsAt,
        endsAt: lockedCycle.endsAt,
        maxCount: lockedCycle.quota.maxCount,
        maxSeconds: lockedCycle.quota.maxSeconds,
      },
      memberId,
      durationSeconds,
      now,
    );
    if ('reason' in reservation) {
      database.exec('ROLLBACK');
      return reservation.reason === 'invalid_duration'
        ? { ok: false, reason: 'invalid_media' }
        : { ok: false, reason: 'quota_exceeded' };
    }
    database
      .prepare(
        `INSERT INTO contributions
          (id, cycle_id, member_id, media_job_id, duration_seconds, created_at, quota_window_start_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        contributionId,
        lockedCycle.id,
        memberId,
        durationSeconds,
        createdAt,
        reservation.startsAt,
      );
    database
      .prepare(
        `INSERT INTO media_jobs
          (id, group_id, contribution_id, kind, status, output_path, created_at, idempotency_key,
           source_uri, source_generation, source_path, trim_start_seconds, trim_end_seconds,
           mode, error_code, updated_at, media_type)
         VALUES (?, ?, ?, 'clip', 'pending', NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        jobId,
        groupId,
        contributionId,
        createdAt,
        key,
        isStagedSource ? input.sourceUri : null,
        sourceGeneration,
        sourcePath,
        processing.trimStartSeconds,
        processing.trimEndSeconds,
        processing.mode,
        createdAt,
        effectiveInput.mediaType ?? 'video',
      );
    database
      .prepare('UPDATE contributions SET media_job_id = ? WHERE id = ?')
      .run(jobId, contributionId);
    if (input.replacesContributionId) {
      const replacement = linkContributionReplacement(
        database,
        groupId,
        memberId,
        input.replacesContributionId,
        contributionId,
      );
      if (!replacement.ok) {
        database.exec('ROLLBACK');
        transactionStarted = false;
        return {
          ok: false,
          reason: replacement.reason === 'not_found' ? 'not_found' : 'replacement_conflict',
        };
      }
    }
    database
      .prepare(
        `UPDATE cycles
         SET count_used = count_used + 1, seconds_used = seconds_used + ?
         WHERE id = ?`,
      )
      .run(durationSeconds, lockedCycle.id);
    database.exec('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) database.exec('ROLLBACK');
    if (String(error).includes('UNIQUE constraint failed: media_jobs.idempotency_key')) {
      const retried = existingUpload(database, input.idempotencyKey, groupId, memberId);
      if (retried) return { ok: true, upload: retried };
    }
    throw error;
  }
  return {
    ok: true,
    upload: mapUpload(
      {
        contributionId,
        cycleId: cycle.id,
        groupId,
        memberId,
        durationSeconds,
        contributionCreatedAt: createdAt,
        jobId,
        jobStatus: 'pending',
        jobCreatedAt: createdAt,
      },
      false,
    ),
  };
}

export function cancelClipUpload(
  database: RewindDatabase,
  groupId: string,
  memberId: string,
  jobId: string,
  options: CancelClipUploadOptions = {},
): CancelClipUploadResult {
  let row = database
    .prepare(
      `SELECT j.id AS jobId, c.id AS contributionId, c.cycle_id AS cycleId,
                c.duration_seconds AS durationSeconds, c.quota_window_start_at AS windowStartsAt,
                j.source_uri AS sourceUri, j.source_generation AS sourceGeneration,
                j.source_path AS sourcePath, j.idempotency_key AS idempotencyKeyHash
       FROM media_jobs j JOIN contributions c ON c.id = j.contribution_id
       WHERE j.id = ? AND j.group_id = ? AND c.member_id = ? AND j.kind = 'clip'
         AND j.status = 'pending'`,
    )
    .get(jobId, groupId, memberId) as
    | {
        jobId: string;
        contributionId: string;
        cycleId: string;
        durationSeconds: number;
        windowStartsAt?: string;
        sourcePath?: string;
        sourceUri?: string;
        sourceGeneration?: number;
        idempotencyKeyHash?: string;
      }
    | undefined;
  if (!row) return { ok: false, reason: 'not_found' };
  beginImmediate(database);
  try {
    // Re-read under the writer lock. A processor may claim the job between
    // the initial lookup and BEGIN; cancellation must never delete a job that
    // has already moved out of the pending state.
    const lockedRow = database
      .prepare(
        `SELECT j.id AS jobId, c.id AS contributionId, c.cycle_id AS cycleId,
                  c.duration_seconds AS durationSeconds, c.quota_window_start_at AS windowStartsAt,
                  j.source_uri AS sourceUri, j.source_generation AS sourceGeneration,
                  j.source_path AS sourcePath, j.idempotency_key AS idempotencyKeyHash
         FROM media_jobs j JOIN contributions c ON c.id = j.contribution_id
         WHERE j.id = ? AND j.group_id = ? AND c.member_id = ? AND j.kind = 'clip'
           AND j.status = 'pending'`,
      )
      .get(jobId, groupId, memberId) as typeof row;
    if (!lockedRow) {
      database.exec('COMMIT');
      return { ok: false, reason: 'not_found' };
    }
    row = lockedRow;
    database.prepare('DELETE FROM media_jobs WHERE id = ?').run(row.jobId);
    database.prepare('DELETE FROM contributions WHERE id = ?').run(row.contributionId);
    database
      .prepare(
        `UPDATE cycles
         SET count_used = MAX(0, count_used - 1), seconds_used = MAX(0, seconds_used - ?)
         WHERE id = ?`,
      )
      .run(row.durationSeconds, row.cycleId);
    if (row.windowStartsAt) {
      releaseContributionAllowance(
        database,
        row.cycleId,
        memberId,
        row.windowStartsAt,
        row.durationSeconds,
      );
    }
    // Keep capability deletion and server-owned path cleanup inside the same
    // writer-locked cancellation transition. A retry/recovery request cannot
    // reclaim this source until both the row and file are gone; generation
    // binding also prevents an old path cleanup from deleting a replacement.
    if (options.stagingDir && row.sourcePath) {
      const staged = database
        .prepare(
          `SELECT source_uri AS sourceUri, claim_generation AS claimGeneration,
                  source_path AS sourcePath
           FROM staged_sources
           WHERE (source_path = ? OR source_uri = ? OR idempotency_key_hash = ?)
             AND group_id = ? AND member_id = ?
           ORDER BY CASE WHEN source_path = ? THEN 0 WHEN source_uri = ? THEN 1 ELSE 2 END
           LIMIT 1`,
        )
        .get(
          row.sourcePath,
          row.sourceUri ?? null,
          row.idempotencyKeyHash ?? null,
          groupId,
          memberId,
          row.sourcePath,
          row.sourceUri ?? null,
        ) as { sourceUri?: string; claimGeneration?: number; sourcePath?: string } | undefined;
      cleanupStagedSourcePath(row.sourcePath, options.stagingDir);
      if (staged?.sourcePath && staged.sourcePath !== row.sourcePath) {
        cleanupStagedSourcePath(staged.sourcePath, options.stagingDir);
      }
      if (staged?.sourceUri) {
        database
          .prepare(
            `DELETE FROM media_metadata WHERE source_uri = ?
             AND EXISTS (
               SELECT 1 FROM staged_sources
               WHERE source_uri = ? AND source_path = ? AND claim_generation = ?
             )`,
          )
          .run(
            staged.sourceUri,
            staged.sourceUri,
            staged.sourcePath ?? row.sourcePath,
            staged.claimGeneration ?? 0,
          );
        database
          .prepare(
            `DELETE FROM staged_sources
             WHERE source_uri = ? AND source_path = ? AND claim_generation = ?`,
          )
          .run(staged.sourceUri, staged.sourcePath ?? row.sourcePath, staged.claimGeneration ?? 0);
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return { ok: true, contributionId: row.contributionId, jobId: row.jobId };
}

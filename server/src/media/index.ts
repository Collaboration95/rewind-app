import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { relative, resolve, isAbsolute } from 'node:path';

import { cyclePhase } from '../cycles/engine';
import { releaseContributionAllowance, reserveContributionAllowance } from '../contributions';
import { getCurrentCycle, isMember } from '../db';
import type { RewindDatabase } from '../db';

export const MAX_CLIP_BYTES = 50 * 1024 * 1024;
export const MAX_CLIP_DURATION_SECONDS = 15;
export const MIN_CLIP_DURATION_SECONDS = 0.5;
export const SUPPORTED_CAPTURE_MODES = ['soft-focus', 'high-contrast'] as const;
export type CaptureMode = (typeof SUPPORTED_CAPTURE_MODES)[number];

export interface ClipUploadInput {
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
  trimStartSeconds?: number;
  trimEndSeconds?: number;
  /** Aliases accepted for clients that use the review metadata names. */
  startSeconds?: number;
  endSeconds?: number;
  sourceDurationSeconds?: number;
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
        | 'already_member';
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
}

interface StoredClipMetadata {
  sourceUri: string;
  mimeType: string;
  byteLength: number;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: number;
}

interface StagedSourceRecord {
  sourceId: string;
  sourceUri: string;
  groupId: string;
  memberId: string;
  idempotencyKeyHash: string;
  sourcePath: string | null;
  byteLength: number | null;
  status: 'pending' | 'staged';
  createdAt: string;
}

export type StagedSource = StagedSourceRecord;

export interface ClipProcessingMetadata {
  mode: CaptureMode;
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

export interface ServerClipMetadata {
  sourceUri: string;
  mimeType: 'video/mp4';
  byteLength: number;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  verifiedAt?: string;
}

function keyHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

const SQLITE_BUSY_RETRIES = 8;

function isBusyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; message?: string };
  return (
    candidate.code === 'SQLITE_BUSY' ||
    /database is locked|SQLITE_BUSY/i.test(candidate.message ?? '')
  );
}

function beginImmediateWithRetry(database: RewindDatabase): void {
  for (let attempt = 0; attempt < SQLITE_BUSY_RETRIES; attempt += 1) {
    try {
      database.exec('BEGIN IMMEDIATE');
      return;
    } catch (error) {
      if (!isBusyError(error) || attempt === SQLITE_BUSY_RETRIES - 1) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2 ** attempt);
    }
  }
}

export function stagedSourceId(idempotencyKey: string): string {
  return keyHash(idempotencyKey).slice(0, 24);
}

export function stagedSourcePath(sourceUri: string, stagingDir: string): string | null {
  // 32-character tokens are accepted only to let a legacy v6 job finish. New
  // capabilities always use the deterministic 24-character #44 token.
  const match = /^staged:\/\/([a-f0-9]{24}|[a-f0-9]{32})$/.exec(sourceUri);
  return match ? resolve(stagingDir, `source-${match[1]}.mp4`) : null;
}

export function findStagedSource(database: RewindDatabase, sourceUri: string): StagedSource | null {
  const row = database
    .prepare(
      `SELECT source_id AS sourceId, source_uri AS sourceUri,
          group_id AS groupId, member_id AS memberId,
          idempotency_key_hash AS idempotencyKeyHash,
          source_path AS sourcePath, byte_length AS byteLength, status,
          created_at AS createdAt
       FROM staged_sources WHERE source_uri = ?`,
    )
    .get(sourceUri) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    sourceId: String(row.sourceId),
    sourceUri: String(row.sourceUri),
    groupId: String(row.groupId),
    memberId: String(row.memberId),
    idempotencyKeyHash: String(row.idempotencyKeyHash),
    sourcePath: row.sourcePath === null ? null : String(row.sourcePath),
    byteLength: row.byteLength === null ? null : Number(row.byteLength),
    status: row.status === 'staged' ? 'staged' : 'pending',
    createdAt: String(row.createdAt),
  };
}

export function claimStagedSource(
  database: RewindDatabase,
  groupId: string,
  memberId: string,
  idempotencyKey: string,
  now = new Date(),
): { ok: true; source: StagedSource; existing: boolean } | { ok: false; reason: 'conflict' } {
  const sourceId = stagedSourceId(idempotencyKey);
  const sourceUri = `staged://${sourceId}`;
  const idempotencyKeyHash = keyHash(idempotencyKey);
  let started = false;
  try {
    beginImmediateWithRetry(database);
    started = true;
    const existing = findStagedSource(database, sourceUri);
    if (existing) {
      database.exec('COMMIT');
      return existing.groupId === groupId &&
        existing.memberId === memberId &&
        existing.idempotencyKeyHash === idempotencyKeyHash
        ? { ok: true, source: existing, existing: true }
        : { ok: false, reason: 'conflict' };
    }
    database
      .prepare(
        `INSERT INTO staged_sources
          (source_id, source_uri, idempotency_key_hash, group_id, member_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(sourceId, sourceUri, idempotencyKeyHash, groupId, memberId, now.toISOString());
    const source = findStagedSource(database, sourceUri);
    if (!source) throw new Error('Staged source could not be persisted.');
    database.exec('COMMIT');
    started = false;
    return { ok: true, source, existing: false };
  } catch (error) {
    if (started) database.exec('ROLLBACK');
    if (isBusyError(error)) throw error;
    if (String(error).includes('UNIQUE constraint failed')) {
      const existing = findStagedSource(database, sourceUri);
      if (existing && existing.groupId === groupId && existing.memberId === memberId) {
        return { ok: true, source: existing, existing: true };
      }
      return { ok: false, reason: 'conflict' };
    }
    throw error;
  }
}

export function setStagedSourcePath(
  database: RewindDatabase,
  sourceUri: string,
  sourcePath: string,
): void {
  database
    .prepare('UPDATE staged_sources SET source_path = ? WHERE source_uri = ?')
    .run(sourcePath, sourceUri);
}

export function markStagedSourceReady(
  database: RewindDatabase,
  sourceUri: string,
  byteLength: number,
  sourcePath?: string,
): void {
  database
    .prepare(
      `UPDATE staged_sources
       SET byte_length = ?, status = 'staged', source_path = COALESCE(?, source_path)
       WHERE source_uri = ? AND status = 'pending'`,
    )
    .run(byteLength, sourcePath ?? null, sourceUri);
}

export function removeStagedSource(database: RewindDatabase, sourceUri: string): void {
  database.prepare('DELETE FROM staged_sources WHERE source_uri = ?').run(sourceUri);
}

export function cleanupStagedSource(
  database: RewindDatabase,
  sourceUri: string,
  stagingDir: string,
): void {
  const sourcePath =
    findStagedSource(database, sourceUri)?.sourcePath ?? stagedSourcePath(sourceUri, stagingDir);
  if (!sourcePath) return;
  cleanupStagedSourcePath(sourcePath, stagingDir);
  database.prepare('DELETE FROM media_metadata WHERE source_uri = ?').run(sourceUri);
  removeStagedSource(database, sourceUri);
}

export function cleanupStagedSourcePath(sourcePath: string, stagingDir: string): void {
  const remainder = relative(resolve(stagingDir), resolve(sourcePath));
  if (!remainder || remainder.startsWith('..') || isAbsolute(remainder)) return;
  rmSync(resolve(sourcePath), { force: true });
}

export function recordClipMediaMetadata(
  database: RewindDatabase,
  metadata: ServerClipMetadata,
  verifiedAt = new Date(),
): void {
  if (
    !metadata.sourceUri ||
    metadata.mimeType !== 'video/mp4' ||
    !Number.isInteger(metadata.byteLength) ||
    metadata.byteLength <= 0 ||
    metadata.byteLength > MAX_CLIP_BYTES ||
    !Number.isFinite(metadata.durationSeconds) ||
    metadata.durationSeconds <= 0 ||
    metadata.durationSeconds > MAX_CLIP_DURATION_SECONDS ||
    !Number.isInteger(metadata.width) ||
    metadata.width <= 0 ||
    !Number.isInteger(metadata.height) ||
    metadata.height <= 0 ||
    metadata.width >= metadata.height ||
    metadata.hasAudio !== true
  ) {
    throw new RangeError('Server media metadata does not describe an acceptable clip.');
  }
  database
    .prepare(
      `INSERT INTO media_metadata
        (source_uri, mime_type, byte_length, duration_seconds, width, height, has_audio, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(source_uri) DO UPDATE SET
         mime_type = excluded.mime_type,
         byte_length = excluded.byte_length,
         duration_seconds = excluded.duration_seconds,
         width = excluded.width,
         height = excluded.height,
         has_audio = excluded.has_audio,
         verified_at = excluded.verified_at`,
    )
    .run(
      metadata.sourceUri,
      metadata.mimeType,
      metadata.byteLength,
      metadata.durationSeconds,
      metadata.width,
      metadata.height,
      metadata.verifiedAt ?? verifiedAt.toISOString(),
    );
}

function storedClipMetadata(
  database: RewindDatabase,
  sourceUri: string,
): StoredClipMetadata | null {
  const row = database
    .prepare(
      `SELECT source_uri AS sourceUri, mime_type AS mimeType, byte_length AS byteLength,
              duration_seconds AS durationSeconds, width, height, has_audio AS hasAudio
       FROM media_metadata WHERE source_uri = ?`,
    )
    .get(sourceUri) as StoredClipMetadata | undefined;
  return row ?? null;
}

const stagedSourceRecord = findStagedSource;

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
    mode: input.mode ?? 'soft-focus',
    trimStartSeconds,
    trimEndSeconds,
  };
}

export function validateClipUpload(
  input: ClipUploadInput,
  verifiedSourceDurationSeconds?: number,
): ClipUploadResult | null {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.idempotencyKey)) {
    return { ok: false, reason: 'invalid_key' };
  }
  if (
    !input.sourceUri ||
    input.mimeType !== 'video/mp4' ||
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
    input.width >= input.height ||
    input.hasAudio !== true
  ) {
    return { ok: false, reason: 'invalid_media' };
  }
  const metadata = getClipProcessingMetadata(input);
  if (!SUPPORTED_CAPTURE_MODES.includes(metadata.mode)) {
    return { ok: false, reason: 'invalid_mode' };
  }
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
              j.created_at AS jobCreatedAt
       FROM media_jobs j
       JOIN contributions c ON c.id = j.contribution_id
       JOIN cycles cy ON cy.id = c.cycle_id
       WHERE j.idempotency_key = ? AND j.group_id = ? AND c.member_id = ? AND j.kind = 'clip'`,
    )
    .get(keyHash(key), groupId, memberId) as UploadRow | undefined;
  return row ? mapUpload(row, true) : null;
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
  const existing = existingUpload(database, input.idempotencyKey, groupId, memberId);
  if (existing) return { ok: true, upload: existing };
  const isStagedSource = /^staged:\/\/(?:[a-f0-9]{24}|[a-f0-9]{32})$/.test(input.sourceUri);
  let stagedRecord: StagedSourceRecord | null = null;
  if (isStagedSource) {
    // Capability ownership and key binding are checked before reading or
    // probing any source. A token is not authorization by itself.
    stagedRecord = stagedSourceRecord(database, input.sourceUri);
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
  if (options.requireVerifiedMetadata && isStagedSource && !verified) {
    return { ok: false, reason: 'invalid_media' };
  }
  const effectiveInput = verified
    ? {
        ...input,
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
  const processing = getClipProcessingMetadata(effectiveInput);
  const sourcePath =
    stagedRecord?.sourcePath ??
    (options.stagingDir && stagedSourcePath(input.sourceUri, options.stagingDir)) ??
    input.sourceUri;
  const durationSeconds = processing.trimEndSeconds - processing.trimStartSeconds;

  const suffix = idSuffix(input.idempotencyKey);
  const contributionId = `contribution-${suffix}`;
  const jobId = `clip-job-${suffix}`;
  const createdAt = now.toISOString();
  let transactionStarted = false;
  try {
    beginImmediateWithRetry(database);
    transactionStarted = true;
    const retry = existingUpload(database, input.idempotencyKey, groupId, memberId);
    if (retry) {
      database.exec('COMMIT');
      return { ok: true, upload: retry };
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
           source_path, trim_start_seconds, trim_end_seconds, mode, error_code)
         VALUES (?, ?, ?, 'clip', 'pending', NULL, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        jobId,
        groupId,
        contributionId,
        createdAt,
        key,
        sourcePath,
        processing.trimStartSeconds,
        processing.trimEndSeconds,
        processing.mode,
      );
    database
      .prepare('UPDATE contributions SET media_job_id = ? WHERE id = ?')
      .run(jobId, contributionId);
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
  const row = database
    .prepare(
      `SELECT j.id AS jobId, c.id AS contributionId, c.cycle_id AS cycleId,
                c.duration_seconds AS durationSeconds, c.quota_window_start_at AS windowStartsAt,
                j.source_path AS sourcePath
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
      }
    | undefined;
  if (!row) return { ok: false, reason: 'not_found' };
  beginImmediateWithRetry(database);
  try {
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
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  if (options.stagingDir && row.sourcePath) {
    cleanupStagedSourcePath(row.sourcePath, options.stagingDir);
    const staged = database
      .prepare('SELECT source_uri AS sourceUri FROM staged_sources WHERE source_path = ?')
      .get(row.sourcePath) as { sourceUri?: string } | undefined;
    database
      .prepare('DELETE FROM media_metadata WHERE source_uri = ?')
      .run(staged?.sourceUri ?? null);
    database.prepare('DELETE FROM staged_sources WHERE source_path = ?').run(row.sourcePath);
  }
  return { ok: true, contributionId: row.contributionId, jobId: row.jobId };
}

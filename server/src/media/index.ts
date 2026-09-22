import { createHash } from 'node:crypto';
import { realpathSync, rmSync } from 'node:fs';
import { dirname, relative, resolve, isAbsolute } from 'node:path';

import { cyclePhase } from '../cycles/engine';
import { releaseContributionAllowance, reserveContributionAllowance } from '../contributions';
import { getCurrentCycle, isMember } from '../db';
import type { RewindDatabase } from '../db';

export const MAX_CLIP_BYTES = 50 * 1024 * 1024;
export const MAX_CLIP_DURATION_SECONDS = 15;
export const MIN_CLIP_DURATION_SECONDS = 0.5;
/** A body/probe claim is kept alive long enough for a bounded local upload. */
export const STAGED_SOURCE_LEASE_MS = 2 * 60 * 60 * 1000;
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
  sourceUri?: string | null;
  sourceGeneration?: number | null;
  sourcePath?: string | null;
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
  claimGeneration: number;
  claimExpiresAt: string | null;
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

export function stagedSourcePath(
  sourceUri: string,
  stagingDir: string,
  claimGeneration?: number,
): string | null {
  // 32-character tokens are accepted only to let a legacy v6 job finish. New
  // capabilities always use the deterministic 24-character #44 token.
  const match = /^staged:\/\/([a-f0-9]{24}|[a-f0-9]{32})$/.exec(sourceUri);
  if (!match) return null;
  // Keep the original path for generation 0/1 for compatibility with old
  // rows. Every reclaim gets a distinct path so a stale request can never
  // unlink the replacement source after its generation has been fenced off.
  const suffix = claimGeneration && claimGeneration > 1 ? `-${claimGeneration}` : '';
  return resolve(stagingDir, `source-${match[1]}${suffix}.mp4`);
}

export function findStagedSource(database: RewindDatabase, sourceUri: string): StagedSource | null {
  const row = database
    .prepare(
      `SELECT source_id AS sourceId, source_uri AS sourceUri,
          group_id AS groupId, member_id AS memberId,
          idempotency_key_hash AS idempotencyKeyHash,
          source_path AS sourcePath, byte_length AS byteLength, status,
          created_at AS createdAt, claim_generation AS claimGeneration,
          claim_expires_at AS claimExpiresAt
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
    claimGeneration: Number(row.claimGeneration ?? 0),
    claimExpiresAt: row.claimExpiresAt === null ? null : String(row.claimExpiresAt),
  };
}

export function claimStagedSource(
  database: RewindDatabase,
  groupId: string,
  memberId: string,
  idempotencyKey: string,
  now = new Date(),
  sourcePath?: string,
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
      // A pending source with a path has an active intake owner. The path is
      // written as part of this transaction, before the request reads its
      // body, so a second same-key request cannot race into the same target.
      // A pending legacy row without a path can be claimed by the first
      // request that supplies one (for example after a process restart).
      if (
        existing.groupId === groupId &&
        existing.memberId === memberId &&
        existing.idempotencyKeyHash === idempotencyKeyHash &&
        existing.status === 'pending' &&
        sourcePath &&
        !existing.sourcePath
      ) {
        // resetStagedSourceClaim already advances the fence before clearing
        // the path; claiming that reset row must use its current generation,
        // not advance it a second time.
        const generation = Math.max(1, existing.claimGeneration);
        const expiresAt = new Date(now.getTime() + STAGED_SOURCE_LEASE_MS).toISOString();
        database
          .prepare(
            "UPDATE staged_sources SET source_path = ?, claim_generation = ?, claim_expires_at = ? WHERE source_uri = ? AND status = 'pending' AND source_path IS NULL",
          )
          .run(sourcePath, generation, expiresAt, sourceUri);
        const claimed = findStagedSource(database, sourceUri);
        if (!claimed) throw new Error('Staged source could not be persisted.');
        database.exec('COMMIT');
        started = false;
        return { ok: true, source: claimed, existing: false };
      }
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
          (source_id, source_uri, idempotency_key_hash, group_id, member_id, source_path, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        sourceId,
        sourceUri,
        idempotencyKeyHash,
        groupId,
        memberId,
        sourcePath ?? null,
        now.toISOString(),
      );
    database
      .prepare(
        'UPDATE staged_sources SET claim_generation = 1, claim_expires_at = ? WHERE source_uri = ?',
      )
      .run(new Date(now.getTime() + STAGED_SOURCE_LEASE_MS).toISOString(), sourceUri);
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
  claimGeneration?: number,
): boolean {
  const result = database
    .prepare(
      `UPDATE staged_sources
       SET byte_length = ?, status = 'staged', source_path = COALESCE(?, source_path),
           claim_expires_at = NULL
       WHERE source_uri = ? AND status = 'pending'
         AND (? IS NULL OR claim_generation = ?)
         AND (? IS NULL OR source_path IS NULL OR source_path = ?)`,
    )
    .run(
      byteLength,
      sourcePath ?? null,
      sourceUri,
      claimGeneration ?? null,
      claimGeneration ?? null,
      sourcePath ?? null,
      sourcePath ?? null,
    );
  return Number(result.changes) === 1;
}

/** Release an intake claim after its body/probe failed so a retry can reclaim it. */
export function resetStagedSourceClaim(
  database: RewindDatabase,
  sourceUri: string,
  sourcePath: string,
  claimGeneration?: number,
): boolean {
  const result = database
    .prepare(
      `UPDATE staged_sources
       SET source_path = NULL, byte_length = NULL, status = 'pending',
           claim_generation = claim_generation + 1, claim_expires_at = NULL
       WHERE source_uri = ? AND source_path = ? AND status = 'pending'
         AND (? IS NULL OR claim_generation = ?)`,
    )
    .run(sourceUri, sourcePath, claimGeneration ?? null, claimGeneration ?? null);
  if (Number(result.changes) === 1) {
    database.prepare('DELETE FROM media_metadata WHERE source_uri = ?').run(sourceUri);
    return true;
  }
  return false;
}

/** Reclaim a staged capability whose final file disappeared after a crash. */
export function reclaimStagedSource(
  database: RewindDatabase,
  groupId: string,
  memberId: string,
  idempotencyKey: string,
  sourcePath: string,
  now = new Date(),
): { ok: true; source: StagedSource } | { ok: false } {
  const sourceUri = `staged://${stagedSourceId(idempotencyKey)}`;
  const hash = keyHash(idempotencyKey);
  let started = false;
  try {
    beginImmediateWithRetry(database);
    started = true;
    const generation = database
      .prepare(
        `SELECT claim_generation AS claimGeneration FROM staged_sources
         WHERE source_uri = ? AND group_id = ? AND member_id = ?
           AND idempotency_key_hash = ?
           AND (
             status = 'staged' OR
             (status = 'pending' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?)
           )`,
      )
      .get(sourceUri, groupId, memberId, hash, now.toISOString()) as
      { claimGeneration?: number } | undefined;
    if (!generation) {
      database.exec('COMMIT');
      started = false;
      return { ok: false };
    }
    // A processing worker owns its old generation until it finalizes. Do not
    // reclaim that capability underneath it; a stale worker must first be
    // allowed to reconcile its durable finalization marker.
    const activeJob = database
      .prepare(
        `SELECT 1 FROM media_jobs
         WHERE (source_uri = ? OR idempotency_key = ?)
           AND source_generation = ?
           AND status IN ('processing', 'ready') LIMIT 1`,
      )
      .get(sourceUri, hash, generation.claimGeneration ?? 0);
    if (activeJob) {
      database.exec('COMMIT');
      started = false;
      return { ok: false };
    }
    const nextGeneration = Number(generation.claimGeneration ?? 0) + 1;
    const result = database
      .prepare(
        `UPDATE staged_sources SET status = 'pending', byte_length = NULL,
           source_path = ?, claim_generation = ?, claim_expires_at = ?
         WHERE source_uri = ? AND claim_generation = ?
           AND (
             status = 'staged' OR
             (status = 'pending' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?)
           )`,
      )
      .run(
        sourcePath,
        nextGeneration,
        new Date(now.getTime() + STAGED_SOURCE_LEASE_MS).toISOString(),
        sourceUri,
        generation.claimGeneration ?? 0,
        now.toISOString(),
      );
    if (Number(result.changes) !== 1) {
      database.exec('COMMIT');
      started = false;
      return { ok: false };
    }
    // Move retryable jobs with the capability in the same writer transaction.
    // This is what prevents a pending/failed job from retaining the deleted
    // path after recovery advances the source generation.
    database
      .prepare(
        `UPDATE media_jobs
         SET source_uri = ?, source_generation = ?, source_path = ?, output_path = NULL,
             error_code = NULL
         WHERE kind = 'clip' AND status IN ('pending', 'failed')
           AND (source_uri = ? OR idempotency_key = ?)
           AND (source_generation IS NULL OR source_generation = ?)`,
      )
      .run(sourceUri, nextGeneration, sourcePath, sourceUri, hash, generation.claimGeneration ?? 0);
    database.prepare('DELETE FROM media_metadata WHERE source_uri = ?').run(sourceUri);
    const source = findStagedSource(database, sourceUri);
    if (!source) throw new Error('Staged source could not be reclaimed.');
    database.exec('COMMIT');
    started = false;
    return { ok: true, source };
  } catch (error) {
    if (started) database.exec('ROLLBACK');
    throw error;
  }
}

export function removeStagedSource(database: RewindDatabase, sourceUri: string): void {
  database.prepare('DELETE FROM staged_sources WHERE source_uri = ?').run(sourceUri);
}

const stagingLocks = new Map<string, Promise<void>>();
let activeStagedIntakes = 0;
let stagedIntakesIdle: (() => void)[] = [];

/** Serialize intake/reset mutations within a runtime process. Database fences
 * remain authoritative across processes; this lock also protects awaits while
 * a request is consuming/probing a body. */
export async function acquireStagedSourceLock(lockKey: string): Promise<() => void> {
  const previous = stagingLocks.get(lockKey) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolvePromise) => {
    releaseCurrent = resolvePromise;
  });
  stagingLocks.set(lockKey, current);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (stagingLocks.get(lockKey) === current) stagingLocks.delete(lockKey);
    releaseCurrent();
  };
}

/** Register the body/probe portion after its DB claim has been committed. */
export function registerStagedIntake(): () => void {
  activeStagedIntakes += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeStagedIntakes = Math.max(0, activeStagedIntakes - 1);
    if (activeStagedIntakes === 0) {
      const waiters = stagedIntakesIdle;
      stagedIntakesIdle = [];
      for (const resolveWaiter of waiters) resolveWaiter();
    }
  };
}

/** Reset waits for all in-process body/probe operations to finish. */
export async function waitForStagedIntakesIdle(): Promise<void> {
  if (activeStagedIntakes === 0) return;
  await new Promise<void>((resolvePromise) => stagedIntakesIdle.push(resolvePromise));
}

function stagedClaimIsActive(source: StagedSource, at = Date.now()): boolean {
  if (source.status !== 'pending' || !source.sourcePath) return false;
  const expires = source.claimExpiresAt ? Date.parse(source.claimExpiresAt) : Number.NaN;
  return Number.isFinite(expires) && expires > at;
}

export function cleanupStagedSource(
  database: RewindDatabase,
  sourceUri: string,
  stagingDir: string,
  options: StagedSourceCleanupOptions = {},
): boolean {
  beginImmediateWithRetry(database);
  try {
    const source = findStagedSource(database, sourceUri);
    if (
      !source ||
      (options.expectedSourcePath !== undefined &&
        source.sourcePath !== options.expectedSourcePath) ||
      (options.expectedClaimGeneration !== undefined &&
        source.claimGeneration !== options.expectedClaimGeneration)
    ) {
      database.exec('COMMIT');
      return false;
    }
    // Invalid upload metadata must never clean up a body that another request
    // currently owns. A lease expiry allows bounded crash recovery.
    if (stagedClaimIsActive(source)) {
      database.exec('COMMIT');
      return false;
    }
    // A durable job binding owns this capability even after its intake lease
    // expires. Cleanup must never remove a source that a retry/finalizer can
    // still legitimately consume.
    const job = database
      .prepare(
        `SELECT 1 FROM media_jobs
         WHERE kind = 'clip' AND (source_uri = ? OR source_path = ?)
           AND status IN ('pending', 'failed', 'processing') LIMIT 1`,
      )
      .get(sourceUri, source.sourcePath ?? null);
    if (job) {
      database.exec('COMMIT');
      return false;
    }
    const sourcePath =
      source.sourcePath ?? stagedSourcePath(sourceUri, stagingDir, source.claimGeneration);
    if (sourcePath) cleanupStagedSourcePath(sourcePath, stagingDir);
    database.prepare('DELETE FROM media_metadata WHERE source_uri = ?').run(sourceUri);
    const deleted = database
      .prepare(
        `DELETE FROM staged_sources
         WHERE source_uri = ? AND claim_generation = ? AND source_path IS ?`,
      )
      .run(sourceUri, source.claimGeneration, source.sourcePath);
    database.exec('COMMIT');
    return Number(deleted.changes) === 1;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export interface StagedSourceCleanupOptions {
  /** Cleanup is allowed only if the row still owns this physical path. */
  expectedSourcePath?: string | null;
  /** Cleanup is allowed only if the row still belongs to this generation. */
  expectedClaimGeneration?: number;
}

/** Remove an unclaimed staging file while holding the DB writer lock. */
export function cleanupUnclaimedStagedPath(
  database: RewindDatabase,
  sourcePath: string,
  stagingDir: string,
  protectedPath = sourcePath,
  options: { releaseExpiredPendingClaim?: boolean } = {},
): boolean {
  beginImmediateWithRetry(database);
  try {
    const claimed = database
      .prepare(
        `SELECT source_uri AS sourceUri, source_path AS sourcePath,
                claim_generation AS claimGeneration, status, claim_expires_at AS claimExpiresAt
         FROM staged_sources WHERE source_path = ? LIMIT 1`,
      )
      .get(protectedPath);
    if (claimed) {
      const row = claimed as {
        sourceUri: string;
        sourcePath: string;
        claimGeneration: number;
        status: string;
        claimExpiresAt: string | null;
      };
      const pendingLeaseActive =
        row.status === 'pending' &&
        row.claimExpiresAt !== null &&
        Date.parse(row.claimExpiresAt) > Date.now();
      const isPartialPath = sourcePath !== protectedPath;
      if (row.status === 'staged' && isPartialPath) {
        // A random-suffix .part file is never a job input. It can be removed
        // without disturbing the completed capability or its final source.
        cleanupStagedSourcePath(sourcePath, stagingDir);
        database.exec('COMMIT');
        return true;
      }
      if (!options.releaseExpiredPendingClaim || pendingLeaseActive || !isPartialPath) {
        database.exec('COMMIT');
        return false;
      }
      const activeJob = database
        .prepare(
          `SELECT 1 FROM media_jobs
           WHERE kind = 'clip' AND status IN ('pending', 'failed', 'processing')
             AND (source_uri = ? OR source_path = ?)
           LIMIT 1`,
        )
        .get(row.sourceUri, row.sourcePath);
      if (activeJob) {
        if (isPartialPath) {
          cleanupStagedSourcePath(sourcePath, stagingDir);
          database.exec('COMMIT');
          return true;
        }
        database.exec('COMMIT');
        return false;
      }
      // The pending claim and both physical artifacts are one recoverable
      // generation. Delete only this exact row/path while holding the writer
      // lock; a reclaim of a newer generation cannot be touched by this call.
      cleanupStagedSourcePath(sourcePath, stagingDir);
      cleanupStagedSourcePath(protectedPath, stagingDir);
      database.prepare('DELETE FROM media_metadata WHERE source_uri = ?').run(row.sourceUri);
      const deleted = database
        .prepare(
          `DELETE FROM staged_sources
           WHERE source_uri = ? AND claim_generation = ? AND source_path = ?`,
        )
        .run(row.sourceUri, row.claimGeneration, row.sourcePath);
      database.exec('COMMIT');
      return Number(deleted.changes) === 1;
    }
    cleanupStagedSourcePath(sourcePath, stagingDir);
    database.exec('COMMIT');
    return true;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function cleanupStagedSourcePath(sourcePath: string, stagingDir: string): void {
  const managedDir = resolve(stagingDir);
  const candidate = resolve(sourcePath);
  const remainder = relative(managedDir, candidate);
  if (!remainder || remainder.startsWith('..') || isAbsolute(remainder)) return;

  // Lexical containment is not enough when a caller supplies a path below a
  // symlinked directory. Resolve the existing parent and file before removal;
  // a missing or broken leaf is still safe to unlink once its parent is
  // physically inside the managed staging directory.
  let realManagedDir: string;
  let realParent: string;
  try {
    realManagedDir = realpathSync(managedDir);
    realParent = realpathSync(dirname(candidate));
  } catch {
    return;
  }
  const parentRemainder = relative(realManagedDir, realParent);
  if (parentRemainder.startsWith('..') || isAbsolute(parentRemainder)) return;
  try {
    const realCandidate = realpathSync(candidate);
    const candidateRemainder = relative(realManagedDir, realCandidate);
    if (
      !candidateRemainder ||
      candidateRemainder.startsWith('..') ||
      isAbsolute(candidateRemainder)
    ) {
      return;
    }
  } catch {
    // The leaf may already be gone or be a broken symlink. Its parent has
    // already passed the physical staging boundary check above.
  }
  rmSync(candidate, { force: true });
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
  staged: StagedSourceRecord,
): void {
  database
    .prepare(
      `UPDATE media_jobs
       SET source_uri = ?, source_generation = ?, source_path = ?, output_path = NULL,
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
  let stagedRecord: StagedSourceRecord | null = null;
  if (isStagedSource && (!existing || ['pending', 'failed'].includes(existing.job.status))) {
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
  // Production enqueue paths must consume only a server-probed, owner-bound
  // staged capability. In particular, never let a caller substitute an
  // arbitrary absolute/file:// path when verification is required.
  if (options.requireVerifiedMetadata && (!isStagedSource || !verified)) {
    return { ok: false, reason: 'invalid_media' };
  }
  let effectiveInput = verified
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
    beginImmediateWithRetry(database);
    transactionStarted = true;
    const retry = existingUpload(database, input.idempotencyKey, groupId, memberId);
    // Re-read every capability field while the writer lock is held. A source
    // may have been reclaimed between preflight and this transaction; using
    // the preflight path/generation would bind a retry to a deleted file.
    const verifyLockedStaged =
      isStagedSource && (!retry || ['pending', 'failed'].includes(retry.job.status));
    const lockedStaged = verifyLockedStaged ? stagedSourceRecord(database, input.sourceUri) : null;
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
           mode, error_code)
         VALUES (?, ?, ?, 'clip', 'pending', NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
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
  beginImmediateWithRetry(database);
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

// Staged-source capability lifecycle: claim, ready, reset, reclaim, lock and cleanup.
import { realpathSync, rmSync } from 'node:fs';
import { dirname, relative, resolve, isAbsolute } from 'node:path';

import type { RewindDatabase } from '../db';
import { beginImmediate, isBusyError } from '../sqlite-busy';
import { keyHash } from './clip-policy';

/** A body/probe claim is kept alive long enough for a bounded local upload. */
const STAGED_SOURCE_LEASE_MS = 2 * 60 * 60 * 1000;

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
    beginImmediate(database);
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
  let started = false;
  try {
    beginImmediate(database);
    started = true;
    const expectedGeneration = claimGeneration ?? null;
    const claimed = database
      .prepare(
        `SELECT 1 FROM staged_sources
         WHERE source_uri = ? AND source_path = ? AND status = 'pending'
           AND (? IS NULL OR claim_generation = ?)`,
      )
      .get(sourceUri, sourcePath, expectedGeneration, expectedGeneration);
    if (!claimed) {
      database.exec('COMMIT');
      return false;
    }
    database
      .prepare(
        `DELETE FROM media_metadata
         WHERE source_uri = ?
           AND EXISTS (
             SELECT 1 FROM staged_sources
             WHERE source_uri = ? AND source_path = ? AND status = 'pending'
               AND (? IS NULL OR claim_generation = ?)
           )`,
      )
      .run(sourceUri, sourceUri, sourcePath, expectedGeneration, expectedGeneration);
    const result = database
      .prepare(
        `UPDATE staged_sources
         SET source_path = NULL, byte_length = NULL, status = 'pending',
             claim_generation = claim_generation + 1, claim_expires_at = NULL
         WHERE source_uri = ? AND source_path = ? AND status = 'pending'
           AND (? IS NULL OR claim_generation = ?)`,
      )
      .run(sourceUri, sourcePath, expectedGeneration, expectedGeneration);
    if (Number(result.changes) !== 1) {
      throw new Error('staged source claim changed during reset');
    }
    database.exec('COMMIT');
    return true;
  } catch (error) {
    if (started) database.exec('ROLLBACK');
    throw error;
  }
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
    beginImmediate(database);
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
             output_sha256 = NULL, output_bytes = NULL, output_verified_at = NULL,
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
  beginImmediate(database);
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
  beginImmediate(database);
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

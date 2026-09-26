import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, readSync, statSync } from 'node:fs';
import { open, rm, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { recordAuditEvent } from '../audit';
import type { RewindDatabase } from '../db';

/** One digest/size pair recorded when a clip or film output is finalized. */
export interface FileIntegrity {
  sha256: string;
  byteLength: number;
}

/** Filesystem identity captured from the same descriptor that was hashed. */
export interface FileIdentity {
  device: string;
  inode: string;
  byteLength: number;
  modifiedAtMs: number;
  changedAtMs: number;
}

export interface HashedFileIntegrity extends FileIntegrity {
  identity: FileIdentity;
}

export interface OpenedMediaIntegrity {
  result: MediaIntegrityResult;
  handle: FileHandle | null;
  byteLength: number | null;
  capacityExceeded?: boolean;
}

/**
 * The auditable event recorded when a stored output no longer matches the
 * digest persisted at finalization. It stays distinct from a processing
 * failure so an operator can tell tampering and truncation apart from an
 * FFmpeg problem.
 */
export const MEDIA_INTEGRITY_EVENT = 'media.integrity_failed' as const;

const READ_ONLY_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

export type MediaIntegrityOutcome = 'verified' | 'unverifiable' | 'mismatch' | 'unavailable';

export interface MediaIntegrityResult {
  outcome: MediaIntegrityOutcome;
  expectedSha256: string | null;
  expectedByteLength: number | null;
  observedSha256: string | null;
  observedByteLength: number | null;
  /** Present only after hashing a stable opened file descriptor. */
  observedIdentity?: FileIdentity | null;
}

/** Hash a non-empty server-owned file. The caller owns path policy; this
 * helper only reports what it observed on disk. */
export async function hashFile(path: string): Promise<FileIntegrity | null> {
  const hashed = await hashFileWithIdentity(path);
  return hashed ? { sha256: hashed.sha256, byteLength: hashed.byteLength } : null;
}

/** Hash an opened file and retain its identity for a later fenced publish. */
export async function hashFileWithIdentity(path: string): Promise<HashedFileIntegrity | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, READ_ONLY_NO_FOLLOW);
    return await hashOpenFileWithIdentity(handle);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Hash through one descriptor so a pathname replacement cannot change which
 * inode was read. Positional reads leave the descriptor ready for streaming. */
async function hashOpenFileWithIdentity(handle: FileHandle): Promise<HashedFileIntegrity | null> {
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size <= 0) return null;
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let byteLength = 0;
    while (byteLength < initial.size) {
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, initial.size - byteLength),
        byteLength,
      );
      if (read.bytesRead <= 0) break;
      byteLength += read.bytesRead;
      digest.update(buffer.subarray(0, read.bytesRead));
    }
    const final = await handle.stat();
    if (
      byteLength !== initial.size ||
      !sameFileIdentity(fileIdentity(initial), fileIdentity(final))
    ) {
      return null;
    }
    return {
      sha256: digest.digest('hex'),
      byteLength,
      identity: fileIdentity(final),
    };
  } catch {
    return null;
  }
}

/** Copy and hash one opened source descriptor into an unlinked snapshot. A
 * response can stream this private inode only after its complete digest is
 * known, so neither path replacement nor later in-place writes can alter the
 * bytes delivered to the client. */
async function snapshotAndHashOpenFile(
  source: FileHandle,
  snapshot: FileHandle,
  readSource: FileHandle['read'] = source.read.bind(source),
  maxByteLength = Number.POSITIVE_INFINITY,
): Promise<HashedFileIntegrity | null | 'over-limit'> {
  try {
    const initial = await source.stat();
    if (!initial.isFile() || initial.size <= 0) return null;
    if (initial.size > maxByteLength) return 'over-limit';
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let byteLength = 0;
    while (byteLength < initial.size) {
      const read = await readSource(
        buffer,
        0,
        Math.min(buffer.length, initial.size - byteLength),
        byteLength,
      );
      if (read.bytesRead <= 0) break;
      const chunkStart = byteLength;
      byteLength += read.bytesRead;
      digest.update(buffer.subarray(0, read.bytesRead));
      let written = 0;
      while (written < read.bytesRead) {
        const result = await snapshot.write(
          buffer,
          written,
          read.bytesRead - written,
          chunkStart + written,
        );
        if (result.bytesWritten <= 0) return null;
        written += result.bytesWritten;
      }
    }
    const final = await source.stat();
    if (
      byteLength !== initial.size ||
      !sameFileIdentity(fileIdentity(initial), fileIdentity(final))
    ) {
      return null;
    }
    // The source may be modified in place while it is being read without a
    // distinguishable identity change (for example, coarse filesystem
    // timestamps). Verify the completed private snapshot itself so the bytes
    // that will be served are exactly the bytes included in this digest.
    const snapshotIntegrity = await hashOpenFileWithIdentity(snapshot);
    if (
      !snapshotIntegrity ||
      snapshotIntegrity.byteLength !== byteLength ||
      snapshotIntegrity.sha256 !== digest.digest('hex')
    ) {
      return null;
    }
    return {
      sha256: snapshotIntegrity.sha256,
      byteLength,
      identity: fileIdentity(final),
    };
  } catch {
    return null;
  }
}

async function openAnonymousSnapshot(directory: string): Promise<FileHandle> {
  const path = join(directory, `.integrity-stream-${randomUUID()}.tmp`);
  const handle = await open(path, 'wx+', 0o600);
  try {
    await unlink(path);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

function fileIdentity(details: {
  dev: number | bigint;
  ino: number | bigint;
  size: number | bigint;
  mtimeMs: number;
  ctimeMs: number;
}): FileIdentity {
  return {
    device: String(details.dev),
    inode: String(details.ino),
    byteLength: Number(details.size),
    modifiedAtMs: details.mtimeMs,
    changedAtMs: details.ctimeMs,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.byteLength === right.byteLength &&
    left.modifiedAtMs === right.modifiedAtMs &&
    left.changedAtMs === right.changedAtMs
  );
}

/** A cheap fence used inside short writer transactions after the file was
 * hashed outside the lock. It refuses publication if the pathname now names
 * another inode or the hashed inode changed meanwhile. */
export function filePathMatchesIdentity(path: string, identity: FileIdentity): boolean {
  try {
    const details = lstatSync(path);
    return details.isFile() && sameFileIdentity(fileIdentity(details), identity);
  } catch {
    return false;
  }
}

/** Synchronous variant used by the migration backfill, which runs before the
 * runtime exists. */
export function hashFileSync(path: string): FileIntegrity | null {
  let descriptor: number | null = null;
  try {
    const details = statSync(path);
    if (!details.isFile() || details.size <= 0) return null;
    descriptor = openSync(path, constants.O_RDONLY);
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let byteLength = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      byteLength += read;
      digest.update(buffer.subarray(0, read));
    }
    if (byteLength <= 0) return null;
    return { sha256: digest.digest('hex'), byteLength };
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export interface StoredIntegrity {
  jobId: string;
  kind: string;
  outputPath: string | null;
  sha256: string | null;
  byteLength: number | null;
  verifiedAt: string | null;
}

export function readStoredIntegrity(
  database: RewindDatabase,
  jobId: string,
): StoredIntegrity | null {
  const row = database
    .prepare(
      `SELECT id AS jobId, kind, output_path AS outputPath,
              output_sha256 AS sha256, output_bytes AS byteLength,
              output_verified_at AS verifiedAt
       FROM media_jobs WHERE id = ?`,
    )
    .get(jobId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const byteLength = row.byteLength;
  return {
    jobId: String(row.jobId),
    kind: String(row.kind),
    outputPath: row.outputPath ? String(row.outputPath) : null,
    sha256: row.sha256 ? String(row.sha256) : null,
    byteLength: byteLength === null || byteLength === undefined ? null : Number(byteLength),
    verifiedAt: row.verifiedAt ? String(row.verifiedAt) : null,
  };
}

/**
 * Compare a finalized output on disk against the digest persisted during
 * finalization. A row finalized before integrity metadata existed has no
 * expectation to enforce and is reported as unverifiable rather than broken.
 */
export async function verifyMediaIntegrity(
  database: RewindDatabase,
  jobId: string,
  filePath: string | null,
): Promise<MediaIntegrityResult> {
  const stored = readStoredIntegrity(database, jobId);
  const expectedSha256 = stored?.sha256 ?? null;
  const expectedByteLength = stored?.byteLength ?? null;
  if (!expectedSha256 || expectedByteLength === null || expectedByteLength <= 0) {
    return {
      outcome: 'unverifiable',
      expectedSha256,
      expectedByteLength,
      observedSha256: null,
      observedByteLength: null,
    };
  }
  // The HTTP path gate passes null when a file is missing, empty, or outside
  // the processed directory. Keep that result auditable without opening an
  // untrusted path.
  const observed = filePath ? await hashFileWithIdentity(filePath) : null;
  if (!observed) {
    return {
      outcome: 'unavailable',
      expectedSha256,
      expectedByteLength,
      observedSha256: null,
      observedByteLength: null,
      observedIdentity: null,
    };
  }
  const matches = observed.byteLength === expectedByteLength && observed.sha256 === expectedSha256;
  return {
    outcome: matches ? 'verified' : 'mismatch',
    expectedSha256,
    expectedByteLength,
    observedSha256: observed.sha256,
    observedByteLength: observed.byteLength,
    observedIdentity: observed.identity,
  };
}

/** Open once, verify through that descriptor, and return the same descriptor
 * for streaming. A rename/replacement after this call cannot redirect the
 * response to different bytes. Legacy rows without a digest remain
 * unverifiable but still use the retained descriptor. */
export async function openMediaWithIntegrity(
  database: RewindDatabase,
  jobId: string,
  filePath: string | null,
  options: { readSource?: FileHandle['read']; maxSnapshotBytes?: number } = {},
): Promise<OpenedMediaIntegrity> {
  const stored = readStoredIntegrity(database, jobId);
  const expectedSha256 = stored?.sha256 ?? null;
  const expectedByteLength = stored?.byteLength ?? null;
  const hasExpectation = Boolean(
    expectedSha256 && expectedByteLength !== null && expectedByteLength > 0,
  );
  const unavailable = (): OpenedMediaIntegrity => ({
    result: {
      outcome: hasExpectation ? 'unavailable' : 'unverifiable',
      expectedSha256,
      expectedByteLength,
      observedSha256: null,
      observedByteLength: null,
    },
    handle: null,
    byteLength: null,
  });
  if (!filePath) return unavailable();

  let handle: FileHandle | null = null;
  let source: FileHandle | null = null;
  try {
    source = await open(filePath, READ_ONLY_NO_FOLLOW);
    const details = await source.stat();
    if (!details.isFile() || details.size <= 0) {
      await source.close();
      return unavailable();
    }
    if (
      options.maxSnapshotBytes !== undefined &&
      (!Number.isSafeInteger(options.maxSnapshotBytes) || details.size > options.maxSnapshotBytes)
    ) {
      await source.close();
      source = null;
      return { ...unavailable(), byteLength: details.size, capacityExceeded: true };
    }
    handle = await openAnonymousSnapshot(dirname(filePath));
    const observed = await snapshotAndHashOpenFile(
      source,
      handle,
      options.readSource ?? source.read.bind(source),
      options.maxSnapshotBytes,
    );
    await source.close();
    source = null;
    if (observed === 'over-limit') {
      await handle.close().catch(() => undefined);
      handle = null;
      return { ...unavailable(), byteLength: details.size, capacityExceeded: true };
    }
    if (!observed) {
      await handle.close().catch(() => undefined);
      return {
        result: {
          outcome: 'unavailable',
          expectedSha256,
          expectedByteLength,
          observedSha256: null,
          observedByteLength: null,
        },
        handle: null,
        byteLength: details.size,
      };
    }
    if (!hasExpectation) {
      return {
        result: {
          outcome: 'unverifiable',
          expectedSha256,
          expectedByteLength,
          observedSha256: null,
          observedByteLength: null,
        },
        handle,
        byteLength: observed.byteLength,
      };
    }
    const matches =
      observed.byteLength === expectedByteLength && observed.sha256 === expectedSha256;
    return {
      result: {
        outcome: matches ? 'verified' : 'mismatch',
        expectedSha256,
        expectedByteLength,
        observedSha256: observed.sha256,
        observedByteLength: observed.byteLength,
      },
      handle,
      byteLength: observed.byteLength,
    };
  } catch {
    await source?.close().catch(() => undefined);
    await handle?.close().catch(() => undefined);
    return unavailable();
  }
}

export interface IntegrityAuditInput {
  jobId: string;
  kind: 'clip' | 'film' | 'download';
  result: MediaIntegrityResult;
  actorMemberId?: string | null;
  timestamp?: string;
}

/**
 * Record one durable, redacted audit event per broken output. Repeated byte
 * range requests for the same damaged file, and repeated premiere polls, do
 * not multiply rows; a re-finalized output whose digest changed records a new
 * event because the earlier observation no longer describes the file.
 */
export function recordIntegrityFailure(
  database: RewindDatabase,
  input: IntegrityAuditInput,
): boolean {
  const resourceId = `${input.kind}:${input.jobId}`;
  // Auditing is best effort. The caller must still refuse to serve the
  // damaged file, so a failed audit never escalates into a 500. BEGIN
  // IMMEDIATE serializes the dedupe read and event insert across connections.
  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionStarted = true;

    const verifiedAt = readStoredIntegrity(database, input.jobId)?.verifiedAt ?? null;
    const latest = database
      .prepare(
        `SELECT occurred_at AS occurredAt FROM audit_events
         WHERE resource_id = ? AND event_type = ?
         ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      )
      .get(resourceId, MEDIA_INTEGRITY_EVENT) as { occurredAt?: string } | undefined;
    if (
      latest?.occurredAt &&
      ((verifiedAt && Date.parse(latest.occurredAt) >= Date.parse(verifiedAt)) || !verifiedAt)
    ) {
      database.exec('COMMIT');
      transactionStarted = false;
      return false;
    }

    recordAuditEvent(database, {
      eventType: MEDIA_INTEGRITY_EVENT,
      actorMemberId: input.actorMemberId ?? null,
      resourceId,
      result: 'denied',
      ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    });
    database.exec('COMMIT');
    transactionStarted = false;
  } catch {
    if (transactionStarted) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Keep audit failures best effort even if SQLite already aborted it.
      }
    }
    return false;
  }
  return true;
}

/** True only for outcomes that must never reach a client. */
export function integrityBlocksServing(result: MediaIntegrityResult): boolean {
  return result.outcome === 'mismatch' || result.outcome === 'unavailable';
}

import { createHash } from 'node:crypto';
import { closeSync, createReadStream, openSync, readSync, statSync, constants } from 'node:fs';

import { recordAuditEvent } from '../audit';
import type { RewindDatabase } from '../db';

/** One digest/size pair recorded when a clip or film output is finalized. */
export interface FileIntegrity {
  sha256: string;
  byteLength: number;
}

/**
 * The auditable event recorded when a stored output no longer matches the
 * digest persisted at finalization. It stays distinct from a processing
 * failure so an operator can tell tampering and truncation apart from an
 * FFmpeg problem.
 */
export const MEDIA_INTEGRITY_EVENT = 'media.integrity_failed' as const;

export type MediaIntegrityOutcome = 'verified' | 'unverifiable' | 'mismatch' | 'unavailable';

export interface MediaIntegrityResult {
  outcome: MediaIntegrityOutcome;
  expectedSha256: string | null;
  expectedByteLength: number | null;
  observedSha256: string | null;
  observedByteLength: number | null;
}

/** Hash a non-empty server-owned file. The caller owns path policy; this
 * helper only reports what it observed on disk. */
export async function hashFile(path: string): Promise<FileIntegrity | null> {
  try {
    const details = statSync(path);
    if (!details.isFile() || details.size <= 0) return null;
  } catch {
    return null;
  }
  return await new Promise<FileIntegrity | null>((resolvePromise) => {
    const digest = createHash('sha256');
    let byteLength = 0;
    let settled = false;
    const finish = (value: FileIntegrity | null) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      byteLength += chunk.length;
      digest.update(chunk);
    });
    stream.on('error', () => finish(null));
    stream.on('end', () => {
      if (byteLength <= 0) {
        finish(null);
        return;
      }
      finish({ sha256: digest.digest('hex'), byteLength });
    });
  });
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
  filePath: string,
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
  const observed = await hashFile(filePath);
  if (!observed) {
    return {
      outcome: 'unavailable',
      expectedSha256,
      expectedByteLength,
      observedSha256: null,
      observedByteLength: null,
    };
  }
  const matches = observed.byteLength === expectedByteLength && observed.sha256 === expectedSha256;
  return {
    outcome: matches ? 'verified' : 'mismatch',
    expectedSha256,
    expectedByteLength,
    observedSha256: observed.sha256,
    observedByteLength: observed.byteLength,
  };
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
  const verifiedAt = readStoredIntegrity(database, input.jobId)?.verifiedAt ?? null;
  const latest = database
    .prepare(
      `SELECT occurred_at AS occurredAt FROM audit_events
       WHERE resource_id = ? AND event_type = ?
       ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    )
    .get(resourceId, MEDIA_INTEGRITY_EVENT) as { occurredAt?: string } | undefined;
  if (latest?.occurredAt && verifiedAt && Date.parse(latest.occurredAt) >= Date.parse(verifiedAt)) {
    return false;
  }
  if (latest?.occurredAt && !verifiedAt) return false;
  // Auditing is best effort. The caller must still refuse to serve the
  // damaged file, so a failed audit insert never escalates into a 500.
  try {
    recordAuditEvent(database, {
      eventType: MEDIA_INTEGRITY_EVENT,
      actorMemberId: input.actorMemberId ?? null,
      resourceId,
      result: 'denied',
      ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    });
  } catch {
    return false;
  }
  return true;
}

/** True only for outcomes that must never reach a client. */
export function integrityBlocksServing(result: MediaIntegrityResult): boolean {
  return result.outcome === 'mismatch' || result.outcome === 'unavailable';
}

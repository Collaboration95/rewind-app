import { lstatSync, type Stats } from 'node:fs';

import type { RewindDatabase } from '../db';
import {
  readStoredIntegrity,
  verifyMediaIntegrity,
  type FileIdentity,
  type MediaIntegrityResult,
} from '../media/integrity';

interface CacheEntry {
  expectedSha256: string;
  expectedByteLength: number;
  identity: FileIdentity;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 20_000;
const DEFAULT_MAX_ENTRIES = 512;

function identityOf(details: {
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
    modifiedAtMs: Number(details.mtimeMs),
    changedAtMs: Number(details.ctimeMs),
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.byteLength === right.byteLength &&
    left.modifiedAtMs === right.modifiedAtMs &&
    left.changedAtMs === right.changedAtMs
  );
}

/** Short-lived cache for archive listings only. Media serving always snapshots and hashes. */
export class ArchiveIntegrityCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  hasVerified(path: string, expectedSha256: string, expectedByteLength: number): boolean {
    const cached = this.entries.get(path);
    if (!cached) return false;
    let details: Stats;
    try {
      details = lstatSync(path);
    } catch {
      this.entries.delete(path);
      return false;
    }
    const valid =
      details.isFile() &&
      this.now() < cached.expiresAt &&
      cached.expectedSha256 === expectedSha256 &&
      cached.expectedByteLength === expectedByteLength &&
      sameIdentity(identityOf(details), cached.identity);
    if (!valid) {
      this.entries.delete(path);
      return false;
    }
    this.entries.delete(path);
    this.entries.set(path, cached);
    return true;
  }

  rememberVerified(
    path: string,
    expectedSha256: string,
    expectedByteLength: number,
    identity: FileIdentity,
  ): void {
    this.entries.delete(path);
    this.entries.set(path, {
      expectedSha256,
      expectedByteLength,
      identity,
      expiresAt: this.now() + this.ttlMs,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

const archiveIntegrityCache = new ArchiveIntegrityCache();

export async function verifyArchiveListingIntegrity(
  database: RewindDatabase,
  jobId: string,
  path: string | null,
): Promise<MediaIntegrityResult> {
  const stored = readStoredIntegrity(database, jobId);
  const expectedSha256 = stored?.sha256 ?? null;
  const expectedByteLength = stored?.byteLength ?? null;
  if (!path || !expectedSha256 || !expectedByteLength || expectedByteLength <= 0) {
    return verifyMediaIntegrity(database, jobId, path);
  }
  if (archiveIntegrityCache.hasVerified(path, expectedSha256, expectedByteLength)) {
    return {
      outcome: 'verified',
      expectedSha256,
      expectedByteLength,
      observedSha256: expectedSha256,
      observedByteLength: expectedByteLength,
    };
  }
  const result = await verifyMediaIntegrity(database, jobId, path);
  if (result.outcome === 'verified' && result.observedIdentity) {
    archiveIntegrityCache.rememberVerified(
      path,
      expectedSha256,
      expectedByteLength,
      result.observedIdentity,
    );
  }
  return result;
}

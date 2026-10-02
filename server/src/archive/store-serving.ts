import { resolve } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { RewindDatabase } from '../db';
import type { StoredJobOptions } from '../jobs';
import { decodeMediaRef } from '../media/store';
import { materializeStoredMedia } from '../media/store-files';
import {
  integrityBlocksServing,
  openMediaWithIntegrity,
  recordIntegrityFailure,
} from '../media/integrity';
import { mediaServingBudget } from '../media/serving-budget';

export async function openStoredServingFile(
  database: RewindDatabase,
  jobId: string,
  kind: 'film' | 'clip' | 'download',
  outputPath: string,
  dataDir: string,
  actorMemberId: string | null,
  now: Date,
  options: StoredJobOptions,
): Promise<
  | { path: string; handle: FileHandle; size: number; releaseBudget: () => void }
  | { capacityExceeded: true; reason: 'size_policy' | 'busy' }
  | null
> {
  if (!options.mediaStore || !options.mediaEnvironment) return null;
  let ownedHandle: FileHandle | null = null;
  let temporary: Awaited<ReturnType<typeof materializeStoredMedia>> | undefined;
  let lease: ReturnType<typeof mediaServingBudget.tryAcquire> = null;
  try {
    const ref = decodeMediaRef(outputPath);
    const row = database
      .prepare(
        `SELECT group_id AS groupId, status, output_path AS path,
      output_sha256 AS sha256, output_bytes AS byteLength, output_verified_at AS verifiedAt
      FROM media_jobs WHERE id = ? AND kind = ?`,
      )
      .get(jobId, kind) as
      | {
          groupId: string;
          status: string;
          path: string;
          sha256: string;
          byteLength: number;
          verifiedAt: string;
        }
      | undefined;
    if (
      !row ||
      row.status !== 'ready' ||
      row.path !== outputPath ||
      !row.verifiedAt ||
      row.sha256 !== ref.sha256 ||
      row.byteLength !== ref.byteLength ||
      ref.prefix === 'incoming'
    )
      return null;
    if (ref.byteLength > mediaServingBudget.maxSnapshotBytes)
      return { capacityExceeded: true, reason: 'size_policy' };
    lease = mediaServingBudget.tryAcquire(ref.byteLength);
    if (!lease) return { capacityExceeded: true, reason: 'busy' };
    temporary = await materializeStoredMedia(
      options.mediaStore,
      {
        environment: options.mediaEnvironment,
        groupId: row.groupId,
      },
      ref,
      resolve(dataDir, 'media/serving'),
    );
    const opened = await openMediaWithIntegrity(database, jobId, temporary.path, {
      maxSnapshotBytes: ref.byteLength,
    });
    ownedHandle = opened.handle;
    await temporary.dispose();
    temporary = undefined;
    if (
      integrityBlocksServing(opened.result) ||
      !opened.handle ||
      opened.byteLength !== ref.byteLength
    ) {
      recordIntegrityFailure(database, {
        jobId,
        kind,
        result: opened.result,
        actorMemberId,
        timestamp: now.toISOString(),
      });
      await opened.handle?.close();
      lease.release();
      return null;
    }
    // Identity is revalidated by the route after awaits and before streaming.
    const current = database
      .prepare(
        'SELECT output_path AS path, output_sha256 AS sha256, output_bytes AS byteLength, status FROM media_jobs WHERE id = ?',
      )
      .get(jobId) as typeof row;
    if (
      !current ||
      current.status !== 'ready' ||
      current.path !== row.path ||
      current.sha256 !== row.sha256 ||
      current.byteLength !== row.byteLength
    ) {
      await opened.handle.close();
      lease.release();
      return null;
    }
    const ownedLease = lease;
    ownedHandle = null;
    return {
      path: outputPath,
      handle: opened.handle,
      size: opened.byteLength,
      releaseBudget: () => ownedLease.release(),
    };
  } catch {
    await ownedHandle?.close().catch(() => undefined);
    lease?.release();
    return null;
  } finally {
    await temporary?.dispose().catch(() => undefined);
  }
}

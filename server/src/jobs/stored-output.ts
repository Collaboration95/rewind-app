// Private-media context and serving of ready job outputs from the media store.
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import type { RewindDatabase } from '../db';
import { FfmpegProcessingError } from '../ffmpeg';
import {
  decodeMediaRef,
  isMediaRef,
  MediaStoreError,
  verifyStoredMedia,
  type MediaScope,
  type MediaStore,
} from '../media/store';
import { hashFile } from '../media/integrity';

export interface StoredJobOptions {
  /** Explicit injection: absence keeps disk rollback, remote refs fail closed. */
  mediaStore?: MediaStore;
  mediaEnvironment?: string;
}

export async function resolveProcessedMediaPath(value: string, outputDir: string): Promise<string> {
  try {
    const [source, processed] = await Promise.all([realpath(value), realpath(outputDir)]);
    const remainder = relative(processed, source);
    if (!remainder || remainder.startsWith('..') || isAbsolute(remainder)) {
      throw new Error('outside processed directory');
    }
    return source;
  } catch {
    throw new FfmpegProcessingError(
      'source_unavailable',
      'A processed clip is unavailable for film compilation.',
    );
  }
}

export function storedContext(
  options: StoredJobOptions,
  groupId: string,
): { store: MediaStore; scope: MediaScope } {
  if (!options.mediaStore || !options.mediaEnvironment) throw new MediaStoreError('scope_mismatch');
  return { store: options.mediaStore, scope: { environment: options.mediaEnvironment, groupId } };
}

interface ReadyOutputRow {
  groupId: string;
  status: string;
  path: string;
  sha256: string;
  byteLength: number;
  verifiedAt: string;
}

/** The persisted output digest/size/verified timestamp, or null when unfinished. */
function readReadyOutput(database: RewindDatabase, jobId: string): ReadyOutputRow | null {
  const row = database
    .prepare(
      `SELECT group_id AS groupId, status, output_path AS path,
    output_sha256 AS sha256, output_bytes AS byteLength, output_verified_at AS verifiedAt
    FROM media_jobs WHERE id = ?`,
    )
    .get(jobId) as Partial<ReadyOutputRow> | undefined;
  if (
    !row ||
    row.status !== 'ready' ||
    !row.path ||
    !row.sha256 ||
    !/^[a-f0-9]{64}$/.test(row.sha256) ||
    !row.byteLength ||
    !row.verifiedAt ||
    !Number.isFinite(Date.parse(row.verifiedAt))
  )
    return null;
  return row as ReadyOutputRow;
}

/** Cheap per-request check for Archive listing, premiere status and download
 * grants: the finalized row plus the object's existence and size. Bytes are
 * hashed when /media/access streams them, and at release by verifyReadyJobOutput. */
export async function servableJobOutput(
  database: RewindDatabase,
  jobId: string,
  outputPath: string,
  options: StoredJobOptions & { outputDir: string },
): Promise<'servable' | 'unfinished' | 'missing'> {
  const row = readReadyOutput(database, jobId);
  if (!row || row.path !== outputPath) return 'unfinished';
  try {
    if (isMediaRef(row.path)) {
      const ref = decodeMediaRef(row.path);
      if (
        ref.prefix === 'incoming' ||
        ref.sha256 !== row.sha256 ||
        ref.byteLength !== row.byteLength
      )
        return 'unfinished';
      const { store, scope } = storedContext(options, row.groupId);
      await store.head(scope, ref);
      return 'servable';
    }
    const details = await stat(await resolveProcessedMediaPath(row.path, options.outputDir));
    return details.isFile() && details.size === row.byteLength ? 'servable' : 'missing';
  } catch {
    return 'missing';
  }
}

/** Async publication guard for lifecycle release. Always requires the persisted
 * output digest/size/verified timestamp, including legacy disk. */
export async function verifyReadyJobOutput(
  database: RewindDatabase,
  jobId: string,
  options: StoredJobOptions & { outputDir: string },
): Promise<boolean> {
  const row = readReadyOutput(database, jobId);
  if (!row) return false;
  try {
    if (isMediaRef(row.path)) {
      const ref = decodeMediaRef(row.path);
      if (ref.prefix === 'incoming') return false;
      const { store, scope } = storedContext(options, row.groupId);
      await verifyStoredMedia(store, scope, ref, {
        sha256: row.sha256,
        byteLength: row.byteLength,
      });
    } else {
      const path = await resolveProcessedMediaPath(row.path, options.outputDir);
      const observed = await hashFile(path);
      if (!observed || observed.sha256 !== row.sha256 || observed.byteLength !== row.byteLength)
        return false;
    }
    // A concurrent deletion/replacement must not be mistaken for this verified output.
    const current = database
      .prepare(
        'SELECT status, output_path AS path, output_sha256 AS sha256, output_bytes AS byteLength, output_verified_at AS verifiedAt FROM media_jobs WHERE id = ?',
      )
      .get(jobId) as ReadyOutputRow | undefined;
    return Boolean(
      current &&
      current.status === 'ready' &&
      current.path === row.path &&
      current.sha256 === row.sha256 &&
      current.byteLength === row.byteLength &&
      current.verifiedAt === row.verifiedAt,
    );
  } catch {
    return false;
  }
}

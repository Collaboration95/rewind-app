// Group media authorisation and verified, budgeted media streaming.
import { realpath, stat, type FileHandle } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { isAbsolute, relative, resolve } from 'node:path';

import { openStoredServingFile } from '../archive/store-serving';
import { validateRealSession } from '../auth';
import { membershipProfileId, selectedGroupId } from '../auth/identity-cache';
import { type RuntimeConfig } from '../config';
import { getPremiereFilm, type RewindDatabase } from '../db';
import { servableJobOutput, type StoredJobOptions } from '../jobs';
import {
  integrityBlocksServing,
  openMediaWithIntegrity,
  recordIntegrityFailure,
} from '../media/integrity';
import { mediaServingBudget, releaseBudgetWhenSnapshotCloses } from '../media/serving-budget';
import { isMediaRef } from '../media/store';

import { RuntimeServerOptions } from './context';
import {
  authCorsHeaders,
  authJson,
  authOriginIsAllowed,
  authToken,
  authTransportIsSecure,
  sendDenied,
} from './respond';

export interface AuthorisedMediaIdentity {
  groupId: string;
  memberId: string;
  accountId: string;
}

/**
 * Requests carry only the opaque real-account bearer/cookie credential; their
 * account, selected group, and profile identity are resolved here rather than
 * accepted from query parameters.
 */
export function requireAuthorisedMediaGroup(
  request: IncomingMessage,
  database: RewindDatabase,
  response: ServerResponse,
  config: RuntimeConfig,
  now: Date,
  groupId: string | null,
): AuthorisedMediaIdentity | null {
  if (!authTransportIsSecure(request, config) || !authOriginIsAllowed(request, config)) {
    authJson(request, response, config, 403, {
      error: 'auth_transport_unavailable',
      message: 'Media access is unavailable on this connection.',
    });
    return null;
  }
  const token = authToken(request);
  const session = token
    ? validateRealSession(database, token, now)
    : { status: 'invalid' as const };
  if (session.status !== 'valid') {
    authJson(request, response, config, 401, {
      error: 'session_required',
      message: 'A valid sign-in is required.',
    });
    return null;
  }
  const profileId = groupId ? signedInProfileId(database, session.account.id, groupId, now) : null;
  if (!groupId || !profileId) {
    sendDenied(response, config);
    return null;
  }
  for (const [name, value] of Object.entries(authCorsHeaders(request, config)))
    response.setHeader(name, value);
  return { accountId: session.account.id, groupId, memberId: profileId };
}

/**
 * The signed-in account's profile in `groupId` when that group is the
 * account's selected group, else null. Uses the identity cache: a member
 * stays a member for this process until the server itself changes it.
 */
export function signedInProfileId(
  database: RewindDatabase,
  accountId: string,
  groupId: string,
  now: Date,
): string | null {
  const at = now.getTime();
  const selected = selectedGroupId(database, accountId, at, () => {
    const row = database
      .prepare('SELECT group_id AS groupId FROM real_account_group_selections WHERE account_id = ?')
      .get(accountId) as { groupId?: string } | undefined;
    return row?.groupId ?? null;
  });
  if (selected !== groupId) return null;
  return membershipProfileId(database, accountId, groupId, at, () => {
    const row = database
      .prepare(
        `SELECT profile_id AS profileId FROM real_group_memberships
         WHERE account_id = ? AND group_id = ? AND accepted_at IS NOT NULL`,
      )
      .get(accountId, groupId) as { profileId?: string } | undefined;
    return row?.profileId ?? null;
  });
}

export function mediaIdentityIsCurrent(
  request: IncomingMessage,
  database: RewindDatabase,
  identity: AuthorisedMediaIdentity,
  now: Date,
): boolean {
  const token = authToken(request);
  const session = token
    ? validateRealSession(database, token, now)
    : { status: 'invalid' as const };
  return Boolean(
    session.status === 'valid' &&
    session.account.id === identity.accountId &&
    signedInProfileId(database, identity.accountId, identity.groupId, now) === identity.memberId,
  );
}

type PremiereState = 'locked' | 'processing' | 'delayed' | 'ready';

export function protectedAssetPath(
  database: RewindDatabase,
  request: IncomingMessage,
  identity: AuthorisedMediaIdentity,
  jobId: string,
  kind: 'film' | 'clip',
  purpose: 'play' | 'download',
  options: RuntimeServerOptions,
  now: Date,
): string | null {
  const sessionToken = authToken(request);
  if (!sessionToken || !options.mediaCapabilities) return null;
  const row = database
    .prepare(
      `SELECT output_path AS outputPath, output_sha256 AS sha256,
    output_bytes AS byteLength FROM media_jobs WHERE id = ? AND group_id = ? AND kind = ?
    AND status = 'ready' AND output_verified_at IS NOT NULL`,
    )
    .get(jobId, identity.groupId, kind) as
    { outputPath: string; sha256: string; byteLength: number } | undefined;
  if (!row?.outputPath || !row.sha256 || !row.byteLength) return null;
  return options.mediaCapabilities.issue(
    {
      sessionToken,
      accountId: identity.accountId,
      groupId: identity.groupId,
      memberId: identity.memberId,
      jobId,
      kind,
      purpose,
      ...row,
    },
    now,
  );
}

export function premiereState(film: ReturnType<typeof getPremiereFilm>): PremiereState {
  if (!film) return 'locked';
  if (film.filmStatus === 'failed' && film.attemptCount >= 3) return 'delayed';
  if (
    film.releaseStatus === 'published' &&
    film.filmStatus === 'ready' &&
    film.outputPath &&
    film.filmId
  ) {
    return 'ready';
  }
  if (film.cycleStatus === 'revealing' || film.cycleStatus === 'archived') return 'processing';
  return 'locked';
}

async function resolveOwnedProcessedPath(
  outputPath: string,
  dataDir: string,
): Promise<string | null> {
  try {
    const processedDir = resolve(dataDir, 'media', 'processed');
    const [film, processed] = await Promise.all([realpath(outputPath), realpath(processedDir)]);
    const remainder = relative(processed, film);
    if (!remainder || remainder.startsWith('..') || isAbsolute(remainder)) return null;
    const details = await stat(film);
    return details.isFile() && details.size > 0 ? film : null;
  } catch {
    return null;
  }
}

/**
 * Confirm a finalized output still matches the digest recorded when it was
 * published, then return its current size for streaming. A tampered or
 * truncated file is reported as unavailable and audited; the caller turns
 * that into the same safe not-found response used for other absent media.
 */
export async function openVerifiedServingFile(
  database: RewindDatabase,
  jobId: string,
  kind: 'clip' | 'film',
  outputPath: string,
  dataDir: string,
  actorMemberId: string | null,
  now: Date,
  storage: StoredJobOptions = {},
): Promise<
  | { path: string; handle: FileHandle; size: number; releaseBudget: () => void }
  | { capacityExceeded: true; reason: 'size_policy' | 'busy' }
  | null
> {
  if (isMediaRef(outputPath))
    return openStoredServingFile(
      database,
      jobId,
      kind,
      outputPath,
      dataDir,
      actorMemberId,
      now,
      storage,
    );
  const path = await resolveOwnedProcessedPath(outputPath, dataDir);
  if (!path) return null;
  const sourceDetails = await stat(path).catch(() => null);
  if (!sourceDetails?.isFile() || sourceDetails.size <= 0) return null;
  if (sourceDetails.size > mediaServingBudget.maxSnapshotBytes) {
    return { capacityExceeded: true, reason: 'size_policy' };
  }
  const budgetLease = mediaServingBudget.tryAcquire(sourceDetails.size);
  if (!budgetLease) return { capacityExceeded: true, reason: 'busy' };
  let opened: Awaited<ReturnType<typeof openMediaWithIntegrity>>;
  try {
    opened = await openMediaWithIntegrity(database, jobId, path, {
      maxSnapshotBytes: sourceDetails.size,
    });
  } catch (error) {
    budgetLease.release();
    throw error;
  }
  if (opened.capacityExceeded) {
    budgetLease.release();
    return { capacityExceeded: true, reason: 'size_policy' };
  }
  if (integrityBlocksServing(opened.result)) {
    recordIntegrityFailure(database, {
      jobId,
      kind,
      result: opened.result,
      actorMemberId,
      timestamp: now.toISOString(),
    });
    await opened.handle?.close().catch(() => undefined);
    budgetLease.release();
    return null;
  }
  if (!opened.handle || !opened.byteLength || opened.byteLength > sourceDetails.size) {
    await opened.handle?.close().catch(() => undefined);
    budgetLease.release();
    return null;
  }
  return {
    path,
    handle: opened.handle,
    size: opened.byteLength,
    releaseBudget: () => budgetLease.release(),
  };
}

/** Archive listing, premiere status and download grants advertise media from
 * its finalized row; /media/access hashes the bytes when it streams them. A
 * missing or resized object is audited here because it can no longer be played. */
export async function servableOutput(
  database: RewindDatabase,
  jobId: string,
  kind: 'clip' | 'film',
  outputPath: string,
  dataDir: string,
  actorMemberId: string | null,
  now: Date,
  storage: StoredJobOptions,
): Promise<boolean> {
  const state = await servableJobOutput(database, jobId, outputPath, {
    ...storage,
    outputDir: resolve(dataDir, 'media/processed'),
  });
  if (state === 'missing')
    recordIntegrityFailure(database, {
      jobId,
      kind,
      actorMemberId,
      timestamp: now.toISOString(),
    });
  return state === 'servable';
}

/** Keep only released archive entries that are still servable. The returned
 * objects never include the server-side path. */
export async function filterServableArchive<T extends { id: string; outputPath: string }>(
  database: RewindDatabase,
  kind: 'clip' | 'film',
  entries: T[],
  dataDir: string,
  actorMemberId: string | null,
  now: Date,
  storage: StoredJobOptions = {},
): Promise<Omit<T, 'outputPath'>[]> {
  const servable = await Promise.all(
    entries.map((entry) =>
      servableOutput(
        database,
        entry.id,
        kind,
        entry.outputPath,
        dataDir,
        actorMemberId,
        now,
        storage,
      ),
    ),
  );
  return entries.filter((_, index) => servable[index]).map(({ outputPath, ...safe }) => safe);
}

export function streamMp4(
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
  handle: FileHandle,
  size: number,
  attachmentName?: string,
  releaseBudget: () => void = () => {},
): void {
  if (response.destroyed || response.writableEnded) {
    void handle.close().finally(releaseBudget);
    return;
  }
  const range = request.headers.range;
  let start = 0;
  let end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      void handle.close().finally(releaseBudget);
      response.writeHead(416, { 'Content-Range': `bytes */${size}` });
      response.end();
      return;
    }
    if (!match[1] && !match[2]) {
      void handle.close().finally(releaseBudget);
      response.writeHead(416, { 'Content-Range': `bytes */${size}` });
      response.end();
      return;
    }
    if (!match[1]) {
      const suffixLength = Number(match[2]);
      start = Math.max(0, size - suffixLength);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : end;
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= size
    ) {
      void handle.close().finally(releaseBudget);
      response.writeHead(416, { 'Content-Range': `bytes */${size}` });
      response.end();
      return;
    }
    end = Math.min(end, size - 1);
  }
  const status = range ? 206 : 200;
  try {
    response.writeHead(status, {
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin':
        response.getHeader('Access-Control-Allow-Origin') ?? config.allowOrigin,
      'Cache-Control': 'no-store',
      'Content-Length': String(end - start + 1),
      'Content-Type': 'video/mp4',
      ...(attachmentName
        ? { 'Content-Disposition': `attachment; filename="${attachmentName}"` }
        : {}),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
  } catch {
    void handle.close().finally(releaseBudget);
    return;
  }
  if (request.method === 'HEAD') {
    response.end();
    void handle.close().finally(releaseBudget);
    return;
  }
  const stream = handle.createReadStream({ start, end, autoClose: true });
  releaseBudgetWhenSnapshotCloses({ release: releaseBudget }, stream, response);
  stream
    .on('error', () => {
      response.destroy();
    })
    .pipe(response);
}

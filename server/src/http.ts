import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, realpath, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { URL } from 'node:url';

import { requestObservation } from './observability';

import { SERVICE_VERSION, type RuntimeConfig } from './config';
import {
  registerReminderDestination,
  listReminderDestinations,
  disableReminderDestination,
  listReminderOutbox,
  reminderDeliveryStatus,
  type ReminderProviders,
} from './reminders/outbox';
import {
  getContribution,
  getCurrentCycle,
  getGroup,
  getMediaJob,
  getPremiereFilm,
  getReleasedFilmDownload,
  getReleasedOwnClipDownload,
  getMessage,
  isMember,
  listReleasedArchive,
  listProfiles,
  restoreFixture,
  schemaReadiness,
  type RewindDatabase,
} from './db';
import {
  SUPPORTED_CHAT_REACTION,
  createChatMessage,
  latestChatEventId,
  listChatEvents,
  listChatEventMetadata,
  listChatHistoryPage,
  toggleChatReaction,
} from './chat';
import { encodeSseCheckpoint, encodeSseEvent, RealtimeHub } from './realtime';
import { advanceCycleLifecycle, advanceDemoCycle, publishCycleRelease } from './cycles';
import { classifyDemoSession } from './session/contract';
import {
  authorizeSessionMember,
  authorizeSessionOwner,
  SAFE_DENIAL,
  type ProtectedResource,
} from './policy';
import {
  createDemoSession,
  getDemoSession,
  invalidateDemoSession,
  isActiveDemoSession,
  validateDemoSession,
} from './session';
import { extractDemoRequestIdentity, type DemoRequestIdentity } from './session/request';
import { createGroup } from './groups';
import { acceptInvite, createInvite } from './invites';
import { deleteContribution } from './contributions';
import {
  ContributionLedgerQueryError,
  listContributionLedger,
  parseLedgerLimit,
  parseLedgerState,
} from './contributions/ledger';
import {
  cancelClipUpload,
  claimStagedSource,
  acquireStagedSourceLock,
  cleanupStagedSource,
  cleanupStagedSourcePath,
  createClipUpload,
  findStagedSource,
  markStagedSourceReady,
  recordClipMediaMetadata,
  reclaimStagedSource,
  resetStagedSourceClaim,
  registerStagedIntake,
  stagedSourceId,
  stagedSourcePath,
  waitForStagedIntakesIdle,
  type ClipUploadInput,
} from './media';
import {
  integrityBlocksServing,
  openMediaWithIntegrity,
  recordIntegrityFailure,
  verifyMediaIntegrity,
} from './media/integrity';
import {
  getCompilationJob,
  processClipJob,
  processCompilationJob,
  verifyReadyJobOutput,
  type StoredJobOptions,
} from './jobs';
import {
  requestUploadIntent,
  getUploadIntentStatus,
  completeUploadIntent,
  reconcileUploadIntent,
  type UploadIntentDependencies,
  type UploadIntentRequest,
  type UploadIntentFailure,
} from './media/upload-intents';
import { MediaCapabilities } from './archive/capabilities';
import { openStoredServingFile } from './archive/store-serving';
import { isMediaRef, decodeMediaRef } from './media/store';
import { maybeCleanupOrphanedStagedSources } from './jobs/staged-cleanup-scheduler';
import {
  listQueueJobs,
  parseQueueKind,
  parseQueueLimit,
  parseQueueStatus,
  QueueQueryError,
} from './jobs/queue';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { generateSyntheticDemoClip, probeClipWithFfmpeg, probePhotoWithFfmpeg } from './ffmpeg';
import { decodePageCursor, encodePageCursor } from './archive/cursor';
import { verifyArchiveListingIntegrity } from './archive/integrity-cache';
import { mediaServingBudget, releaseBudgetWhenSnapshotCloses } from './media/serving-budget';
import {
  authenticateRealAccount,
  createRealAccount,
  REAL_SESSION_COOKIE,
  revokeRealSession,
  validateRealSession,
  verifyRealAccountPassword,
} from './auth';
import { purgeRealAccount, removeStoredMedia } from './auth/deletion';
import {
  blockMember,
  filmSegments,
  listBlockedMembers,
  removeContribution,
  reportContent,
  unblockMember,
  visibleChatEvent,
} from './groups/safety';
import {
  createRealGroup,
  getCurrentRealGroup,
  getRealGroup,
  listRealGroups,
  selectRealGroup,
} from './groups/real';
import {
  acceptRealGroupInvite,
  createRealGroupInvite,
  revokeRealGroupInvite,
} from './groups/invites';
import { listRealGroupMemberSummaries } from './groups/profiles';
import {
  getRealReminderPreference,
  updateRealGroupSettings,
  updateRealReminderPreference,
} from './groups/settings';

export interface HealthPayload {
  ok: boolean;
  service: 'rewind-local-runtime';
  version: string;
  ready: boolean;
  checks: {
    sqlite: true;
    ffmpegConfigured: boolean;
    schema: ReturnType<typeof schemaReadiness>;
  };
  addresses: { local: string; lan: string | null };
}

export function getLanAddress(): string | null {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const network of interfaces ?? []) {
      if (network.family === 'IPv4' && !network.internal) return network.address;
    }
  }
  return null;
}

function sendJson(
  response: ServerResponse,
  config: RuntimeConfig,
  status: number,
  body: unknown,
): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range, Last-Event-ID',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Origin':
      response.getHeader('Access-Control-Allow-Origin') ?? config.allowOrigin,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(encoded);
}

function sendNotFound(response: ServerResponse, config: RuntimeConfig): void {
  sendJson(response, config, 404, {
    error: 'not_found',
    message: 'The requested resource was not found.',
  });
}

function sendDenied(response: ServerResponse, config: RuntimeConfig): void {
  sendJson(response, config, SAFE_DENIAL.status, SAFE_DENIAL);
}

function sendBadRequest(response: ServerResponse, config: RuntimeConfig): void {
  sendJson(response, config, 400, {
    error: 'invalid_request',
    message: 'The cycle advance must be a positive whole number of seconds.',
  });
}

function decodePathSegment(
  encodedSegment: string,
  response: ServerResponse,
  config: RuntimeConfig,
): string | null {
  try {
    return decodeURIComponent(encodedSegment);
  } catch (error) {
    if (error instanceof URIError) {
      sendJson(response, config, 400, {
        error: 'invalid_request',
        message: 'The request contains a malformed path segment.',
      });
      return null;
    }
    throw error;
  }
}

function sendSessionRequired(response: ServerResponse, config: RuntimeConfig): void {
  sendJson(response, config, 401, {
    error: 'session_required',
    message: 'Choose Demo access before changing local Demo data.',
  });
}

function acceptsEventStream(request: IncomingMessage): boolean {
  const accept = request.headers.accept;
  return (Array.isArray(accept) ? accept.join(',') : (accept ?? ''))
    .toLowerCase()
    .includes('text/event-stream');
}

/** EventSource hides HTTP response bodies/statuses behind a generic onerror.
 * Return a terminal SSE frame when the caller is a standard EventSource so
 * clients can stop reconnecting and disable chat actions deterministically. */
function sendRealtimeAccessDenied(
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
  status: number = SAFE_DENIAL.status,
  message: string = SAFE_DENIAL.message,
): boolean {
  if (!acceptsEventStream(request)) return false;
  const hasAuthCredential = Boolean(request.headers.authorization || request.headers.cookie);
  response.writeHead(200, {
    ...(hasAuthCredential
      ? authCorsHeaders(request, config)
      : { 'Access-Control-Allow-Origin': config.allowOrigin }),
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range, Last-Event-ID',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no',
  });
  response.end(
    [
      'event: access-denied',
      `data: ${JSON.stringify({ allowed: false, status, error: 'forbidden', message })}`,
      '',
      '',
    ].join('\n'),
  );
  return true;
}

function writeRealtimeAccessDenied(
  response: ServerResponse,
  status: number = SAFE_DENIAL.status,
  message: string = SAFE_DENIAL.message,
): void {
  if (response.writableEnded || response.destroyed) return;
  response.write(
    [
      'event: access-denied',
      `data: ${JSON.stringify({ allowed: false, status, error: 'forbidden', message })}`,
      '',
      '',
    ].join('\n'),
  );
}

function requireSessionIdentity(
  database: RewindDatabase,
  url: URL,
  response: ServerResponse,
  config: RuntimeConfig,
  now: Date,
): DemoRequestIdentity | null {
  const identity = extractDemoRequestIdentity(database, url, now);
  if (!identity.ok) {
    sendSessionRequired(response, config);
    return null;
  }
  return identity.identity;
}

/**
 * Authorise one group-scoped route using only the persisted session context.
 * The requested group is a resource selector, never an alternate identity.
 */
function requireAuthorisedGroup(
  database: RewindDatabase,
  url: URL,
  response: ServerResponse,
  config: RuntimeConfig,
  now: Date,
  groupId: string | null,
  resource: ProtectedResource,
): DemoRequestIdentity | null {
  const identity = requireSessionIdentity(database, url, response, config, now);
  if (!identity) return null;
  if (
    !groupId ||
    identity.groupId !== groupId ||
    !authorizeSessionMember(database, groupId, identity, resource).allowed
  ) {
    sendDenied(response, config);
    return null;
  }
  return identity;
}

interface AuthorisedMediaIdentity {
  groupId: string;
  memberId: string;
  accountId?: string;
  /** Demo-only lifecycle fence. Real sessions are revalidated from the token. */
  sessionId?: string;
}

/**
 * Media may be uploaded by either the isolated Demo session or an authenticated
 * real account. Real requests carry only the opaque bearer/cookie credential;
 * their account, selected group, and profile identity are resolved here rather
 * than accepted from query parameters.
 */
function requireAuthorisedMediaGroup(
  request: IncomingMessage,
  database: RewindDatabase,
  url: URL,
  response: ServerResponse,
  config: RuntimeConfig,
  now: Date,
  groupId: string | null,
  resource: ProtectedResource,
): AuthorisedMediaIdentity | null {
  const hasBearer = typeof request.headers.authorization === 'string';
  const hasRealCookie =
    typeof request.headers.cookie === 'string' &&
    request.headers.cookie
      .split(';')
      .some((part) => part.trim().startsWith(`${REAL_SESSION_COOKIE}=`));
  if (!hasBearer && !hasRealCookie) {
    return requireAuthorisedGroup(database, url, response, config, now, groupId, resource);
  }

  // Real media authority never comes from the Demo sessionId query. Reject a
  // mixed request instead of silently choosing whichever credential succeeds.
  if (url.searchParams.has('sessionId')) {
    sendDenied(response, config);
    return null;
  }
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
  const selected = getCurrentRealGroup(database, session.account.id);
  const membership = groupId
    ? (database
        .prepare(
          `SELECT profile_id AS profileId FROM real_group_memberships
           WHERE account_id = ? AND group_id = ? AND accepted_at IS NOT NULL`,
        )
        .get(session.account.id, groupId) as { profileId?: string } | undefined)
    : undefined;
  if (
    !groupId ||
    selected?.group.id !== groupId ||
    !membership?.profileId ||
    !isMember(database, groupId, membership.profileId)
  ) {
    sendDenied(response, config);
    return null;
  }
  for (const [name, value] of Object.entries(authCorsHeaders(request, config)))
    response.setHeader(name, value);
  return { accountId: session.account.id, groupId, memberId: membership.profileId };
}

function mediaIdentityIsCurrent(
  request: IncomingMessage,
  database: RewindDatabase,
  identity: AuthorisedMediaIdentity,
  now: Date,
): boolean {
  if (identity.sessionId) {
    return isActiveDemoSession(database, identity.sessionId, identity.memberId, now);
  }
  if (!identity.accountId) return false;
  const token = authToken(request);
  const session = token
    ? validateRealSession(database, token, now)
    : { status: 'invalid' as const };
  return Boolean(
    session.status === 'valid' &&
    session.account.id === identity.accountId &&
    getCurrentRealGroup(database, identity.accountId)?.group.id === identity.groupId &&
    isMember(database, identity.groupId, identity.memberId),
  );
}

function requireAuthorisedChatGroup(
  request: IncomingMessage,
  database: RewindDatabase,
  url: URL,
  response: ServerResponse,
  config: RuntimeConfig,
  at: Date,
  groupId: string,
): AuthorisedMediaIdentity | null {
  const hasBearer = typeof request.headers.authorization === 'string';
  const hasRealCookie =
    typeof request.headers.cookie === 'string' &&
    request.headers.cookie
      .split(';')
      .some((part) => part.trim().startsWith(`${REAL_SESSION_COOKIE}=`));
  if (!hasBearer && !hasRealCookie) {
    const demo = extractDemoRequestIdentity(database, url, at);
    if (!demo.ok) {
      if (
        !sendRealtimeAccessDenied(
          request,
          response,
          config,
          401,
          'Choose Demo access before joining chat.',
        )
      ) {
        sendSessionRequired(response, config);
      }
      return null;
    }
    if (
      demo.identity.groupId !== groupId ||
      !authorizeSessionMember(database, groupId, demo.identity, 'message').allowed
    ) {
      if (!sendRealtimeAccessDenied(request, response, config)) sendDenied(response, config);
      return null;
    }
    return {
      groupId: demo.identity.groupId,
      memberId: demo.identity.memberId,
      sessionId: demo.identity.sessionId,
    };
  }

  const deny = (status: number = SAFE_DENIAL.status, message: string = SAFE_DENIAL.message) => {
    if (!sendRealtimeAccessDenied(request, response, config, status, message)) {
      sendJson(response, config, status, {
        error: status === 401 ? 'session_required' : 'forbidden',
        message,
      });
    }
    return null;
  };
  if (url.searchParams.has('sessionId')) return deny();
  if (!authTransportIsSecure(request, config) || !authOriginIsAllowed(request, config)) {
    return deny(403, 'Chat access is unavailable on this connection.');
  }
  const token = authToken(request);
  const session = token ? validateRealSession(database, token, at) : { status: 'invalid' as const };
  if (session.status !== 'valid') {
    return deny(401, 'Sign in again to join this group chat.');
  }
  const selected = getCurrentRealGroup(database, session.account.id);
  const membership = database
    .prepare(
      `SELECT profile_id AS profileId FROM real_group_memberships
       WHERE account_id = ? AND group_id = ? AND accepted_at IS NOT NULL`,
    )
    .get(session.account.id, groupId) as { profileId?: string } | undefined;
  if (
    selected?.group.id !== groupId ||
    !membership?.profileId ||
    !isMember(database, groupId, membership.profileId)
  ) {
    return deny();
  }
  for (const [name, value] of Object.entries(authCorsHeaders(request, config)))
    response.setHeader(name, value);
  return { accountId: session.account.id, groupId, memberId: membership.profileId };
}

function chatIdentityIsCurrent(
  request: IncomingMessage,
  database: RewindDatabase,
  identity: AuthorisedMediaIdentity,
  at: Date,
): boolean {
  if (identity.sessionId) {
    const current = getDemoSession(database, identity.sessionId);
    return Boolean(
      current &&
      current.actor.memberId === identity.memberId &&
      current.groupId === identity.groupId &&
      classifyDemoSession(current.expiresAt, current.invalidatedAt, at) === 'valid' &&
      isMember(database, identity.groupId, identity.memberId),
    );
  }
  if (!identity.accountId) return false;
  const token = authToken(request);
  const session = token ? validateRealSession(database, token, at) : { status: 'invalid' as const };
  const membership = database
    .prepare(
      `SELECT profile_id AS profileId FROM real_group_memberships
       WHERE account_id = ? AND group_id = ? AND accepted_at IS NOT NULL`,
    )
    .get(identity.accountId, identity.groupId) as { profileId?: string } | undefined;
  return Boolean(
    session.status === 'valid' &&
    session.account.id === identity.accountId &&
    getCurrentRealGroup(database, identity.accountId)?.group.id === identity.groupId &&
    membership?.profileId === identity.memberId &&
    isMember(database, identity.groupId, identity.memberId),
  );
}

function requireAuthorisedOwner(
  database: RewindDatabase,
  url: URL,
  response: ServerResponse,
  config: RuntimeConfig,
  now: Date,
  groupId: string | null,
): DemoRequestIdentity | null {
  const identity = requireSessionIdentity(database, url, response, config, now);
  if (!identity) return null;
  if (
    !groupId ||
    identity.groupId !== groupId ||
    !authorizeSessionOwner(database, groupId, identity).allowed
  ) {
    sendDenied(response, config);
    return null;
  }
  return identity;
}

type PremiereState = 'locked' | 'processing' | 'delayed' | 'ready';

function protectedAssetPath(
  database: RewindDatabase,
  request: IncomingMessage,
  identity: AuthorisedMediaIdentity,
  jobId: string,
  kind: 'film' | 'clip',
  purpose: 'play' | 'download',
  options: RuntimeServerOptions,
  now: Date,
): string | null {
  if (identity.sessionId)
    return `/${kind}s/${encodeURIComponent(jobId)}/${purpose}?groupId=${encodeURIComponent(identity.groupId)}&sessionId=${encodeURIComponent(identity.sessionId)}`;
  const sessionToken = authToken(request);
  if (!sessionToken || !identity.accountId || !options.mediaCapabilities) return null;
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

function premiereState(film: ReturnType<typeof getPremiereFilm>): PremiereState {
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

function cycleCompilationJob(database: RewindDatabase, groupId: string, cycleId: string) {
  const row = database
    .prepare(
      `SELECT id FROM media_jobs
       WHERE group_id = ? AND cycle_id = ? AND kind = 'film'
       ORDER BY created_at ASC, id ASC LIMIT 1`,
    )
    .get(groupId, cycleId) as { id?: string } | undefined;
  return row?.id ? getCompilationJob(database, row.id, groupId) : null;
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
async function openVerifiedServingFile(
  database: RewindDatabase,
  jobId: string,
  kind: 'clip' | 'film' | 'download',
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

/** Archive/premiere checks need only a momentary verified read. Actual media
 * routes retain the handle and stream from it. */
async function verifiedServingPath(
  database: RewindDatabase,
  jobId: string,
  kind: 'clip' | 'film' | 'download',
  outputPath: string,
  dataDir: string,
  actorMemberId: string | null,
  now: Date,
  storage: StoredJobOptions = {},
): Promise<{ path: string; size: number } | null> {
  if (isMediaRef(outputPath)) {
    if (
      !(await verifyReadyJobOutput(database, jobId, {
        ...storage,
        outputDir: resolve(dataDir, 'media/processed'),
      }))
    )
      return null;
    return { path: outputPath, size: decodeMediaRef(outputPath).byteLength };
  }
  const path = await resolveOwnedProcessedPath(outputPath, dataDir);
  const result = await verifyMediaIntegrity(database, jobId, path);
  if (integrityBlocksServing(result)) {
    recordIntegrityFailure(database, {
      jobId,
      kind,
      result,
      actorMemberId,
      timestamp: now.toISOString(),
    });
    return null;
  }
  if (!path) return null;
  const details = await stat(path).catch(() => null);
  if (!details || !details.isFile() || details.size <= 0) return null;
  return { path, size: details.size };
}

async function verifiedArchiveListingPath(
  database: RewindDatabase,
  jobId: string,
  kind: 'clip' | 'film',
  outputPath: string,
  dataDir: string,
  actorMemberId: string | null,
  now: Date,
  storage: StoredJobOptions = {},
): Promise<{ path: string; size: number } | null> {
  if (isMediaRef(outputPath)) {
    if (
      !(await verifyReadyJobOutput(database, jobId, {
        ...storage,
        outputDir: resolve(dataDir, 'media/processed'),
      }))
    )
      return null;
    return { path: outputPath, size: decodeMediaRef(outputPath).byteLength };
  }
  const path = await resolveOwnedProcessedPath(outputPath, dataDir);
  const result = await verifyArchiveListingIntegrity(database, jobId, path);
  if (integrityBlocksServing(result)) {
    recordIntegrityFailure(database, {
      jobId,
      kind,
      result,
      actorMemberId,
      timestamp: now.toISOString(),
    });
    return null;
  }
  if (!path) return null;
  const details = await stat(path).catch(() => null);
  if (!details || !details.isFile() || details.size <= 0) return null;
  return { path, size: details.size };
}

/**
 * Keep only released archive entries whose retained bytes still match their
 * finalized digest. The returned objects never include the server-side path.
 */
async function filterServableArchive<T extends { id: string; outputPath: string }>(
  database: RewindDatabase,
  kind: 'clip' | 'film',
  entries: T[],
  dataDir: string,
  actorMemberId: string | null,
  now: Date,
  storage: StoredJobOptions = {},
): Promise<Omit<T, 'outputPath'>[]> {
  const safeEntries: Omit<T, 'outputPath'>[] = [];
  // Process at most three hashes at once. Archive calls await the film batch
  // before the clip batch, so the whole request stays within this bound.
  for (let index = 0; index < entries.length; index += 3) {
    const batch = await Promise.all(
      entries.slice(index, index + 3).map(async (entry) => {
        const served = await verifiedArchiveListingPath(
          database,
          entry.id,
          kind,
          entry.outputPath,
          dataDir,
          actorMemberId,
          now,
          storage,
        );
        if (!served) return null;
        const { outputPath, ...safe } = entry;
        return safe;
      }),
    );
    for (const entry of batch) {
      if (entry !== null) safeEntries.push(entry as Omit<T, 'outputPath'>);
    }
  }
  return safeEntries;
}

function streamMp4(
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

export interface RuntimeServerOptions extends StoredJobOptions {
  reminderProviders?: ReminderProviders;
  reminderWebPushPublicKey?: string;
  uploadIntents?: Omit<UploadIntentDependencies, 'now'>;
  mediaCapabilities?: MediaCapabilities;
  now?: () => Date;
  realtimeHub?: RealtimeHub;
  realtimeHeartbeatIntervalMs?: number;
  requestLimiters?: RequestLimiters;
}

interface RequestLimiters {
  intake: ConcurrencyLimiter;
  processing: ConcurrencyLimiter;
  archive: ConcurrencyLimiter;
  registration: RegistrationRateLimiter;
  chat: AccountTokenBucket;
  groups: AccountTokenBucket;
  safety: AccountTokenBucket;
  streams: AccountStreamLimiter;
}

class ConcurrencyLimiter {
  private active = 0;

  constructor(private readonly limit: number) {}

  tryAcquire(): (() => void) | null {
    if (this.active >= this.limit) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }
}

function createRequestLimiters(config: RuntimeConfig): RequestLimiters {
  return {
    intake: new ConcurrencyLimiter(config.maxConcurrentIntakes),
    processing: new ConcurrencyLimiter(config.maxConcurrentProcessing),
    archive: new ConcurrencyLimiter(2),
    registration: new RegistrationRateLimiter(),
    chat: new AccountTokenBucket(30, 60 * 1000),
    groups: new AccountTokenBucket(5, 24 * 60 * 60 * 1000),
    safety: new AccountTokenBucket(20, 10 * 60 * 1000),
    streams: new AccountStreamLimiter(),
  };
}

const REGISTRATION_WINDOW_MS = 15 * 60 * 1000;
const REGISTRATION_ATTEMPT_LIMIT = 5;
const MAX_REGISTRATION_RATE_LIMIT_SOURCES = 10_000;

class RegistrationRateLimiter {
  private readonly sources = new Map<string, { count: number; windowStartedAt: number }>();

  tryAcquire(
    source: string,
    nowMs: number,
  ): { allowed: true } | { allowed: false; retryAfter: number } {
    for (const [key, bucket] of this.sources) {
      if (nowMs - bucket.windowStartedAt >= REGISTRATION_WINDOW_MS) this.sources.delete(key);
    }

    const bucket = this.sources.get(source);
    if (!bucket) {
      if (this.sources.size >= MAX_REGISTRATION_RATE_LIMIT_SOURCES) {
        return { allowed: false, retryAfter: Math.ceil(REGISTRATION_WINDOW_MS / 1000) };
      }
      this.sources.set(source, { count: 1, windowStartedAt: nowMs });
      return { allowed: true };
    }
    if (bucket.count >= REGISTRATION_ATTEMPT_LIMIT) {
      return {
        allowed: false,
        retryAfter: Math.max(
          1,
          Math.ceil((bucket.windowStartedAt + REGISTRATION_WINDOW_MS - nowMs) / 1000),
        ),
      };
    }
    bucket.count += 1;
    return { allowed: true };
  }
}

// ponytail: one runtime host today. Before scaling to multiple hosts, move
// buckets and stream leases to a shared atomic store (for example Redis).
class AccountTokenBucket {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
  ) {}
  tryAcquire(
    accountId: string,
    nowMs: number,
  ): { allowed: true } | { allowed: false; retryAfter: number } {
    for (const [key, bucket] of this.buckets) {
      if (nowMs - bucket.updatedAt >= this.windowMs) this.buckets.delete(key);
    }
    let bucket = this.buckets.get(accountId);
    if (!bucket) {
      if (this.buckets.size >= MAX_REGISTRATION_RATE_LIMIT_SOURCES)
        return { allowed: false, retryAfter: Math.ceil(this.windowMs / 1000) };
      bucket = { tokens: this.capacity, updatedAt: nowMs };
      this.buckets.set(accountId, bucket);
    }
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + (Math.max(0, nowMs - bucket.updatedAt) * this.capacity) / this.windowMs,
    );
    bucket.updatedAt = nowMs;
    if (bucket.tokens < 1)
      return {
        allowed: false,
        retryAfter: Math.max(
          1,
          Math.ceil(((1 - bucket.tokens) * this.windowMs) / this.capacity / 1000),
        ),
      };
    bucket.tokens -= 1;
    return { allowed: true };
  }
}

class AccountStreamLimiter {
  private readonly active = new Map<string, number>();
  tryAcquire(accountId: string): (() => void) | null {
    const count = this.active.get(accountId) ?? 0;
    if (count >= 5) return null;
    this.active.set(accountId, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.active.get(accountId) ?? 1) - 1;
      if (next > 0) this.active.set(accountId, next);
      else this.active.delete(accountId);
    };
  }
}

function enforceRateLimit(
  limiter: Pick<RegistrationRateLimiter, 'tryAcquire'>,
  key: string,
  now: Date,
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
  message: string,
): boolean {
  const result = limiter.tryAcquire(key, now.getTime());
  if (result.allowed) return true;
  authJson(
    request,
    response,
    config,
    429,
    { error: 'rate_limited', message },
    { 'Retry-After': String(result.retryAfter) },
  );
  finishRejectedRequest(request, response);
  return false;
}

function acquireRequestCapacity(
  limiter: ConcurrencyLimiter,
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
): (() => void) | null {
  const release = limiter.tryAcquire();
  if (release) return release;
  sendJson(response, config, 429, {
    error: 'concurrency_limit',
    message: 'The server is at its configured concurrency limit. Retry the request.',
  });
  finishRejectedRequest(request, response);
  return null;
}

const MAX_JSON_BODY_BYTES = 64 * 1024;

type RequestPolicyCode = 'request_timeout' | 'payload_too_large' | 'request_aborted';

class RequestPolicyError extends Error {
  constructor(
    readonly status: 408 | 413,
    readonly code: RequestPolicyCode,
    message: string,
  ) {
    super(message);
    this.name = 'RequestPolicyError';
  }
}

function requestTimeoutError(scope: 'request' | 'upload'): RequestPolicyError {
  return new RequestPolicyError(
    408,
    'request_timeout',
    scope === 'upload'
      ? 'The upload did not complete within the configured timeout.'
      : 'The request body did not arrive within the configured idle timeout.',
  );
}

function requestAbortedError(): RequestPolicyError {
  return new RequestPolicyError(
    408,
    'request_aborted',
    'The request was aborted before it completed.',
  );
}

function payloadTooLargeError(message: string): RequestPolicyError {
  return new RequestPolicyError(413, 'payload_too_large', message);
}

function sendRequestPolicyError(
  response: ServerResponse,
  config: RuntimeConfig,
  error: RequestPolicyError,
): void {
  if (response.headersSent || response.destroyed || response.writableEnded) return;
  sendJson(response, config, error.status, { error: error.code, message: error.message });
}

function finishRejectedRequest(request: IncomingMessage, response: ServerResponse): void {
  if (request.complete || request.destroyed) return;
  response.once('finish', () => {
    if (!request.destroyed) request.destroy();
  });
}

interface ConsumeRequestBodyOptions {
  maxBytes: number;
  idleTimeoutMs: number;
  totalTimeoutMs?: number;
  tooLargeMessage: string;
  onChunk: (chunk: Buffer) => Promise<void> | void;
}

async function consumeRequestBody(
  request: IncomingMessage,
  options: ConsumeRequestBodyOptions,
): Promise<number> {
  const contentLength = Number(request.headers['content-length'] ?? Number.NaN);
  if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
    throw payloadTooLargeError(options.tooLargeMessage);
  }

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let terminalError: RequestPolicyError | undefined;
  let rejectTimeout!: (error: RequestPolicyError) => void;
  let rejectAbort!: (error: RequestPolicyError) => void;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });

  const failWith = (reject: (error: RequestPolicyError) => void, error: RequestPolicyError) => {
    if (terminalError) return;
    terminalError = error;
    reject(error);
  };
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => failWith(rejectTimeout, requestTimeoutError('request')),
      options.idleTimeoutMs,
    );
  };
  const onAborted = () => failWith(rejectAbort, requestAbortedError());
  const onClose = () => {
    if (!request.complete) onAborted();
  };
  const onError = () => onAborted();
  request.once('aborted', onAborted);
  request.once('close', onClose);
  request.once('error', onError);
  resetIdleTimer();
  if (options.totalTimeoutMs !== undefined) {
    totalTimer = setTimeout(
      () => failWith(rejectTimeout, requestTimeoutError('upload')),
      options.totalTimeoutMs,
    );
  }

  const bodyPromise = (async () => {
    try {
      let bytes = 0;
      for await (const chunk of request) {
        if (terminalError) throw terminalError;
        resetIdleTimer();
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        bytes += buffer.byteLength;
        if (bytes > options.maxBytes) throw payloadTooLargeError(options.tooLargeMessage);
        await options.onChunk(buffer);
        if (terminalError) throw terminalError;
      }
      if (
        request.aborted ||
        (request as IncomingMessage & { readableAborted?: boolean }).readableAborted
      ) {
        throw requestAbortedError();
      }
      if (!request.complete) throw requestAbortedError();
      return bytes;
    } catch (error) {
      if (
        request.aborted ||
        (request as IncomingMessage & { readableAborted?: boolean }).readableAborted
      ) {
        throw requestAbortedError();
      }
      throw error;
    }
  })();

  try {
    return await Promise.race([bodyPromise, timeoutPromise, abortPromise]);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    request.removeListener('aborted', onAborted);
    request.removeListener('close', onClose);
    request.removeListener('error', onError);
    void bodyPromise.catch(() => undefined);
  }
}

async function requestBody(
  request: IncomingMessage,
  config: RuntimeConfig,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  const size = await consumeRequestBody(request, {
    maxBytes,
    idleTimeoutMs: config.httpIdleTimeoutMs,
    tooLargeMessage:
      maxBytes === MAX_JSON_BODY_BYTES
        ? 'The JSON request body must be 64 KiB or smaller.'
        : `The JSON request body must be ${maxBytes} bytes or smaller.`,
    onChunk: (chunk) => {
      chunks.push(chunk);
    },
  });
  if (!size) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const MAX_STAGED_SOURCE_BYTES = 50 * 1024 * 1024;

async function writeStagedChunk(
  output: ReturnType<typeof createWriteStream>,
  chunk: Buffer,
): Promise<void> {
  if (output.destroyed) throw new Error('staged source output closed');
  if (output.write(chunk)) return;
  await new Promise<void>((resolvePromise, reject) => {
    const cleanup = () => {
      output.removeListener('drain', onDrain);
      output.removeListener('error', onError);
      output.removeListener('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('staged source output closed'));
    };
    output.once('drain', onDrain);
    output.once('error', onError);
    output.once('close', onClose);
  });
}

async function stageSourceBody(
  request: IncomingMessage,
  stagingDir: string,
  sourcePath: string,
  config: RuntimeConfig,
  maxBytes = MAX_STAGED_SOURCE_BYTES,
): Promise<number> {
  const contentLength = Number(request.headers['content-length'] ?? Number.NaN);
  if (Number.isFinite(contentLength) && contentLength <= 0) {
    throw new Error('empty source');
  }
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw payloadTooLargeError(
      maxBytes < MAX_STAGED_SOURCE_BYTES
        ? 'The photo source must be 10 MiB or smaller.'
        : 'The clip source must be 50 MiB or smaller.',
    );
  }
  await mkdir(stagingDir, { recursive: true });
  const partialPath = `${sourcePath}.${randomUUID()}.part`;
  let output: ReturnType<typeof createWriteStream> | null = null;
  let outputError: Error | null = null;
  let committed = false;
  const onOutputError = (error: Error) => {
    outputError = error;
  };
  try {
    output = createWriteStream(partialPath, { flags: 'wx' });
    // Keep an error listener attached for the entire stream lifetime. Without
    // it, an asynchronous filesystem exception after a successful write can
    // escape the request promise and leave the intake claim behind.
    output.on('error', onOutputError);
    const bytes = await consumeRequestBody(request, {
      maxBytes,
      idleTimeoutMs: config.httpIdleTimeoutMs,
      totalTimeoutMs: config.uploadTimeoutMs,
      tooLargeMessage:
        maxBytes < MAX_STAGED_SOURCE_BYTES
          ? 'The photo source must be 10 MiB or smaller.'
          : 'The clip source must be 50 MiB or smaller.',
      onChunk: async (buffer) => {
        if (outputError || !output) throw outputError ?? new Error('staged source output closed');
        await writeStagedChunk(output, buffer);
        if (outputError) throw outputError;
      },
    });
    if (outputError || !output) throw outputError ?? new Error('staged source output closed');
    const stream = output;
    await new Promise<void>((resolvePromise, reject) => {
      const onFinish = () => {
        cleanup();
        resolvePromise();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        stream.removeListener('finish', onFinish);
        stream.removeListener('error', onError);
      };
      stream.once('finish', onFinish);
      stream.once('error', onError);
      stream.end();
    });
    if (outputError) throw outputError;
    if (bytes <= 0) throw new Error('empty source');
    await rename(partialPath, sourcePath);
    committed = true;
    return bytes;
  } finally {
    if (!committed) {
      // Keep the error listener attached while destroying a failed stream;
      // destroy() may report its filesystem error on a later turn.
      if (output && !output.closed) {
        // destroy() can run before the asynchronous open has created the leaf.
        // Wait for close before unlinking, otherwise that late open can leave
        // a .part file after the claim has already become retryable.
        const stream = output;
        await new Promise<void>((resolveClosed) => {
          stream.once('close', resolveClosed);
          stream.destroy();
        });
      }
      cleanupStagedSourcePath(partialPath, stagingDir);
      await rm(partialPath, { force: true }).catch(() => undefined);
    } else {
      output?.removeListener('error', onOutputError);
      output?.destroy();
    }
  }
}

function cleanupFailedStagedClaim(
  database: RewindDatabase,
  sourceUri: string,
  sourcePath: string,
  claimGeneration: number,
  stagingDir: string,
): void {
  let reset = false;
  try {
    reset = resetStagedSourceClaim(database, sourceUri, sourcePath, claimGeneration);
  } finally {
    const current = findStagedSource(database, sourceUri);
    if (
      !reset &&
      current?.status === 'staged' &&
      current.claimGeneration === claimGeneration &&
      current.sourcePath === sourcePath
    ) {
      cleanupStagedSource(database, sourceUri, stagingDir, {
        expectedSourcePath: sourcePath,
        expectedClaimGeneration: claimGeneration,
      });
    } else if (
      reset ||
      !current ||
      current.claimGeneration !== claimGeneration ||
      current.sourcePath !== sourcePath
    ) {
      // A failed request may lose its generation fence to a reclaim while its
      // body/probe callback is still unwinding. Only remove the old physical
      // path when the current row no longer owns that exact generation/path.
      cleanupStagedSourcePath(sourcePath, stagingDir);
    }
  }
}

function healthPayload(config: RuntimeConfig, database: RewindDatabase): HealthPayload {
  const localHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const lan = getLanAddress();
  const schema = schemaReadiness(database);
  return {
    ok: schema.ready,
    service: 'rewind-local-runtime',
    version: SERVICE_VERSION,
    ready: schema.ready,
    checks: { sqlite: true, ffmpegConfigured: Boolean(config.ffmpegBin), schema },
    addresses: {
      local: `http://${localHost}:${config.port}`,
      lan: lan ? `http://${lan}:${config.port}` : null,
    },
  };
}

export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
  database: RewindDatabase,
  options: RuntimeServerOptions = {},
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const requestLimiters = options.requestLimiters ?? createRequestLimiters(config);
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (request.method === 'OPTIONS') {
    if (
      url.pathname.startsWith('/auth/') ||
      url.pathname.startsWith('/real/') ||
      url.pathname.startsWith('/realtime/groups/') ||
      /^\/(?:archive$|media\/access\/|cycles\/[^/]+\/premiere$|films\/|clips\/|contributions\/)/.test(
        url.pathname,
      )
    ) {
      const corsHeaders = authCorsHeaders(request, config);
      response.writeHead(204, {
        ...corsHeaders,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range, Last-Event-ID',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS',
        'Cache-Control': 'no-store',
      });
      response.end();
      return;
    }
    response.writeHead(204, {
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range, Last-Event-ID',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Origin':
        response.getHeader('Access-Control-Allow-Origin') ?? config.allowOrigin,
    });
    response.end();
    return;
  }
  const mediaHead =
    request.method === 'HEAD' &&
    /^\/(?:media\/access\/|films\/[^/]+\/(?:play|download)$|clips\/[^/]+\/download$)/.test(
      url.pathname,
    );
  if (!mediaHead && !['GET', 'POST', 'DELETE'].includes(request.method ?? '')) {
    const send =
      url.pathname.startsWith('/auth/') || url.pathname.startsWith('/real/')
        ? authJson.bind(null, request, response, config)
        : sendJson.bind(null, response, config);
    send(405, {
      error: 'method_not_allowed',
      message: 'Only GET, POST, and DELETE are supported.',
    });
    return;
  }

  const mediaAccessMatch = url.pathname.match(/^\/media\/access\/([A-Za-z0-9_-]{43})$/);
  if (mediaAccessMatch && (request.method === 'GET' || request.method === 'HEAD')) {
    if (!authTransportIsSecure(request, config) || !authOriginIsAllowed(request, config))
      return sendDenied(response, config);
    const presented = authToken(request);
    if (
      (request.headers.authorization ||
        (request.headers.cookie ?? '').includes(`${REAL_SESSION_COOKIE}=`)) &&
      !presented
    )
      return sendDenied(response, config);
    const grant = options.mediaCapabilities?.resolve(
      database,
      mediaAccessMatch[1],
      now(),
      presented,
    );
    if (!grant) return sendNotFound(response, config);
    for (const [name, value] of Object.entries(authCorsHeaders(request, config)))
      response.setHeader(name, value);
    const served = await openVerifiedServingFile(
      database,
      grant.jobId,
      grant.kind,
      grant.outputPath,
      config.dataDir,
      grant.memberId,
      now(),
      options,
    );
    if (!served) return sendNotFound(response, config);
    if ('capacityExceeded' in served) {
      sendJson(response, config, served.reason === 'size_policy' ? 413 : 429, {
        error: 'media_unavailable',
        message: 'Media delivery is unavailable. Retry shortly.',
      });
      return;
    }
    if (!options.mediaCapabilities?.resolve(database, mediaAccessMatch[1], now(), presented)) {
      await served.handle.close();
      served.releaseBudget();
      return sendNotFound(response, config);
    }
    streamMp4(
      request,
      response,
      config,
      served.handle,
      served.size,
      grant.purpose === 'download'
        ? grant.kind === 'film'
          ? 'rewind-group-film.mp4'
          : 'rewind-my-clip.mp4'
        : undefined,
      served.releaseBudget,
    );
    return;
  }

  if (url.pathname.startsWith('/auth/')) {
    await handleRealAuthRequest(
      request,
      response,
      config,
      database,
      requestLimiters.registration,
      url,
      now(),
      options,
    );
    return;
  }

  if (url.pathname.startsWith('/real/')) {
    await handleRealGroupRequest(request, response, config, database, url, now(), now, options);
    return;
  }

  if (url.pathname === '/health' || url.pathname === '/version') {
    const health = healthPayload(config, database);
    sendJson(response, config, health.ready ? 200 : 503, health);
    return;
  }

  if (url.pathname === '/sessions/demo' && request.method === 'POST') {
    const body = await requestBody(request, config);
    if (!body || typeof body.memberId !== 'string') {
      sendJson(response, config, 400, {
        error: 'invalid_demo_access',
        message: 'Choose a synthetic Demo member to continue.',
      });
      return;
    }
    const result = createDemoSession(database, {
      memberId: body.memberId,
      groupId: typeof body.groupId === 'string' ? body.groupId : undefined,
      now: now(),
    });
    if (!result.ok) {
      if (result.reason === 'membership_denied') return sendDenied(response, config);
      sendJson(response, config, 400, {
        error: 'invalid_demo_access',
        message: 'That synthetic Demo member is not available.',
      });
      return;
    }
    sendJson(response, config, 201, { session: result.session });
    return;
  }

  const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const sessionId = decodePathSegment(sessionMatch[1], response, config);
    if (sessionId === null) return;
    if (request.method === 'GET') {
      const result = validateDemoSession(database, sessionId, now());
      if (result.status === 'valid') {
        sendJson(response, config, 200, { session: result.session });
      } else if (result.status === 'invalid') {
        sendJson(response, config, 404, {
          error: 'not_found',
          message: 'Demo access was not found.',
        });
      } else {
        sendJson(response, config, 401, {
          error: result.status,
          message: 'This Demo access is no longer active. Choose a Demo member again.',
        });
      }
      return;
    }
    if (request.method === 'DELETE') {
      const result = invalidateDemoSession(database, sessionId, now());
      if (!result.ok) {
        if (result.reason === 'missing') {
          sendJson(response, config, 404, {
            error: 'not_found',
            message: 'Demo access was not found.',
          });
        } else {
          sendJson(response, config, 409, {
            error: 'already_inactive',
            message: 'This Demo access is already inactive.',
          });
        }
        return;
      }
      sendJson(response, config, 200, { session: result.session });
      return;
    }
  }

  if (url.pathname === '/demo/reset' && request.method === 'POST') {
    // Reset refusals must not touch even session/audit rows. Resolve the same
    // persisted Demo identity and lifecycle without validation side effects.
    const requireResetOwner = (): DemoRequestIdentity | null => {
      const sessionId = url.searchParams.get('sessionId');
      const session = sessionId ? getDemoSession(database, sessionId) : null;
      if (
        !session ||
        classifyDemoSession(session.expiresAt, session.invalidatedAt, now()) !== 'valid'
      ) {
        sendSessionRequired(response, config);
        return null;
      }
      const identity: DemoRequestIdentity = {
        sessionId: session.id,
        memberId: session.actor.memberId,
        groupId: session.groupId,
        session,
      };
      if (!authorizeSessionOwner(database, identity.groupId, identity).allowed) {
        sendDenied(response, config);
        return null;
      }
      return identity;
    };
    if (!requireResetOwner()) return;
    const stagingDir = resolve(config.dataDir, 'media', 'staging');
    const releaseStagingLock = await acquireStagedSourceLock(stagingDir);
    try {
      await waitForStagedIntakesIdle();
      // Recheck authority after waiting. The database write lock then fences
      // foreign-data inspection and synchronous media deletion with no await.
      if (!requireResetOwner()) return;
      if (!restoreFixture(database, now(), resolve(config.dataDir, 'media'))) {
        sendJson(response, config, 409, {
          error: 'demo_reset_unavailable',
          message: 'Demo reset is unavailable while non-Demo data is present.',
        });
        return;
      }
      await mkdir(stagingDir, { recursive: true });
      sendJson(response, config, 200, { reset: true });
    } finally {
      releaseStagingLock();
    }
    return;
  }

  const realtimeHistoryMessagesMatch = url.pathname.match(
    /^\/realtime\/groups\/([^/]+)\/messages$/,
  );
  if (realtimeHistoryMessagesMatch && request.method === 'GET') {
    const groupId = decodePathSegment(realtimeHistoryMessagesMatch[1], response, config);
    if (groupId === null) return;
    const identity = requireAuthorisedChatGroup(
      request,
      database,
      url,
      response,
      config,
      now(),
      groupId,
    );
    if (!identity) return;
    const rawLimit = url.searchParams.get('limit');
    const parsedLimit = rawLimit === null ? 100 : Number(rawLimit);
    const rawBeforeEventId = url.searchParams.get('beforeEventId');
    const beforeEventId = rawBeforeEventId === null ? undefined : Number(rawBeforeEventId);
    if (
      !Number.isInteger(parsedLimit) ||
      parsedLimit < 1 ||
      parsedLimit > 100 ||
      (beforeEventId !== undefined && (!Number.isSafeInteger(beforeEventId) || beforeEventId < 1))
    ) {
      sendJson(response, config, 400, {
        error: 'invalid_chat_cursor',
        message: 'The chat history page cursor or size is invalid.',
      });
      return;
    }
    const page = listChatHistoryPage(database, identity.groupId, {
      beforeEventId,
      limit: parsedLimit,
    });
    const viewer = identity.accountId;
    if (viewer)
      page.events = page.events.flatMap((event) => {
        const visible = visibleChatEvent(database, viewer, event);
        return visible ? [visible] : [];
      });
    sendJson(response, config, 200, page);
    return;
  }

  const realtimeEventsMatch = url.pathname.match(/^\/realtime\/groups\/([^/]+)\/events$/);
  if (realtimeEventsMatch && request.method === 'GET') {
    const groupId = decodePathSegment(realtimeEventsMatch[1], response, config);
    if (groupId === null) return;
    const identity = requireAuthorisedChatGroup(
      request,
      database,
      url,
      response,
      config,
      now(),
      groupId,
    );
    if (!identity) return;

    const lastEventHeader = request.headers['last-event-id'];
    const lastEventValue = Array.isArray(lastEventHeader)
      ? lastEventHeader[0]
      : (lastEventHeader ?? url.searchParams.get('sinceEventId'));
    const parsedLastEventId = lastEventValue ? Number(lastEventValue) : 0;
    const sinceEventId =
      Number.isSafeInteger(parsedLastEventId) && parsedLastEventId >= 0 ? parsedLastEventId : 0;
    const startFromLatest =
      url.searchParams.get('startFromLatest') === 'true' &&
      lastEventValue === null &&
      !url.searchParams.has('sinceEventId');
    const metadataOnly = url.searchParams.get('metadataOnly') === 'true';
    const hub = options.realtimeHub;
    if (!hub) {
      sendJson(response, config, 500, {
        error: 'realtime_unavailable',
        message: 'The local realtime transport is not available.',
      });
      return;
    }

    const releaseStream = identity.accountId
      ? requestLimiters.streams.tryAcquire(identity.accountId)
      : () => {};
    if (!releaseStream) {
      authJson(request, response, config, 429, {
        error: 'rate_limited',
        message: 'You have too many open chat connections. Close another Rewind tab and retry.',
      });
      return;
    }
    response.once('close', releaseStream);
    response.once('finish', releaseStream);

    response.writeHead(200, {
      ...(identity.accountId && (request.headers.authorization || request.headers.cookie)
        ? authCorsHeaders(request, config)
        : { 'Access-Control-Allow-Origin': config.allowOrigin }),
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range, Last-Event-ID',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    });
    response.write(': connected\n\n');

    const writeEvent = (event: Parameters<typeof encodeSseEvent>[0]) => {
      const viewer = identity.accountId;
      const visible = viewer ? visibleChatEvent(database, viewer, event) : event;
      if (!visible) return;
      if (!response.writableEnded && !response.destroyed) {
        response.write(encodeSseEvent(visible, { metadataOnly }));
      }
    };
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const cleanup = () => {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
    };
    response.once('close', cleanup);
    const streamIsAuthorised = () => {
      return chatIdentityIsCurrent(request, database, identity, now());
    };
    const endUnauthorisedStream = () => {
      if (streamIsAuthorised()) return false;
      unsubscribe();
      writeRealtimeAccessDenied(response);
      if (!response.writableEnded && !response.destroyed) response.end();
      return true;
    };
    const writeAuthorisedEvent = (event: Parameters<typeof encodeSseEvent>[0]) => {
      if (endUnauthorisedStream()) return;
      writeEvent(event);
    };
    if (startFromLatest) {
      // Buffer while taking the database watermark so a concurrent commit is
      // either included in that watermark or delivered once from the buffer.
      const pending: Parameters<typeof encodeSseEvent>[0][] = [];
      let priming = true;
      unsubscribe = hub.subscribe(groupId, (event) => {
        if (priming) pending.push(event);
        else writeAuthorisedEvent(event);
      });
      const checkpoint = latestChatEventId(database, groupId);
      if (response.destroyed || response.writableEnded) {
        unsubscribe();
        return;
      }
      if (!endUnauthorisedStream()) response.write(encodeSseCheckpoint(checkpoint));
      for (const event of pending.sort((left, right) => left.eventId - right.eventId)) {
        if (event.eventId > checkpoint) writeAuthorisedEvent(event);
      }
      priming = false;
    } else {
      // Buffer live events while draining the persisted log through a fixed
      // watermark. Events committed after that watermark are flushed once the
      // replay is complete; events at or below it are covered by replay.
      let priming = true;
      const pending: Parameters<typeof encodeSseEvent>[0][] = [];
      let lastDeliveredEventId = sinceEventId;
      const deliverOnce = (event: Parameters<typeof encodeSseEvent>[0]) => {
        if (event.eventId <= lastDeliveredEventId) return;
        writeAuthorisedEvent(event);
        lastDeliveredEventId = event.eventId;
      };
      unsubscribe = hub.subscribe(groupId, (event) => {
        if (priming) pending.push(event);
        else deliverOnce(event);
      });
      const watermark = latestChatEventId(database, groupId);
      while (lastDeliveredEventId < watermark) {
        if (response.destroyed || response.writableEnded) break;
        const page = metadataOnly
          ? listChatEventMetadata(database, groupId, lastDeliveredEventId, 100)
          : listChatEvents(database, groupId, lastDeliveredEventId, 100);
        let progressed = false;
        for (const event of page) {
          if (event.eventId > watermark) break;
          deliverOnce(event);
          progressed = true;
        }
        if (!progressed || lastDeliveredEventId >= watermark) break;
        // Let concurrent message requests publish while replay continues. Their
        // events remain buffered until the captured watermark has been drained.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      for (const event of pending.sort((left, right) => left.eventId - right.eventId)) {
        if (response.destroyed || response.writableEnded) break;
        if (event.eventId > watermark) deliverOnce(event);
      }
      priming = false;
    }
    if (response.destroyed || response.writableEnded) {
      cleanup();
      return;
    }
    heartbeat = setInterval(() => {
      if (response.writableEnded || response.destroyed || endUnauthorisedStream()) return;
      response.write(': keep-alive\n\n');
    }, options.realtimeHeartbeatIntervalMs ?? 15_000);
    heartbeat.unref();
    return;
  }

  const realtimeMessagesMatch = url.pathname.match(/^\/realtime\/groups\/([^/]+)\/messages$/);
  if (realtimeMessagesMatch && request.method === 'POST') {
    const groupId = decodePathSegment(realtimeMessagesMatch[1], response, config);
    if (groupId === null) return;
    const identity = requireAuthorisedChatGroup(
      request,
      database,
      url,
      response,
      config,
      now(),
      groupId,
    );
    if (!identity) return;
    if (
      identity.accountId &&
      !enforceRateLimit(
        requestLimiters.chat,
        identity.accountId,
        now(),
        request,
        response,
        config,
        'You are sending messages too quickly. Please wait before trying again.',
      )
    )
      return;
    const body = await requestBody(request, config);
    if (!chatIdentityIsCurrent(request, database, identity, now())) {
      sendDenied(response, config);
      return;
    }
    const result = createChatMessage(database, {
      groupId,
      memberId: identity.memberId,
      sessionId: identity.sessionId,
      body: typeof body?.body === 'string' ? body.body : '',
      messageId: typeof body?.messageId === 'string' ? body.messageId : undefined,
      replyToMessageId:
        typeof body?.replyToMessageId === 'string' ? body.replyToMessageId : undefined,
      now,
    });
    if (!result.ok) {
      if (result.reason === 'membership_denied') return sendDenied(response, config);
      sendJson(response, config, result.reason === 'duplicate_message' ? 409 : 400, {
        error: `message_${result.reason}`,
        message:
          result.reason === 'empty_body'
            ? 'Enter a message before sending.'
            : result.reason === 'body_too_long'
              ? 'Message text is too long.'
              : result.reason === 'invalid_timestamp'
                ? 'The message timestamp is invalid.'
                : result.reason === 'duplicate_message'
                  ? 'This message retry conflicts with an existing message.'
                  : result.reason === 'reply_not_found'
                    ? 'The message you are replying to is not available in this group.'
                    : 'Replies can only target an original message.',
      });
      return;
    }
    if (!result.deduplicated) options.realtimeHub?.publish(result.event);
    sendJson(response, config, result.deduplicated ? 200 : 201, {
      event: result.event,
      message: result.event.message,
      ...(result.deduplicated ? { deduplicated: true } : {}),
    });
    return;
  }

  const realtimeReactionMatch = url.pathname.match(
    /^\/realtime\/groups\/([^/]+)\/messages\/([^/]+)\/reactions(?:\/([^/]+))?$/,
  );
  if (
    realtimeReactionMatch &&
    (request.method === 'GET' || request.method === 'POST' || request.method === 'DELETE')
  ) {
    const groupId = decodePathSegment(realtimeReactionMatch[1], response, config);
    const messageId = decodePathSegment(realtimeReactionMatch[2], response, config);
    const pathEmoji = realtimeReactionMatch[3]
      ? decodePathSegment(realtimeReactionMatch[3], response, config)
      : undefined;
    if (groupId === null || messageId === null || pathEmoji === null) return;
    const identity = requireAuthorisedChatGroup(
      request,
      database,
      url,
      response,
      config,
      now(),
      groupId,
    );
    if (!identity) return;
    if (request.method === 'GET') {
      const message = getMessage(database, groupId, messageId);
      if (!message) return sendNotFound(response, config);
      sendJson(response, config, 200, { message });
      return;
    }
    const body = await requestBody(request, config);
    if (!chatIdentityIsCurrent(request, database, identity, now())) {
      sendDenied(response, config);
      return;
    }
    const emoji =
      pathEmoji ??
      (typeof body?.emoji === 'string' ? body.emoji : url.searchParams.get('emoji')) ??
      SUPPORTED_CHAT_REACTION;
    const active =
      request.method === 'DELETE'
        ? false
        : typeof body?.active === 'boolean'
          ? body.active
          : body?.action === 'remove'
            ? false
            : body?.action === 'add'
              ? true
              : undefined;
    const result = toggleChatReaction(database, {
      groupId,
      memberId: identity.memberId,
      sessionId: identity.sessionId,
      messageId,
      emoji,
      active,
      now,
    });
    if (!result.ok) {
      if (result.reason === 'membership_denied') return sendDenied(response, config);
      if (result.reason === 'message_not_found') return sendNotFound(response, config);
      sendJson(response, config, 400, {
        error: `reaction_${result.reason}`,
        message:
          result.reason === 'unsupported_reaction'
            ? 'That reaction is not supported.'
            : 'The reaction timestamp is invalid.',
      });
      return;
    }
    sendJson(response, config, 200, result);
    return;
  }

  if (url.pathname === '/groups' && request.method === 'POST') {
    const identity = requireSessionIdentity(database, url, response, config, now());
    if (!identity) return;
    const body = await requestBody(request, config);
    const result = createGroup(
      database,
      identity.memberId,
      {
        name: typeof body?.name === 'string' ? body.name : '',
        prompt: typeof body?.prompt === 'string' ? body.prompt : '',
        now: now(),
      },
      identity.sessionId,
    );
    if (!result.ok && result.field === 'session') {
      sendSessionRequired(response, config);
      return;
    }
    if (!result.ok) {
      sendJson(response, config, 400, {
        error: 'invalid_group',
        field: result.field,
        reason: result.reason,
        message:
          result.field === 'name'
            ? result.reason === 'too_long'
              ? 'Group name is too long.'
              : 'Enter a group name.'
            : result.field === 'prompt'
              ? result.reason === 'too_long'
                ? 'Prompt is too long.'
                : 'Choose a prompt or write a custom prompt.'
              : 'This Demo member cannot create a group.',
      });
      return;
    }
    sendJson(response, config, 201, {
      group: result.group,
      cycle: result.cycle,
      session: getDemoSession(database, identity.sessionId),
    });
    return;
  }

  if (url.pathname === '/invites' && request.method === 'POST') {
    const groupId = url.searchParams.get('groupId');
    const identity = requireAuthorisedOwner(database, url, response, config, now(), groupId);
    if (!identity) return;
    const body = await requestBody(request, config);
    const ttlSeconds =
      typeof body?.expiresInSeconds === 'number'
        ? body.expiresInSeconds
        : typeof body?.expiresInSeconds === 'string'
          ? Number(body.expiresInSeconds)
          : undefined;
    const result = createInvite(
      database,
      identity.memberId,
      identity.groupId,
      ttlSeconds,
      now(),
      identity.sessionId,
    );
    if (!result.ok) {
      if (result.reason === 'session_inactive') return sendSessionRequired(response, config);
      if (result.reason === 'forbidden') return sendDenied(response, config);
      sendJson(response, config, 400, {
        error: 'invalid_invite',
        message: 'Choose an expiry between five minutes and seven days.',
      });
      return;
    }
    sendJson(response, config, 201, { invite: result.invite });
    return;
  }

  if (url.pathname === '/invites/accept' && request.method === 'POST') {
    const identity = requireSessionIdentity(database, url, response, config, now());
    if (!identity) return;
    const body = await requestBody(request, config);
    const code = typeof body?.code === 'string' ? body.code : (url.searchParams.get('code') ?? '');
    const result = acceptInvite(
      database,
      identity.memberId,
      code,
      url.searchParams.get('groupId') ?? undefined,
      now(),
      identity.sessionId,
    );
    if (!result.ok) {
      if (result.reason === 'session_inactive') return sendSessionRequired(response, config);
      const messages = {
        malformed: 'Enter the eight-character invite code.',
        not_found: 'That invite code is not recognized.',
        expired: 'That invite code has expired. Ask the owner for a new code.',
        used: 'That invite code has already been used.',
        cross_group: 'That invite code belongs to a different group.',
        already_member: 'This Demo member is already in that group.',
      } as const;
      sendJson(response, config, 400, {
        error: `invite_${result.reason}`,
        message: messages[result.reason],
      });
      return;
    }
    sendJson(response, config, 200, {
      invite: result.invite,
      group: result.group,
      session: getDemoSession(database, identity.sessionId),
    });
    return;
  }

  if (url.pathname === '/contributions/upload/source' && request.method === 'POST') {
    const groupId = url.searchParams.get('groupId');
    const idempotencyKey = url.searchParams.get('idempotencyKey') ?? '';
    const identity = requireAuthorisedMediaGroup(
      request,
      database,
      url,
      response,
      config,
      now(),
      groupId,
      'contribution',
    );
    if (!identity) return;
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
      sendJson(response, config, 400, {
        error: 'upload_invalid_key',
        message: 'Provide a retryable upload key.',
      });
      return;
    }
    const contentType = String(request.headers['content-type'] ?? '')
      .split(';', 1)[0]
      .trim();
    const photoType = contentType === 'image/jpeg' || contentType === 'image/png';
    if (contentType !== 'video/mp4' && contentType !== 'application/octet-stream' && !photoType) {
      sendJson(response, config, 400, {
        error: 'upload_invalid_media',
        message: 'Upload a JPEG or PNG photo, or an MP4 clip.',
      });
      return;
    }
    const releaseIntakeCapacity = acquireRequestCapacity(
      requestLimiters.intake,
      request,
      response,
      config,
    );
    if (!releaseIntakeCapacity) return;
    const stagingDir = resolve(config.dataDir, 'media', 'staging');
    let releaseStagingLock: (() => void) | null = await acquireStagedSourceLock(stagingDir);
    let releaseActiveIntake: (() => void) | null = null;
    try {
      await maybeCleanupOrphanedStagedSources(database, stagingDir);
      const sourceId = stagedSourceId(idempotencyKey);
      const sourceUri = `staged://${sourceId}`;
      const existingBeforeClaim = findStagedSource(database, sourceUri);
      const nextGeneration = existingBeforeClaim
        ? Math.max(1, existingBeforeClaim.claimGeneration)
        : 1;
      const sourcePath = stagedSourcePath(sourceUri, stagingDir, nextGeneration);
      if (!sourcePath) return sendNotFound(response, config);
      const claim = claimStagedSource(
        database,
        identity.groupId,
        identity.memberId,
        idempotencyKey,
        now(),
        sourcePath,
      );
      if (!claim.ok) {
        sendJson(response, config, 409, {
          error: 'upload_source_conflict',
          message: 'That upload key is already owned by another capture.',
        });
        return;
      }
      // The intake route always writes to the deterministic server-owned path;
      // never trust a path carried by a legacy/database row as a write target.
      let claimedSourcePath = claim.source.sourcePath ?? sourcePath;
      let claimGeneration = claim.source.claimGeneration;
      let canStage = !claim.existing;
      if (
        claim.existing &&
        (claim.source.status === 'staged' || claim.source.status === 'pending')
      ) {
        const existingMetadata = findStagedSource(database, sourceUri);
        if (
          existingMetadata?.status === 'staged' &&
          existingMetadata.byteLength &&
          existsSync(claimedSourcePath)
        ) {
          sendJson(response, config, 200, {
            source: { id: sourceId, uri: sourceUri, byteLength: existingMetadata.byteLength },
          });
          return;
        }
        if (
          existingMetadata?.status === 'pending' &&
          (!existingMetadata.claimExpiresAt ||
            Date.parse(existingMetadata.claimExpiresAt) > now().getTime())
        ) {
          sendJson(response, config, 409, {
            error: 'upload_source_conflict',
            message: 'That upload is already being staged. Retry after it completes.',
          });
          return;
        }
        // A successful claim without a file is recoverable after interruption.
        // Reclaiming increments the generation and assigns a new physical path,
        // fencing any stale body/probe callback from the old request.
        const reclaimed = reclaimStagedSource(
          database,
          identity.groupId,
          identity.memberId,
          idempotencyKey,
          stagedSourcePath(sourceUri, stagingDir, claimGeneration + 1) ?? sourcePath,
          now(),
        );
        if (!reclaimed.ok || !reclaimed.source.sourcePath) {
          sendJson(response, config, 409, {
            error: 'upload_source_conflict',
            message: 'That upload source changed while it was being recovered.',
          });
          return;
        }
        claimedSourcePath = reclaimed.source.sourcePath;
        claimGeneration = reclaimed.source.claimGeneration;
        canStage = true;
      }
      // A pending claim with a source path belongs to an intake request that is
      // already consuming its body. Reject the duplicate before it can write a
      // distinct payload over the same deterministic destination.
      if (!canStage && claim.existing && claim.source.status === 'pending') {
        sendJson(response, config, 409, {
          error: 'upload_source_conflict',
          message: 'That upload is already being staged. Retry after it completes.',
        });
        return;
      }
      // Let another same-key request observe the committed pending claim and
      // return a conflict, while reset waits on this body/probe operation.
      releaseActiveIntake = registerStagedIntake();
      releaseStagingLock();
      releaseStagingLock = null;
      try {
        await stageSourceBody(
          request,
          stagingDir,
          claimedSourcePath,
          config,
          photoType ? 10 * 1024 * 1024 : MAX_STAGED_SOURCE_BYTES,
        );
        const probed = photoType
          ? await probePhotoWithFfmpeg(config.ffmpegBin, claimedSourcePath, stagingDir)
          : await probeClipWithFfmpeg(config.ffmpegBin, claimedSourcePath, stagingDir);
        if (photoType && probed.mimeType !== contentType) {
          throw new Error('photo type does not match its verified bytes');
        }
        database.exec('BEGIN');
        try {
          if (!mediaIdentityIsCurrent(request, database, identity, now())) {
            database.exec('ROLLBACK');
            cleanupFailedStagedClaim(
              database,
              sourceUri,
              claimedSourcePath,
              claimGeneration,
              stagingDir,
            );
            return sendSessionRequired(response, config);
          }
          recordClipMediaMetadata(database, {
            sourceUri,
            mediaType: photoType ? 'photo' : 'video',
            ...probed,
            // FFprobe's stat is authoritative; the stream byte count is only a
            // transport guard and is never persisted as media truth.
            byteLength: probed.byteLength,
            verifiedAt: now().toISOString(),
          });
          if (
            !markStagedSourceReady(
              database,
              sourceUri,
              probed.byteLength,
              claimedSourcePath,
              claimGeneration,
            )
          ) {
            throw new Error('staged source claim was superseded');
          }
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        sendJson(response, config, 201, {
          source: { id: sourceId, uri: sourceUri, byteLength: probed.byteLength },
        });
      } catch (error) {
        cleanupFailedStagedClaim(
          database,
          sourceUri,
          claimedSourcePath,
          claimGeneration,
          stagingDir,
        );
        if (error instanceof RequestPolicyError) throw error;
        sendJson(response, config, 400, {
          error: 'upload_staging_failed',
          message: 'The clip source could not be staged. Try again.',
        });
      }
    } finally {
      releaseIntakeCapacity();
      releaseActiveIntake?.();
      releaseActiveIntake = null;
      releaseStagingLock?.();
      releaseStagingLock = null;
    }
    return;
  }

  if (url.pathname === '/demo/synthetic-clip' && request.method === 'POST') {
    const groupId = url.searchParams.get('groupId');
    const identity = requireAuthorisedGroup(
      database,
      url,
      response,
      config,
      now(),
      groupId,
      'contribution',
    );
    if (!identity) return;
    const releaseIntakeCapacity = acquireRequestCapacity(
      requestLimiters.intake,
      request,
      response,
      config,
    );
    if (!releaseIntakeCapacity) return;
    const stagingDir = resolve(config.dataDir, 'media', 'staging');
    const releaseLock = await acquireStagedSourceLock(stagingDir);
    try {
      const idempotencyKey = `synthetic-${randomUUID()}`;
      const sourceUri = `staged://${stagedSourceId(idempotencyKey)}`;
      const sourcePath = stagedSourcePath(sourceUri, stagingDir, 1);
      if (!sourcePath) return sendNotFound(response, config);
      const claim = claimStagedSource(
        database,
        identity.groupId,
        identity.memberId,
        idempotencyKey,
        now(),
        sourcePath,
      );
      if (!claim.ok || !claim.source.sourcePath) return sendDenied(response, config);
      const releaseIntake = registerStagedIntake();
      try {
        await mkdir(dirname(claim.source.sourcePath), { recursive: true });
        const metadata = await generateSyntheticDemoClip(config.ffmpegBin, claim.source.sourcePath);
        database.exec('BEGIN');
        try {
          recordClipMediaMetadata(database, {
            sourceUri,
            ...metadata,
            verifiedAt: now().toISOString(),
          });
          if (
            !markStagedSourceReady(
              database,
              sourceUri,
              metadata.byteLength,
              claim.source.sourcePath,
              claim.source.claimGeneration,
            )
          ) {
            throw new Error('synthetic source claim was superseded');
          }
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        const upload = createClipUpload(
          database,
          identity.groupId,
          identity.memberId,
          {
            idempotencyKey,
            sourceUri,
            ...metadata,
            mode: 'soft-focus',
            trimStartSeconds: 0,
            trimEndSeconds: metadata.durationSeconds,
          },
          now(),
          { stagingDir, requireVerifiedMetadata: true, sessionId: identity.sessionId },
        );
        if (!upload.ok) {
          cleanupFailedStagedClaim(
            database,
            sourceUri,
            claim.source.sourcePath,
            claim.source.claimGeneration,
            stagingDir,
          );
          if (upload.reason === 'quota_exceeded') {
            sendJson(response, config, 409, {
              error: 'contribution_quota_exceeded',
              message: 'This member has reached the current cycle contribution limit.',
            });
            return;
          }
          if (upload.reason === 'session_inactive') return sendSessionRequired(response, config);
          if (upload.reason === 'not_found') {
            sendJson(response, config, 409, {
              error: 'contribution_window_closed',
              message: 'The current cycle is not accepting contributions.',
            });
            return;
          }
          sendJson(response, config, 503, {
            error: 'synthetic_clip_failed',
            message: 'The synthetic Demo clip could not be prepared. Try again.',
          });
          return;
        }
        sendJson(response, config, 201, { upload: upload.upload, synthetic: true });
      } catch {
        cleanupFailedStagedClaim(
          database,
          sourceUri,
          claim.source.sourcePath,
          claim.source.claimGeneration,
          stagingDir,
        );
        sendJson(response, config, 503, {
          error: 'synthetic_clip_failed',
          message: 'The synthetic Demo clip could not be prepared. Try again.',
        });
      } finally {
        releaseIntake();
      }
    } finally {
      releaseIntakeCapacity();
      releaseLock();
    }
    return;
  }

  if (url.pathname === '/contributions/upload' && request.method === 'POST') {
    const groupId = url.searchParams.get('groupId');
    const identity = requireAuthorisedMediaGroup(
      request,
      database,
      url,
      response,
      config,
      now(),
      groupId,
      'contribution',
    );
    if (!identity) return;
    const body = await requestBody(request, config);
    if (identity.accountId && !mediaIdentityIsCurrent(request, database, identity, now())) {
      return sendSessionRequired(response, config);
    }
    if (
      body?.replacesContributionId !== undefined &&
      body.replacesContributionId !== null &&
      typeof body.replacesContributionId !== 'string'
    ) {
      sendJson(response, config, 400, {
        error: 'upload_invalid_replacement_target',
        message: 'Choose a contribution that can be replaced.',
      });
      return;
    }
    const input: ClipUploadInput = {
      mediaType: body?.mediaType === 'photo' ? 'photo' : 'video',
      idempotencyKey: typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : '',
      sourceUri: typeof body?.sourceUri === 'string' ? body.sourceUri : '',
      mimeType: typeof body?.mimeType === 'string' ? body.mimeType : '',
      byteLength: typeof body?.byteLength === 'number' ? body.byteLength : Number.NaN,
      durationSeconds:
        typeof body?.durationSeconds === 'number' ? body.durationSeconds : Number.NaN,
      width: typeof body?.width === 'number' ? body.width : Number.NaN,
      height: typeof body?.height === 'number' ? body.height : Number.NaN,
      hasAudio: body?.hasAudio === true,
      ...(typeof body?.mode === 'string' ? { mode: body.mode as ClipUploadInput['mode'] } : {}),
      ...(body?.clientProcessed !== undefined
        ? { clientProcessed: body.clientProcessed as boolean }
        : {}),
      ...(typeof body?.trimStartSeconds === 'number'
        ? { trimStartSeconds: body.trimStartSeconds }
        : typeof body?.startSeconds === 'number'
          ? { startSeconds: body.startSeconds }
          : {}),
      ...(typeof body?.trimEndSeconds === 'number'
        ? { trimEndSeconds: body.trimEndSeconds }
        : typeof body?.endSeconds === 'number'
          ? { endSeconds: body.endSeconds }
          : {}),
      ...(typeof body?.sourceDurationSeconds === 'number'
        ? { sourceDurationSeconds: body.sourceDurationSeconds }
        : {}),
      ...(typeof body?.replacesContributionId === 'string'
        ? { replacesContributionId: body.replacesContributionId }
        : {}),
    };
    const result = createClipUpload(database, identity.groupId, identity.memberId, input, now(), {
      stagingDir: resolve(config.dataDir, 'media', 'staging'),
      requireVerifiedMetadata: true,
      sessionId: identity.sessionId,
    });
    if (!result.ok) {
      if (result.reason === 'not_found') return sendNotFound(response, config);
      // Key validation happens before capability ownership is established. Do
      // not let an invalid-key request delete a URI supplied by another
      // capture (or an arbitrary caller-controlled URI).
      if (result.reason !== 'invalid_key') {
        cleanupStagedSource(database, input.sourceUri, resolve(config.dataDir, 'media', 'staging'));
      }
      if (result.reason === 'session_inactive') return sendSessionRequired(response, config);
      const conflict =
        result.reason === 'quota_exceeded' || result.reason === 'replacement_conflict';
      sendJson(response, config, conflict ? 409 : 400, {
        error: `upload_${result.reason}`,
        message:
          result.reason === 'quota_exceeded'
            ? 'This cycle has no remaining contribution allowance.'
            : result.reason === 'replacement_conflict'
              ? 'That contribution can no longer be replaced.'
              : result.reason === 'invalid_replacement_target'
                ? 'Choose a contribution that can be replaced.'
                : result.reason === 'invalid_key'
                  ? 'Provide a retryable upload key.'
                  : result.reason === 'invalid_mode'
                    ? 'Choose a supported original capture mode.'
                    : 'The clip must be an MP4 video with audio, within 15 seconds and 50 MB.',
      });
      return;
    }
    sendJson(response, config, result.upload.existing ? 200 : 201, {
      upload: result.upload,
    });
    return;
  }

  const uploadCancelMatch = url.pathname.match(/^\/contributions\/upload\/([^/]+)$/);
  if (uploadCancelMatch && request.method === 'DELETE') {
    const jobId = decodePathSegment(uploadCancelMatch[1], response, config);
    if (jobId === null) return;
    const groupId = url.searchParams.get('groupId');
    const identity = requireAuthorisedMediaGroup(
      request,
      database,
      url,
      response,
      config,
      now(),
      groupId,
      'contribution',
    );
    if (!identity) return;
    const stagingDir = resolve(config.dataDir, 'media', 'staging');
    const result = cancelClipUpload(database, identity.groupId, identity.memberId, jobId, {
      stagingDir,
    });
    if (!result.ok) return sendNotFound(response, config);
    sendJson(response, config, 200, { cancelled: true, ...result });
    return;
  }

  const processJobMatch = url.pathname.match(/^\/contributions\/jobs\/([^/]+)\/process$/);
  if (processJobMatch && request.method === 'POST') {
    const jobId = decodePathSegment(processJobMatch[1], response, config);
    if (jobId === null) return;
    const groupId = url.searchParams.get('groupId');
    const identity = requireAuthorisedMediaGroup(
      request,
      database,
      url,
      response,
      config,
      now(),
      groupId,
      'contribution',
    );
    if (!identity) return;
    const releaseProcessingCapacity = acquireRequestCapacity(
      requestLimiters.processing,
      request,
      response,
      config,
    );
    if (!releaseProcessingCapacity) return;
    let result: Awaited<ReturnType<typeof processClipJob>>;
    try {
      result = await processClipJob(database, {
        mediaStore: options.mediaStore,
        mediaEnvironment: options.mediaEnvironment,
        jobId,
        groupId: identity.groupId,
        ffmpegBin: config.ffmpegBin,
        stagingDir: resolve(config.dataDir, 'media', 'staging'),
        outputDir: resolve(config.dataDir, 'media', 'processed'),
        actorMemberId: identity.memberId,
      });
    } finally {
      releaseProcessingCapacity();
    }
    if (!result.ok && result.reason === 'not_found') return sendNotFound(response, config);
    if (!result.ok && result.reason === 'already_processing') {
      sendJson(response, config, 409, {
        error: 'media_processing',
        message: result.message,
      });
      return;
    }
    if (!result.ok) {
      sendJson(response, config, 503, {
        error: 'media_processing_failed',
        message: result.message,
      });
      return;
    }
    sendJson(response, config, 200, { job: { id: result.jobId, status: result.status } });
    return;
  }

  if (url.pathname === '/profiles') {
    sendJson(response, config, 200, { profiles: listProfiles(database) });
    return;
  }

  const clipStatusMatch = url.pathname.match(/^\/clips\/([^/]+)$/);
  if (clipStatusMatch && request.method === 'GET') {
    const jobId = decodePathSegment(clipStatusMatch[1], response, config);
    if (jobId === null) return;
    const identity = requireAuthorisedMediaGroup(
      request,
      database,
      url,
      response,
      config,
      now(),
      url.searchParams.get('groupId'),
      'contribution',
    );
    if (!identity) return;
    const job = database
      .prepare(
        `SELECT j.id, j.status FROM media_jobs j
         JOIN contributions c ON c.id = j.contribution_id
         WHERE j.id = ? AND j.group_id = ? AND c.member_id = ? AND j.kind = 'clip'`,
      )
      .get(jobId, identity.groupId, identity.memberId) as
      { id: string; status: string } | undefined;
    if (!job) return sendNotFound(response, config);
    sendJson(response, config, 200, {
      clip: {
        id: job.id,
        status:
          job.status === 'processing' ||
          job.status === 'ready' ||
          job.status === 'failed' ||
          job.status === 'cancelled'
            ? job.status
            : 'pending',
      },
    });
    return;
  }

  if (url.pathname === '/contributions' && request.method === 'GET') {
    const requestNow = now();
    const identity = requireAuthorisedMediaGroup(
      request,
      database,
      url,
      response,
      config,
      requestNow,
      url.searchParams.get('groupId'),
      'contribution',
    );
    if (!identity) return;
    try {
      sendJson(
        response,
        config,
        200,
        listContributionLedger(database, {
          groupId: identity.groupId,
          memberId: identity.memberId,
          state: parseLedgerState(url.searchParams.get('state')),
          limit: parseLedgerLimit(url.searchParams.get('limit')),
          cursor: url.searchParams.get('cursor'),
          now: requestNow,
        }),
      );
    } catch (error) {
      if (!(error instanceof ContributionLedgerQueryError)) throw error;
      sendJson(response, config, 400, {
        error: 'invalid_ledger_request',
        message: error.message,
      });
    }
    return;
  }

  if (url.pathname === '/jobs' && request.method === 'GET') {
    const groupId = url.searchParams.get('groupId');
    const identity = requireAuthorisedGroup(database, url, response, config, now(), groupId, 'job');
    if (!identity) return;
    try {
      const jobs = listQueueJobs(database, {
        groupId: identity.groupId,
        kind: parseQueueKind(url.searchParams.get('kind')),
        status: parseQueueStatus(url.searchParams.get('status')),
        limit: parseQueueLimit(url.searchParams.get('limit')),
        cursor: url.searchParams.get('cursor'),
      });
      sendJson(response, config, 200, jobs);
    } catch (error) {
      if (!(error instanceof QueueQueryError)) throw error;
      sendJson(response, config, 400, {
        error: 'invalid_jobs_request',
        message: error.message,
      });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/demo/reveal') {
    const groupId = url.searchParams.get('groupId');
    const identity = requireAuthorisedOwner(database, url, response, config, now(), groupId);
    if (!identity) return;

    // Demo controls follow the older release independently of the current capture cycle.
    const pendingRelease = database
      .prepare(
        `SELECT id FROM cycles WHERE group_id = ? AND status = 'revealing'
       ORDER BY ends_at ASC, id ASC LIMIT 1`,
      )
      .get(identity.groupId) as { id: string } | undefined;
    const lifecycle = advanceCycleLifecycle(database, {
      groupId: identity.groupId,
      ...(pendingRelease ? { cycleId: pendingRelease.id } : {}),
      clock: now,
    });
    if (!lifecycle.ok) return sendNotFound(response, config);
    if (lifecycle.action === 'waiting_for_boundary') {
      sendJson(response, config, 200, {
        reveal: { state: 'collecting', cycleId: lifecycle.cycle.id },
      });
      return;
    }
    if (lifecycle.action === 'revealing') {
      const job = cycleCompilationJob(database, identity.groupId, lifecycle.cycle.id);
      if (!job) return sendNotFound(response, config);
      sendJson(response, config, 200, {
        reveal: { state: 'compiling', cycleId: lifecycle.cycle.id, jobId: job.id },
      });
      return;
    }
    if (
      lifecycle.action === 'premiere' ||
      lifecycle.action === 'archived' ||
      lifecycle.action === 'already_archived'
    ) {
      sendJson(response, config, 200, {
        reveal: { state: 'released', cycleId: lifecycle.cycle.id },
      });
      return;
    }

    const job = cycleCompilationJob(database, identity.groupId, lifecycle.cycle.id);
    if (!job) return sendNotFound(response, config);
    if (job.status === 'processing') {
      sendJson(response, config, 200, {
        reveal: { state: 'compiling', cycleId: lifecycle.cycle.id, jobId: job.id },
      });
      return;
    }
    const releaseProcessingCapacity = acquireRequestCapacity(
      requestLimiters.processing,
      request,
      response,
      config,
    );
    if (!releaseProcessingCapacity) return;
    let compiled: Awaited<ReturnType<typeof processCompilationJob>>;
    try {
      compiled = await processCompilationJob(database, {
        mediaStore: options.mediaStore,
        mediaEnvironment: options.mediaEnvironment,
        jobId: job.id,
        groupId: identity.groupId,
        ffmpegBin: config.ffmpegBin,
        outputDir: resolve(config.dataDir, 'media', 'processed'),
        actorMemberId: identity.memberId,
      });
    } finally {
      releaseProcessingCapacity();
    }
    if (!compiled.ok) {
      sendJson(response, config, 200, {
        reveal: { state: 'delayed', cycleId: lifecycle.cycle.id, jobId: job.id },
      });
      return;
    }
    const published = publishCycleRelease(database, {
      groupId: identity.groupId,
      cycleId: lifecycle.cycle.id,
      clock: now,
    });
    if (!published.ok) {
      sendJson(response, config, 200, {
        reveal: { state: 'delayed', cycleId: lifecycle.cycle.id, jobId: job.id },
      });
      return;
    }
    const archived = advanceCycleLifecycle(database, {
      groupId: identity.groupId,
      cycleId: lifecycle.cycle.id,
      clock: now,
    });
    if (!archived.ok) return sendNotFound(response, config);
    sendJson(response, config, 200, {
      reveal: { state: 'released', cycleId: lifecycle.cycle.id },
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/cycles/demo/advance') {
    const groupId = url.searchParams.get('groupId');
    const identity = requireAuthorisedOwner(database, url, response, config, now(), groupId);
    if (!identity) return;
    const advanceSecondsValue = url.searchParams.get('advanceSeconds');
    const advanceSeconds = advanceSecondsValue ? Number(advanceSecondsValue) : Number.NaN;
    const result = advanceDemoCycle(database, {
      groupId: identity.groupId,
      actingMemberId: identity.memberId,
      advanceSeconds,
    });
    if ('allowed' in result) {
      sendDenied(response, config);
      return;
    }
    if (!result.ok) {
      if (result.reason === 'not_found') return sendNotFound(response, config);
      sendBadRequest(response, config);
      return;
    }
    sendJson(response, config, 200, {
      cycle: result.cycle,
      advanceSeconds: result.advanceSeconds,
      eventId: result.eventId,
    });
    return;
  }

  if (url.pathname === '/groups/current') {
    const identity = requireSessionIdentity(database, url, response, config, now());
    if (!identity) return;
    if (!authorizeSessionMember(database, identity.groupId, identity, 'group').allowed) {
      sendDenied(response, config);
      return;
    }
    const group = getGroup(database, identity.groupId, identity.memberId);
    if (!group) return sendDenied(response, config);
    sendJson(response, config, 200, {
      group,
    });
    return;
  }

  const groupMatch = url.pathname.match(/^\/groups\/([^/]+)$/);
  if (groupMatch) {
    const groupId = decodePathSegment(groupMatch[1], response, config);
    if (groupId === null) return;
    const identity = requireAuthorisedGroup(
      database,
      url,
      response,
      config,
      now(),
      groupId,
      'group',
    );
    if (!identity) return;
    const group = getGroup(database, groupId, identity.memberId);
    if (!group) return sendNotFound(response, config);
    sendJson(response, config, 200, { group });
    return;
  }

  if (url.pathname === '/cycles/current') {
    const groupId = url.searchParams.get('groupId');
    const identity = requireAuthorisedGroup(
      database,
      url,
      response,
      config,
      now(),
      groupId,
      'group',
    );
    if (!identity) return;
    const cycle = getCurrentCycle(database, identity.groupId, identity.memberId, now());
    if (!cycle) return sendNotFound(response, config);
    sendJson(response, config, 200, { cycle });
    return;
  }

  if (url.pathname === '/cycles/history' && request.method === 'GET') {
    const groupId = url.searchParams.get('groupId');
    const identity = requireAuthorisedGroup(
      database,
      url,
      response,
      config,
      now(),
      groupId,
      'group',
    );
    if (!identity) return;
    const parsedLimit = Number(url.searchParams.get('limit'));
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 50) : 50;
    const rawCursor = url.searchParams.get('cursor');
    const cursor = decodePageCursor(rawCursor, 2);
    if (rawCursor !== null && !cursor) {
      sendJson(response, config, 400, {
        error: 'invalid_page_cursor',
        message: 'The cycle history cursor is invalid.',
      });
      return;
    }
    const rows = database
      .prepare(
        `SELECT id, prompt, starts_at AS startsAt, ends_at AS endsAt, status,
                release_status AS releaseStatus
         FROM cycles WHERE group_id = ?
           AND (? IS NULL OR starts_at < ? OR (starts_at = ? AND id < ?))
         ORDER BY starts_at DESC, id DESC LIMIT ?`,
      )
      .all(
        identity.groupId,
        cursor ? 0 : null,
        cursor?.[0] ?? '',
        cursor?.[0] ?? '',
        cursor?.[1] ?? '',
        limit + 1,
      ) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    sendJson(response, config, 200, {
      cycles: page.map((cycle) => ({
        id: String(cycle.id),
        prompt: String(cycle.prompt),
        startsAt: String(cycle.startsAt),
        endsAt: String(cycle.endsAt),
        status: String(cycle.status),
        releaseStatus: String(cycle.releaseStatus),
      })),
      hasMore,
      nextCursor:
        hasMore && last ? encodePageCursor([String(last.startsAt), String(last.id)]) : null,
    });
    return;
  }

  const messageMatch = url.pathname.match(/^\/messages\/([^/]+)$/);
  if (messageMatch) {
    const messageId = decodePathSegment(messageMatch[1], response, config);
    if (messageId === null) return;
    const groupId = url.searchParams.get('groupId');
    const identity = requireAuthorisedGroup(
      database,
      url,
      response,
      config,
      now(),
      groupId,
      'message',
    );
    if (!identity) return;
    const message = getMessage(database, identity.groupId, messageId);
    if (!message) return sendNotFound(response, config);
    sendJson(response, config, 200, { message });
    return;
  }

  const contributionMatch = url.pathname.match(/^\/contributions\/([^/]+)$/);
  if (contributionMatch) {
    const contributionId = decodePathSegment(contributionMatch[1], response, config);
    if (contributionId === null) return;
    const groupId = url.searchParams.get('groupId');
    const identity = requireAuthorisedMediaGroup(
      request,
      database,
      url,
      response,
      config,
      now(),
      groupId,
      'contribution',
    );
    if (!identity) return;
    if (request.method === 'DELETE') {
      const result = deleteContribution(
        database,
        identity.groupId,
        identity.memberId,
        contributionId,
        now(),
        {
          stagingDir: resolve(config.dataDir, 'media', 'staging'),
          outputDir: resolve(config.dataDir, 'media', 'processed'),
        },
      );
      if (!result.ok) {
        const status =
          result.reason === 'not_found' || result.reason === 'already_deleted' ? 404 : 409;
        const messages = {
          already_deleted: 'That contribution has already been deleted.',
          deletion_used: 'The weekly delete-and-replace allowance has already been used.',
          not_eligible: 'This contribution can no longer be deleted before reveal.',
          not_found: 'The contribution was not found.',
          processing: 'Wait for processing to finish before deleting this contribution.',
        } as const;
        sendJson(response, config, status, {
          error: `contribution_${result.reason}`,
          message: messages[result.reason],
        });
        return;
      }
      sendJson(response, config, 200, { deleted: true, ...result });
      return;
    }
    const contribution = getContribution(database, identity.groupId, contributionId);
    if (!contribution) return sendNotFound(response, config);
    sendJson(response, config, 200, { contribution });
    return;
  }

  const premiereMatch = url.pathname.match(/^\/cycles\/([^/]+)\/premiere$/);
  if (premiereMatch && request.method === 'GET') {
    const cycleId = decodePathSegment(premiereMatch[1], response, config);
    if (cycleId === null) return;
    const groupId = url.searchParams.get('groupId');
    const identity = requireAuthorisedMediaGroup(
      request,
      database,
      url,
      response,
      config,
      now(),
      groupId,
      'film',
    );
    if (!identity) return;
    const film = getPremiereFilm(database, identity.groupId, cycleId);
    if (!film) return sendNotFound(response, config);
    let state = premiereState(film);
    // A published film whose bytes no longer match its finalized digest must
    // not be advertised as playable. It is reported as delayed and audited,
    // the same safe state used for an exhausted compile.
    if (state === 'ready' && film.filmId && film.outputPath) {
      const served = await verifiedServingPath(
        database,
        film.filmId,
        'film',
        film.outputPath,
        config.dataDir,
        identity.memberId,
        now(),
        options,
      );
      if (!served) state = 'delayed';
    }
    if (!mediaIdentityIsCurrent(request, database, identity, now()))
      return sendDenied(response, config);
    const currentFilm = getPremiereFilm(database, identity.groupId, cycleId);
    if (
      state === 'ready' &&
      (currentFilm?.filmId !== film.filmId ||
        currentFilm.outputPath !== film.outputPath ||
        premiereState(currentFilm) !== 'ready')
    )
      state = 'delayed';
    sendJson(response, config, 200, {
      premiere:
        state === 'ready'
          ? {
              state,
              cycleId,
              filmId: film.filmId,
              segments: filmSegments(database, film.filmId!, identity.memberId),
              playbackPath: protectedAssetPath(
                database,
                request,
                identity,
                film.filmId!,
                'film',
                'play',
                options,
                now(),
              ),
            }
          : { state, cycleId },
    });
    return;
  }

  const playbackMatch = url.pathname.match(/^\/films\/([^/]+)\/play$/);
  if (playbackMatch && (request.method === 'GET' || request.method === 'HEAD')) {
    const filmId = decodePathSegment(playbackMatch[1], response, config);
    if (filmId === null) return;
    const groupId = url.searchParams.get('groupId');
    const identity = requireAuthorisedMediaGroup(
      request,
      database,
      url,
      response,
      config,
      now(),
      groupId,
      'film',
    );
    if (!identity) return;
    const film = database
      .prepare(
        `SELECT cycle_id AS cycleId FROM media_jobs
         WHERE id = ? AND group_id = ? AND kind = 'film'`,
      )
      .get(filmId, identity.groupId) as { cycleId?: string } | undefined;
    if (!film?.cycleId) return sendNotFound(response, config);
    const premiere = getPremiereFilm(database, identity.groupId, film.cycleId);
    if (
      !premiere ||
      premiere.filmId !== filmId ||
      premiereState(premiere) !== 'ready' ||
      !premiere.outputPath
    ) {
      return sendNotFound(response, config);
    }
    const served = await openVerifiedServingFile(
      database,
      filmId,
      'film',
      premiere.outputPath,
      config.dataDir,
      identity.memberId,
      now(),
      options,
    );
    if (!served) return sendNotFound(response, config);
    if ('capacityExceeded' in served) {
      sendJson(
        response,
        config,
        served.reason === 'size_policy' ? 413 : 429,
        served.reason === 'size_policy'
          ? {
              error: 'media_snapshot_size_limit',
              message: 'This media file exceeds the local temporary storage serving limit.',
            }
          : {
              error: 'media_serving_capacity',
              message: 'Media delivery is at capacity. Try again shortly.',
            },
      );
      return;
    }
    const currentPremiere = getPremiereFilm(database, identity.groupId, film.cycleId);
    if (
      !mediaIdentityIsCurrent(request, database, identity, now()) ||
      currentPremiere?.filmId !== filmId ||
      currentPremiere.outputPath !== premiere.outputPath ||
      premiereState(currentPremiere) !== 'ready'
    ) {
      await served.handle.close();
      served.releaseBudget();
      return sendNotFound(response, config);
    }
    streamMp4(
      request,
      response,
      config,
      served.handle,
      served.size,
      undefined,
      served.releaseBudget,
    );
    return;
  }

  if (url.pathname === '/archive' && request.method === 'GET') {
    const groupId = url.searchParams.get('groupId');
    const identity = requireAuthorisedMediaGroup(
      request,
      database,
      url,
      response,
      config,
      now(),
      groupId,
      'download',
    );
    if (!identity) return;
    const releaseArchiveCapacity = acquireRequestCapacity(
      requestLimiters.archive,
      request,
      response,
      config,
    );
    if (!releaseArchiveCapacity) return;
    try {
      const parsedLimit = Number(url.searchParams.get('limit'));
      const limit =
        Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 50) : 50;
      const rawFilmCursor = url.searchParams.get('filmCursor');
      const rawClipCursor = url.searchParams.get('clipCursor');
      const filmCursor = decodePageCursor(rawFilmCursor, 3);
      const clipCursor = decodePageCursor(rawClipCursor, 2);
      if ((rawFilmCursor !== null && !filmCursor) || (rawClipCursor !== null && !clipCursor)) {
        sendJson(response, config, 400, {
          error: 'invalid_page_cursor',
          message: 'The archive cursor is invalid.',
        });
        return;
      }
      const archive = listReleasedArchive(database, identity.groupId, identity.memberId, {
        limit,
        includeFilms: url.searchParams.get('includeFilms') !== 'false',
        includeClips: url.searchParams.get('includeClips') !== 'false',
        filmCursor: filmCursor as [string, string, string] | null,
        clipCursor: clipCursor as [string, string] | null,
      });
      // Advertise only entries whose retained bytes still match the digest
      // recorded at finalization. A tampered or truncated output disappears
      // from the archive and is audited instead of being offered for playback.
      const films = await filterServableArchive(
        database,
        'film',
        archive.films,
        config.dataDir,
        identity.memberId,
        now(),
        options,
      );
      const clips = await filterServableArchive(
        database,
        'clip',
        archive.clips,
        config.dataDir,
        identity.memberId,
        now(),
        options,
      );
      if (!mediaIdentityIsCurrent(request, database, identity, now()))
        return sendDenied(response, config);
      sendJson(response, config, 200, {
        archive: {
          films: films.map((film) => ({
            ...film,
            segments: filmSegments(database, film.id, identity.memberId),
            downloadPath: protectedAssetPath(
              database,
              request,
              identity,
              film.id,
              'film',
              'download',
              options,
              now(),
            ),
            playbackPath: protectedAssetPath(
              database,
              request,
              identity,
              film.id,
              'film',
              'play',
              options,
              now(),
            ),
          })),
          clips: clips.map((clip) => ({
            ...clip,
            downloadPath: protectedAssetPath(
              database,
              request,
              identity,
              clip.id,
              'clip',
              'download',
              options,
              now(),
            ),
          })),
        },
        pagination: {
          filmCursor: archive.nextFilmCursor ? encodePageCursor(archive.nextFilmCursor) : null,
          clipCursor: archive.nextClipCursor ? encodePageCursor(archive.nextClipCursor) : null,
          hasMoreFilms: archive.hasMoreFilms,
          hasMoreClips: archive.hasMoreClips,
        },
      });
    } finally {
      releaseArchiveCapacity();
    }
    return;
  }

  const filmDownloadMatch = url.pathname.match(/^\/films\/([^/]+)\/download$/);
  const clipDownloadMatch = url.pathname.match(/^\/clips\/([^/]+)\/download$/);
  if (
    (filmDownloadMatch || clipDownloadMatch) &&
    (request.method === 'GET' || request.method === 'HEAD')
  ) {
    const resourceId = decodePathSegment(
      (filmDownloadMatch ?? clipDownloadMatch)![1],
      response,
      config,
    );
    if (resourceId === null) return;
    const groupId = url.searchParams.get('groupId');
    const identity = requireAuthorisedMediaGroup(
      request,
      database,
      url,
      response,
      config,
      now(),
      groupId,
      'download',
    );
    if (!identity) return;
    const media = filmDownloadMatch
      ? getReleasedFilmDownload(database, identity.groupId, resourceId)
      : getReleasedOwnClipDownload(database, identity.groupId, identity.memberId, resourceId);
    if (!media) return sendNotFound(response, config);
    const served = await openVerifiedServingFile(
      database,
      resourceId,
      filmDownloadMatch ? 'film' : 'clip',
      media.outputPath,
      config.dataDir,
      identity.memberId,
      now(),
      options,
    );
    if (!served) return sendNotFound(response, config);
    if ('capacityExceeded' in served) {
      sendJson(
        response,
        config,
        served.reason === 'size_policy' ? 413 : 429,
        served.reason === 'size_policy'
          ? {
              error: 'media_snapshot_size_limit',
              message: 'This media file exceeds the local temporary storage serving limit.',
            }
          : {
              error: 'media_serving_capacity',
              message: 'Media delivery is at capacity. Try again shortly.',
            },
      );
      return;
    }
    const currentMedia = filmDownloadMatch
      ? getReleasedFilmDownload(database, identity.groupId, resourceId)
      : getReleasedOwnClipDownload(database, identity.groupId, identity.memberId, resourceId);
    if (
      !mediaIdentityIsCurrent(request, database, identity, now()) ||
      currentMedia?.outputPath !== media.outputPath
    ) {
      await served.handle.close();
      served.releaseBudget();
      return sendNotFound(response, config);
    }
    streamMp4(
      request,
      response,
      config,
      served.handle,
      served.size,
      filmDownloadMatch ? 'rewind-group-film.mp4' : 'rewind-my-clip.mp4',
      served.releaseBudget,
    );
    return;
  }

  for (const resource of ['clip', 'film', 'download'] as const) {
    const match = url.pathname.match(new RegExp(`^\\/${resource}s\\/([^/]+)$`));
    if (match) {
      const resourceId = decodePathSegment(match[1], response, config);
      if (resourceId === null) return;
      const groupId = url.searchParams.get('groupId');
      const identity = requireAuthorisedMediaGroup(
        request,
        database,
        url,
        response,
        config,
        now(),
        groupId,
        resource,
      );
      if (!identity) return;
      if (identity.accountId) {
        const released =
          resource === 'film'
            ? getReleasedFilmDownload(database, identity.groupId, resourceId)
            : resource === 'clip'
              ? getReleasedOwnClipDownload(
                  database,
                  identity.groupId,
                  identity.memberId,
                  resourceId,
                )
              : null;
        if (
          !released ||
          !(await verifiedServingPath(
            database,
            resourceId,
            resource,
            released.outputPath,
            config.dataDir,
            identity.memberId,
            now(),
            options,
          )) ||
          !mediaIdentityIsCurrent(request, database, identity, now())
        )
          return sendNotFound(response, config);
      }
      const job = getMediaJob(database, identity.groupId, resourceId, resource);
      if (!job) return sendNotFound(response, config);
      sendJson(response, config, 200, { [resource]: job });
      return;
    }
  }

  sendNotFound(response, config);
}

function isLoopbackAddress(address: string | undefined): boolean {
  return Boolean(
    address && (address === '::1' || address === '127.0.0.1' || address.startsWith('::ffff:127.')),
  );
}

function authenticatedProxyHttps(request: IncomingMessage, config: RuntimeConfig): boolean {
  const secret = config.originAuthSecret;
  const received = request.headers['x-rewind-origin-auth'];
  const forwardedProtocol = request.headers['x-forwarded-proto'];
  if (!secret || typeof received !== 'string' || forwardedProtocol !== 'https') return false;
  const expectedBytes = Buffer.from(secret);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes)
  );
}

export function authTransportIsSecure(request: IncomingMessage, config: RuntimeConfig): boolean {
  if ((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted) return true;
  if (allowsLocalHttpAuth(request, config)) return true;
  return authenticatedProxyHttps(request, config);
}

function allowsLocalHttpAuth(request: IncomingMessage, config: RuntimeConfig): boolean {
  if (!config.allowInsecureLocalAuth || !isLoopbackAddress(request.socket.remoteAddress))
    return false;
  // The hosted reverse proxy supplies this header for either viewer scheme.
  // Its presence takes the request out of the explicitly local-dev exception.
  if (request.headers['x-forwarded-proto'] !== undefined) return false;
  const host = request.headers.host ?? '';
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '');
    return hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');
  } catch {
    return false;
  }
}

export function authClientSource(request: IncomingMessage, config: RuntimeConfig): string {
  if (allowsLocalHttpAuth(request, config)) return request.socket.remoteAddress ?? 'unknown';
  if ((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted) {
    return request.socket.remoteAddress ?? 'unknown';
  }
  if (authenticatedProxyHttps(request, config)) {
    const forwarded = request.headers['x-rewind-client-address'];
    if (typeof forwarded === 'string' && isIP(forwarded)) return forwarded;
  }
  // The transport check runs before this helper. An authenticated proxy peer
  // remains a valid shared source bucket when its client-address header is
  // absent or malformed; that header affects rate-limit grouping, not auth.
  return request.socket.remoteAddress ?? 'unknown';
}

function authCorsHeaders(request: IncomingMessage, config: RuntimeConfig): Record<string, string> {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !origin) return {};
  // Wildcard CORS is never emitted on real-auth endpoints. A configured
  // browser origin is exact; same-origin local requests need no CORS grant.
  if (config.allowOrigin !== '*' && origin === config.allowOrigin) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
    };
  }
  return { Vary: 'Origin' };
}

function authOriginIsAllowed(request: IncomingMessage, config: RuntimeConfig): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !origin) return true;
  if (config.allowOrigin !== '*') return origin === config.allowOrigin;
  if (authenticatedProxyHttps(request, config)) {
    return origin === `https://${request.headers.host ?? ''}`;
  }
  if (allowsLocalHttpAuth(request, config)) {
    return origin === `http://${request.headers.host ?? ''}`;
  }
  return false;
}

function authJson(
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...authCorsHeaders(request, config),
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function authToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  const bearer =
    typeof authorization === 'string'
      ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)?.[1]
      : undefined;
  const cookieHeader = request.headers.cookie;
  const cookieValue =
    typeof cookieHeader === 'string'
      ? cookieHeader
          .split(';')
          .map((part) => part.trim())
          .find((part) => part.startsWith(`${REAL_SESSION_COOKIE}=`))
          ?.slice(REAL_SESSION_COOKIE.length + 1)
      : undefined;
  if (bearer && cookieValue && bearer !== cookieValue) return null;
  if (bearer) return bearer;
  return cookieValue && /^[A-Za-z0-9_-]{43}$/.test(cookieValue) ? cookieValue : null;
}

async function handleRealGroupRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
  database: RewindDatabase,
  url: URL,
  now: Date,
  currentClock: () => Date = () => now,
  options: RuntimeServerOptions = {},
): Promise<void> {
  if (!authTransportIsSecure(request, config) || !authOriginIsAllowed(request, config)) {
    authJson(request, response, config, 403, {
      error: 'auth_transport_unavailable',
      message: 'Group access is unavailable on this connection.',
    });
    return;
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
    return;
  }

  const limits = options.requestLimiters ?? createRequestLimiters(config);
  if (url.pathname === '/real/reminders/config' && request.method === 'GET') {
    authJson(request, response, config, 200, {
      providers: Object.keys(options.reminderProviders ?? {}).filter(
        (name) => name === 'expo' || name === 'webpush',
      ),
      webPushPublicKey: options.reminderProviders?.webpush
        ? (options.reminderWebPushPublicKey ?? null)
        : null,
    });
    return;
  }
  if (url.pathname === '/real/media/config' && request.method === 'GET') {
    authJson(request, response, config, 200, {
      // Earlier installed clients reject signed lifecycle-tag headers. Keep
      // their server-owned staging path until they negotiate tag-aware uploads.
      directTransfer:
        options.uploadIntents?.transport.backend === 's3' &&
        url.searchParams.getAll('uploadProtocol').length === 1 &&
        url.searchParams.get('uploadProtocol') === '2',
      maxVideoBytes: MAX_STAGED_SOURCE_BYTES,
      maxPhotoBytes: 10 * 1024 * 1024,
    });
    return;
  }
  const reminderDestinationMatch = url.pathname.match(
    /^\/real\/groups\/([^/]+)\/reminders\/(destinations|outbox)(?:\/([^/]+))?$/,
  );
  if (reminderDestinationMatch) {
    const groupId = decodePathSegment(reminderDestinationMatch[1], response, config);
    const id = reminderDestinationMatch[3]
      ? decodePathSegment(reminderDestinationMatch[3], response, config)
      : null;
    if (!groupId || (reminderDestinationMatch[3] && !id)) return;
    if (
      url.searchParams.has('sessionId') ||
      !getRealGroup(database, session.account.id, groupId) ||
      getCurrentRealGroup(database, session.account.id)?.group.id !== groupId
    )
      return sendDenied(response, config);
    const actor = { sessionToken: token!, groupId };
    if (request.method === 'GET' && !id) {
      const kind = reminderDestinationMatch[2];
      const deviceIds = url.searchParams.getAll('deviceId');
      if (
        deviceIds.length > 0 &&
        (kind !== 'destinations' ||
          deviceIds.length !== 1 ||
          !/^[A-Za-z0-9_-]{16,128}$/.test(deviceIds[0]))
      ) {
        authJson(request, response, config, 400, {
          error: 'invalid_destination',
          message: 'Use a valid reminder device identity.',
        });
        return;
      }
      const rows =
        kind === 'outbox'
          ? listReminderOutbox(database, actor, currentClock())
          : listReminderDestinations(database, actor, currentClock(), deviceIds[0]);
      if (!rows) return sendDenied(response, config);
      authJson(request, response, config, 200, { [kind]: rows });
      return;
    }
    if (request.method !== 'POST' || reminderDestinationMatch[2] !== 'destinations') {
      authJson(request, response, config, 405, {
        error: 'method_not_allowed',
        message: 'Use the supported reminder action.',
      });
      return;
    }
    const body = await requestBody(request, config, 8192);
    const keys = id ? ['enabled'] : ['deviceId', 'provider', 'destination'];
    if (!body || Object.keys(body).some((key) => !keys.includes(key))) {
      authJson(request, response, config, 400, {
        error: 'invalid_destination',
        message: 'Use a valid reminder destination for this device.',
      });
      return;
    }
    if (id) {
      if (
        body.enabled !== false ||
        !disableReminderDestination(database, actor, id, currentClock())
      ) {
        authJson(request, response, config, 404, {
          error: 'destination_unavailable',
          message: 'This reminder destination is unavailable.',
        });
        return;
      }
      authJson(request, response, config, 200, { disabled: true });
      return;
    }
    const provider = body.provider;
    if ((provider !== 'expo' && provider !== 'webpush') || !options.reminderProviders?.[provider]) {
      authJson(request, response, config, 503, {
        error: 'reminders_unavailable',
        message: 'This reminder provider is not configured.',
      });
      return;
    }
    const result = registerReminderDestination(
      database,
      actor,
      { deviceId: body.deviceId, provider, destination: body.destination },
      currentClock(),
    );
    if (!result.ok) {
      authJson(request, response, config, result.reason === 'forbidden' ? 403 : 400, {
        error: result.reason,
        message: 'This reminder destination cannot be registered.',
      });
      return;
    }
    authJson(request, response, config, 200, { destination: result.destination });
    return;
  }

  const uploadIntentMatch = url.pathname.match(
    /^\/real\/groups\/([^/]+)\/upload-intents(?:\/([^/]+)(\/(?:complete|reconcile))?)?$/,
  );
  if (uploadIntentMatch) {
    const groupId = decodePathSegment(uploadIntentMatch[1], response, config);
    const intentId = uploadIntentMatch[2]
      ? decodePathSegment(uploadIntentMatch[2], response, config)
      : null;
    if (groupId === null || (uploadIntentMatch[2] && intentId === null)) return;
    if (url.searchParams.has('sessionId')) return sendDenied(response, config);
    const actor = { sessionToken: token!, groupId };
    if (
      !getRealGroup(database, session.account.id, groupId) ||
      getCurrentRealGroup(database, session.account.id)?.group.id !== groupId
    )
      return sendDenied(response, config);
    const deps = options.uploadIntents ? { ...options.uploadIntents, now: currentClock } : null;
    if (!deps) {
      authJson(request, response, config, 503, {
        error: 'upload_intents_unavailable',
        message: 'Direct transfer is unavailable. Use the existing upload option.',
      });
      return;
    }
    const failed = (reason: UploadIntentFailure) => {
      const status =
        reason === 'session_required'
          ? 401
          : reason === 'forbidden'
            ? 403
            : reason === 'not_found'
              ? 404
              : reason === 'storage_failed'
                ? 503
                : [
                      'closed_cycle',
                      'quota_exceeded',
                      'idempotency_conflict',
                      'expired',
                      'version_conflict',
                      'replacement_conflict',
                    ].includes(reason)
                  ? 409
                  : 400;
      authJson(request, response, config, status, {
        error: `upload_intent_${reason}`,
        message:
          reason === 'quota_exceeded'
            ? 'This week has no remaining contribution allowance.'
            : 'This transfer cannot be completed. Check your connection and capture allowance.',
      });
    };
    if (intentId && !uploadIntentMatch[3] && request.method === 'GET') {
      const result = getUploadIntentStatus(database, actor, intentId, deps);
      if (!result.ok) return failed(result.reason);
      authJson(request, response, config, 200, { intent: result.value });
      return;
    }
    if (request.method !== 'POST' || (intentId && !uploadIntentMatch[3])) {
      authJson(request, response, config, 405, {
        error: 'method_not_allowed',
        message: 'Use the supported intent request, status or completion action.',
      });
      return;
    }
    const body = await requestBody(request, config, 8 * 1024);
    const keys = intentId
      ? uploadIntentMatch[3] === '/reconcile'
        ? []
        : ['versionId']
      : [
          'idempotencyKey',
          'mediaType',
          'contentType',
          'byteLength',
          'sha256',
          'durationSeconds',
          'trimStartSeconds',
          'trimEndSeconds',
          'mode',
          'clientProcessed',
          'replacesContributionId',
        ];
    if (!body || Object.keys(body).some((key) => !keys.includes(key)))
      return failed('invalid_request');
    const release = acquireRequestCapacity(
      (options.requestLimiters ?? createRequestLimiters(config)).processing,
      request,
      response,
      config,
    );
    if (!release) return;
    try {
      if (intentId) {
        const result =
          uploadIntentMatch[3] === '/reconcile'
            ? await reconcileUploadIntent(database, actor, { intentId }, deps)
            : await completeUploadIntent(
                database,
                actor,
                { intentId, versionId: typeof body.versionId === 'string' ? body.versionId : '' },
                deps,
              );
        if (!result.ok) return failed(result.reason);
        authJson(request, response, config, 200, { intent: result.value });
      } else {
        const result = await requestUploadIntent(
          database,
          actor,
          body as unknown as UploadIntentRequest,
          deps,
        );
        if (!result.ok) return failed(result.reason);
        authJson(request, response, config, 200, result.value);
      }
    } finally {
      release();
    }
    return;
  }

  const groupSettingsMatch = url.pathname.match(/^\/real\/groups\/([^/]+)\/(settings|reminders)$/);
  if (groupSettingsMatch && (request.method === 'GET' || request.method === 'POST')) {
    const groupId = decodePathSegment(groupSettingsMatch[1], response, config);
    if (groupId === null) return;
    const kind = groupSettingsMatch[2];
    if (!getRealGroup(database, session.account.id, groupId)) {
      authJson(request, response, config, 403, {
        error: 'forbidden',
        message: 'You do not have access to this group.',
      });
      return;
    }
    if (request.method === 'GET') {
      if (kind !== 'reminders') return sendNotFound(response, config);
      const preference = getRealReminderPreference(
        database,
        session.account.id,
        groupId,
        currentClock(),
      );
      authJson(request, response, config, 200, {
        preference: preference && {
          ...preference,
          delivery: reminderDeliveryStatus(
            database,
            session.account.id,
            options.reminderProviders ?? {},
            currentClock(),
          ),
        },
      });
      return;
    }
    const body = await requestBody(request, config);
    const allowedKeys = kind === 'settings' ? ['prompt', 'timeZone'] : ['enabled', 'snoozedUntil'];
    if (!body || Object.keys(body).some((key) => !allowedKeys.includes(key))) {
      authJson(request, response, config, 400, {
        error: 'invalid_settings',
        message: 'Enter valid group settings or your own reminder preference.',
      });
      return;
    }
    const authorize = () =>
      token !== null && validateRealSession(database, token, currentClock()).status === 'valid';
    if (!authorize()) {
      authJson(request, response, config, 401, {
        error: 'session_required',
        message: 'A valid sign-in is required.',
      });
      return;
    }
    const result =
      kind === 'settings'
        ? updateRealGroupSettings(
            database,
            session.account.id,
            groupId,
            { prompt: body.prompt, timeZone: body.timeZone },
            currentClock(),
            authorize,
          )
        : updateRealReminderPreference(
            database,
            session.account.id,
            groupId,
            { enabled: body.enabled, snoozedUntil: body.snoozedUntil },
            currentClock(),
            authorize,
          );
    if (!result.ok) {
      authJson(
        request,
        response,
        config,
        result.reason === 'forbidden' ? 403 : result.reason === 'cycle_closed' ? 409 : 400,
        {
          error: result.reason,
          message:
            result.reason === 'forbidden'
              ? 'Only the group owner can change these settings.'
              : 'Check the prompt, timezone and reminder preference, then retry.',
        },
      );
      return;
    }
    authJson(
      request,
      response,
      config,
      200,
      kind === 'reminders' && 'preference' in result && result.preference
        ? {
            ...result,
            preference: {
              ...result.preference,
              delivery: reminderDeliveryStatus(
                database,
                session.account.id,
                options.reminderProviders ?? {},
                currentClock(),
              ),
            },
          }
        : result,
    );
    return;
  }

  if (url.pathname === '/real/groups/current' && request.method === 'GET') {
    authJson(request, response, config, 200, {
      group: getCurrentRealGroup(database, session.account.id),
    });
    return;
  }

  if (url.pathname === '/real/groups' && request.method === 'GET') {
    authJson(request, response, config, 200, {
      groups: listRealGroups(database, session.account.id),
    });
    return;
  }

  if (url.pathname === '/real/groups/current' && request.method === 'POST') {
    const body = await requestBody(request, config);
    if (!body || typeof body.groupId !== 'string') {
      authJson(request, response, config, 400, {
        error: 'invalid_group',
        message: 'Choose a group you belong to.',
      });
      return;
    }
    if (!selectRealGroup(database, session.account.id, body.groupId)) {
      authJson(request, response, config, 404, {
        error: 'forbidden',
        message: 'You do not have access to this group.',
      });
      return;
    }
    authJson(request, response, config, 200, {
      group: getCurrentRealGroup(database, session.account.id),
    });
    return;
  }

  const reportMatch = url.pathname.match(/^\/real\/groups\/([^/]+)\/reports$/);
  if (reportMatch && request.method === 'POST') {
    if (
      !enforceRateLimit(
        limits.safety,
        session.account.id,
        now,
        request,
        response,
        config,
        'You have made too many safety requests. Please wait before trying again.',
      )
    )
      return;
    const groupId = decodePathSegment(reportMatch[1], response, config);
    if (groupId === null) return;
    const body = await requestBody(request, config, 8 * 1024);
    const result = reportContent(database, session.account.id, groupId, body ?? {}, now);
    if (result === 'invalid') {
      authJson(request, response, config, 400, {
        error: 'invalid_report',
        message: 'Report one message, moment or person, with a reason of up to 500 characters.',
      });
      return;
    }
    if (result === 'not_found') {
      authJson(request, response, config, 404, {
        error: 'not_found',
        message: 'That content was not found in this group.',
      });
      return;
    }
    authJson(request, response, config, 201, { reported: true });
    return;
  }

  const removeMatch = url.pathname.match(
    /^\/real\/groups\/([^/]+)\/contributions\/([^/]+)\/remove$/,
  );
  if (removeMatch && request.method === 'POST') {
    const groupId = decodePathSegment(removeMatch[1], response, config);
    if (groupId === null) return;
    const contributionId = decodePathSegment(removeMatch[2], response, config);
    if (contributionId === null) return;
    const result = removeContribution(database, session.account.id, groupId, contributionId, now);
    if (result === 'forbidden') {
      authJson(request, response, config, 403, {
        error: 'forbidden',
        message: 'Only the group owner can remove moments.',
      });
      return;
    }
    if (result === 'not_found') {
      authJson(request, response, config, 404, {
        error: 'not_found',
        message: 'That moment was not found in this group.',
      });
      return;
    }
    authJson(request, response, config, 200, { removed: true });
    return;
  }

  if (url.pathname === '/real/blocks' && request.method === 'GET') {
    authJson(request, response, config, 200, {
      blocked: listBlockedMembers(database, session.account.id),
    });
    return;
  }

  if (url.pathname === '/real/blocks' && request.method === 'POST') {
    if (
      !enforceRateLimit(
        limits.safety,
        session.account.id,
        now,
        request,
        response,
        config,
        'You have made too many safety requests. Please wait before trying again.',
      )
    )
      return;
    const body = await requestBody(request, config, 8 * 1024);
    const profileId = typeof body?.profileId === 'string' ? body.profileId : '';
    if (!profileId || blockMember(database, session.account.id, profileId, now) !== 'blocked') {
      authJson(request, response, config, 404, {
        error: 'not_found',
        message: 'That member was not found in your groups.',
      });
      return;
    }
    authJson(request, response, config, 201, { blocked: true });
    return;
  }

  const unblockMatch = url.pathname.match(/^\/real\/blocks\/([^/]+)$/);
  if (unblockMatch && request.method === 'DELETE') {
    if (
      !enforceRateLimit(
        limits.safety,
        session.account.id,
        now,
        request,
        response,
        config,
        'You have made too many safety requests. Please wait before trying again.',
      )
    )
      return;
    const profileId = decodePathSegment(unblockMatch[1], response, config);
    if (profileId === null) return;
    unblockMember(database, session.account.id, profileId);
    authJson(request, response, config, 200, { blocked: false });
    return;
  }

  const realGroupMembersMatch = url.pathname.match(/^\/real\/groups\/([^/]+)\/members$/);
  if (realGroupMembersMatch && request.method === 'GET') {
    const groupId = decodePathSegment(realGroupMembersMatch[1], response, config);
    if (groupId === null) return;
    const summary = listRealGroupMemberSummaries(database, session.account.id, groupId, now);
    if (!summary) {
      authJson(request, response, config, 404, {
        error: 'forbidden',
        message: 'You do not have access to this group.',
      });
      return;
    }
    authJson(request, response, config, 200, summary);
    return;
  }

  if (url.pathname === '/real/invites/accept' && request.method === 'POST') {
    const body = await requestBody(request, config);
    if (!body) {
      authJson(request, response, config, 400, {
        status: 'malformed',
        error: 'invalid_invite',
        message: 'Enter a valid invitation code.',
      });
      return;
    }
    let result: ReturnType<typeof acceptRealGroupInvite>;
    try {
      result = acceptRealGroupInvite(
        database,
        session.account,
        body.code,
        body.groupId,
        now,
        authClientSource(request, config),
      );
    } catch {
      authJson(request, response, config, 409, {
        status: 'denied',
        error: 'invite_accept_failed',
        message: 'The invitation could not be accepted. No partial membership was saved.',
      });
      return;
    }
    if (!result.ok) {
      const status =
        result.status === 'throttled'
          ? 429
          : result.status === 'denied'
            ? 404
            : result.status === 'full'
              ? 409
              : 400;
      authJson(request, response, config, status, {
        status: result.status,
        error: `invite_${result.status}`,
        message:
          result.status === 'expired'
            ? "That code isn't valid or has expired."
            : result.status === 'replayed'
              ? 'This invitation has already been used.'
              : result.status === 'full'
                ? 'This group has reached its member limit.'
                : result.status === 'denied'
                  ? 'You do not have access to this group.'
                  : result.status === 'throttled'
                    ? 'Too many invitation attempts. Please try again later.'
                    : "That code isn't valid or has expired.",
      });
      return;
    }
    authJson(request, response, config, 200, result);
    return;
  }

  const realGroupMatch = url.pathname.match(/^\/real\/groups\/([^/]+)$/);
  if (realGroupMatch && request.method === 'GET') {
    const groupId = decodePathSegment(realGroupMatch[1], response, config);
    if (groupId === null) return;
    const group = getRealGroup(database, session.account.id, groupId);
    if (!group) {
      authJson(request, response, config, 404, {
        error: 'forbidden',
        message: 'You do not have access to this group.',
      });
      return;
    }
    authJson(request, response, config, 200, { group });
    return;
  }

  if (url.pathname === '/real/groups' && request.method === 'POST') {
    if (
      !enforceRateLimit(
        limits.groups,
        session.account.id,
        now,
        request,
        response,
        config,
        'You have reached the group creation limit. Please try again later.',
      )
    )
      return;
    const body = await requestBody(request, config);
    if (!body) {
      authJson(request, response, config, 400, {
        error: 'invalid_group',
        message: 'Enter a valid group name, prompt, and member limit from 2 to 10.',
      });
      return;
    }
    // Recheck durable ownership after receiving the body: concurrent requests
    // must not both pass at nineteen groups before either has committed.
    const owned = database
      .prepare('SELECT COUNT(*) AS count FROM real_group_metadata WHERE owner_account_id = ?')
      .get(session.account.id) as { count: number };
    if (owned.count >= 20) {
      authJson(request, response, config, 429, {
        error: 'rate_limited',
        message: 'You already own twenty groups. Leave or hand on a group before creating another.',
      });
      finishRejectedRequest(request, response);
      return;
    }
    let created: ReturnType<typeof createRealGroup>;
    try {
      created = createRealGroup(
        database,
        session.account,
        {
          name: body.name,
          prompt: body.prompt,
          maxMembers: body.maxMembers,
          timeZone: body.timeZone,
        },
        now,
        config.realCycleDurationMs,
      );
    } catch {
      authJson(request, response, config, 409, {
        error: 'group_create_failed',
        message: 'The group could not be created. No partial group was saved.',
      });
      return;
    }
    if (!created) {
      authJson(request, response, config, 400, {
        error: 'invalid_group',
        message: 'Enter a valid group name, prompt, and member limit from 2 to 10.',
      });
      return;
    }
    authJson(request, response, config, 201, created);
    return;
  }

  const revokeInviteMatch = url.pathname.match(/^\/real\/groups\/([^/]+)\/invites\/([^/]+)$/);
  if (revokeInviteMatch && request.method === 'DELETE') {
    const groupId = decodePathSegment(revokeInviteMatch[1], response, config);
    const inviteId = decodePathSegment(revokeInviteMatch[2], response, config);
    if (groupId === null || inviteId === null) return;
    if (!revokeRealGroupInvite(database, groupId, session.account.id, inviteId)) {
      authJson(request, response, config, 404, {
        error: 'invite_not_found',
        message: 'That active invitation is no longer available.',
      });
      return;
    }
    authJson(request, response, config, 200, { revoked: true });
    return;
  }

  const inviteMatch = url.pathname.match(/^\/real\/groups\/([^/]+)\/invites$/);
  if (inviteMatch && request.method === 'POST') {
    const groupId = decodePathSegment(inviteMatch[1], response, config);
    if (groupId === null) return;
    const body = await requestBody(request, config);
    if (body === null) {
      authJson(request, response, config, 400, {
        error: 'invalid_invite',
        message: 'The invitation expiry is invalid.',
      });
      return;
    }
    const ttlSeconds =
      typeof body.expiresInSeconds === 'number'
        ? body.expiresInSeconds
        : typeof body.expiresInSeconds === 'string'
          ? Number(body.expiresInSeconds)
          : undefined;
    let result: ReturnType<typeof createRealGroupInvite>;
    try {
      result = createRealGroupInvite(database, groupId, session.account.id, ttlSeconds, now);
    } catch {
      authJson(request, response, config, 409, {
        error: 'invite_create_failed',
        message: 'The invitation could not be created. No partial invitation was saved.',
      });
      return;
    }
    if (!result.ok) {
      const status =
        result.reason === 'not_found' ? 404 : result.reason === 'forbidden' ? 403 : 400;
      authJson(request, response, config, status, {
        error: `invite_${result.reason}`,
        message:
          result.reason === 'invalid_expiry'
            ? 'Choose an invitation expiry between five minutes and seven days.'
            : 'You cannot create an invitation for this group.',
      });
      return;
    }
    authJson(request, response, config, 201, { invite: result.invite });
    return;
  }

  authJson(request, response, config, 404, {
    error: 'not_found',
    message: 'The requested real-group resource was not found.',
  });
}

async function handleRealAuthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
  database: RewindDatabase,
  registrationRateLimiter: RegistrationRateLimiter,
  url: URL,
  now: Date,
  options: RuntimeServerOptions = {},
): Promise<void> {
  if (!authTransportIsSecure(request, config) || !authOriginIsAllowed(request, config)) {
    authJson(request, response, config, 403, {
      error: 'auth_transport_unavailable',
      message: 'Sign-in is unavailable on this connection.',
    });
    return;
  }

  if (url.pathname === '/auth/register' && request.method === 'POST') {
    const rateLimit = registrationRateLimiter.tryAcquire(
      authClientSource(request, config),
      now.getTime(),
    );
    if (!rateLimit.allowed) {
      authJson(
        request,
        response,
        config,
        429,
        {
          error: 'registration_rate_limited',
          message: 'Registration is temporarily unavailable. Please try again later.',
        },
        { 'Retry-After': String(rateLimit.retryAfter) },
      );
      return;
    }

    const body = await requestBody(request, config, 8 * 1024);
    const username = typeof body?.username === 'string' ? body.username : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!body || !username || username.length > 128 || !password || password.length > 1024) {
      authJson(request, response, config, 400, {
        error: 'invalid_registration',
        message: 'Account registration failed. Check your details or try later.',
      });
      return;
    }

    try {
      const result = await createRealAccount(database, username, username.trim(), password, now);
      if (!result.ok && result.reason === 'duplicate') {
        authJson(request, response, config, 409, {
          error: 'username_unavailable',
          message: 'This username is unavailable. Choose another username or sign in.',
        });
        return;
      }
      if (!result.ok) {
        authJson(request, response, config, 400, {
          error: 'invalid_registration',
          message: 'Account registration failed. Check your details or try later.',
        });
        return;
      }
      authJson(request, response, config, 201, { account: result.account });
    } catch {
      authJson(request, response, config, 503, {
        error: 'registration_unavailable',
        message: 'Registration is temporarily unavailable. Please try again later.',
      });
    }
    return;
  }

  if (url.pathname === '/auth/login' && request.method === 'POST') {
    const body = await requestBody(request, config);
    const username = typeof body?.username === 'string' ? body.username : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const clientType = body?.clientType;
    if (
      !username ||
      username.length > 128 ||
      !password ||
      password.length > 1024 ||
      (clientType !== 'browser' && clientType !== 'native')
    ) {
      authJson(request, response, config, 401, {
        error: 'sign_in_failed',
        message: 'Sign-in failed. Check your details or try later.',
      });
      return;
    }
    const source = authClientSource(request, config);
    const result = await authenticateRealAccount(database, username, password, source, now);
    if (result.status !== 'authenticated') {
      authJson(request, response, config, 401, {
        error: 'sign_in_failed',
        message: 'Sign-in failed. Check your details or try later.',
      });
      return;
    }
    if (clientType === 'browser') {
      const maxAge = Math.max(0, Math.floor((Date.parse(result.expiresAt) - now.getTime()) / 1000));
      authJson(
        request,
        response,
        config,
        200,
        { account: result.account, expiresAt: result.expiresAt },
        {
          'Set-Cookie': `${REAL_SESSION_COOKIE}=${result.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
        },
      );
    } else {
      authJson(request, response, config, 200, {
        account: result.account,
        token: result.token,
        expiresAt: result.expiresAt,
      });
    }
    return;
  }

  if (url.pathname === '/auth/session' && request.method === 'GET') {
    const token = authToken(request);
    const session = validateRealSession(database, token ?? '', now);
    if (session.status !== 'valid') {
      const missingCredential = token === null;
      authJson(request, response, config, 401, {
        error: missingCredential ? 'session_required' : 'session_expired',
        message: missingCredential
          ? 'A valid sign-in is required.'
          : 'This sign-in has expired or was revoked.',
      });
      return;
    }
    authJson(
      request,
      response,
      config,
      200,
      {
        account: session.account,
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
      },
      request.headers.cookie && !request.headers.authorization
        ? {
            'Set-Cookie': `${REAL_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((Date.parse(session.idleExpiresAt) - now.getTime()) / 1000))}`,
          }
        : {},
    );
    return;
  }

  if (url.pathname === '/auth/account/delete' && request.method === 'POST') {
    const token = authToken(request);
    const session = token ? validateRealSession(database, token, now) : null;
    if (session?.status !== 'valid') {
      authJson(request, response, config, 401, {
        error: 'session_required',
        message: 'A valid sign-in is required.',
      });
      return;
    }
    const body = await requestBody(request, config, 8 * 1024);
    const password = typeof body?.password === 'string' ? body.password : '';
    const check = password
      ? await verifyRealAccountPassword(database, session.account.id, password, now)
      : 'invalid';
    if (check !== 'ok') {
      authJson(request, response, config, check === 'throttled' ? 429 : 403, {
        error: check === 'throttled' ? 'password_check_throttled' : 'password_incorrect',
        message:
          check === 'throttled'
            ? 'Too many attempts. Try again later.'
            : 'The password is incorrect.',
      });
      return;
    }
    const media = purgeRealAccount(database, session.account.id, now);
    await removeStoredMedia(media, {
      outputDir: resolve(config.dataDir, 'media', 'processed'),
      stagingDir: resolve(config.dataDir, 'media', 'staging'),
      mediaStore: options.mediaStore,
      mediaEnvironment: options.mediaEnvironment,
    });
    authJson(
      request,
      response,
      config,
      200,
      { deleted: true },
      {
        'Set-Cookie': `${REAL_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
      },
    );
    return;
  }

  if (url.pathname === '/auth/logout' && request.method === 'POST') {
    const token = authToken(request);
    if (token) revokeRealSession(database, token, now);
    authJson(
      request,
      response,
      config,
      200,
      { signedOut: true },
      {
        'Set-Cookie': `${REAL_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
      },
    );
    return;
  }

  authJson(request, response, config, 404, {
    error: 'not_found',
    message: 'The requested resource was not found.',
  });
}

export function createRuntimeServer(
  config: RuntimeConfig,
  database: RewindDatabase,
  options: RuntimeServerOptions = {},
): Server {
  const realtimeHub = options.realtimeHub ?? new RealtimeHub();
  const mediaCapabilities = options.mediaCapabilities ?? new MediaCapabilities();
  const requestLimiters = options.requestLimiters ?? createRequestLimiters(config);
  return createServer((request, response) => {
    const observation = requestObservation();
    response.setHeader('X-Request-Id', observation.requestId);
    response.once('finish', () => {
      if (response.statusCode >= 500) observation.failure(response.statusCode);
      if (config.requestTiming)
        observation.timing(request.method, request.url, response.statusCode);
    });
    void handleRequest(request, response, config, database, {
      ...options,
      realtimeHub,
      mediaCapabilities,
      requestLimiters,
    }).catch((error: unknown) => {
      const authRequest = (request.url ?? '').split('?', 1)[0].startsWith('/auth/');
      if (error instanceof RequestPolicyError) {
        if (authRequest) {
          authJson(request, response, config, error.status, {
            error: error.code,
            message: error.message,
          });
        } else {
          sendRequestPolicyError(response, config, error);
        }
        finishRejectedRequest(request, response);
        return;
      }
      observation.failure(500);
      if (!response.headersSent) {
        const body = {
          error: 'internal_error',
          message: 'The local runtime could not complete the request.',
        };
        if (authRequest) authJson(request, response, config, 500, body);
        else sendJson(response, config, 500, body);
      } else {
        response.destroy();
      }
    });
  });
}

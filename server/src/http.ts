import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { once } from 'node:events';
import { URL } from 'node:url';

import { SERVICE_VERSION, type RuntimeConfig } from './config';
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
  listChatEvents,
  toggleChatReaction,
} from './chat';
import { encodeSseEvent, RealtimeHub } from './realtime';
import { advanceDemoCycle } from './cycles';
import { classifyDemoSession } from './session/contract';
import { authorizeMember, authorizeOwner, SAFE_DENIAL, type ProtectedResource } from './policy';
import {
  createDemoSession,
  getDemoSession,
  invalidateDemoSession,
  updateDemoSessionGroup,
  validateDemoSession,
} from './session';
import { createGroup } from './groups';
import { acceptInvite, createInvite } from './invites';
import { deleteContribution } from './contributions';
import {
  cancelClipUpload,
  claimStagedSource,
  acquireStagedSourceLock,
  cleanupStagedSource,
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
import { cleanupOrphanedStagedSources, processClipJob } from './jobs';
import { isAbsolute, relative, resolve } from 'node:path';
import { probeClipWithFfmpeg } from './ffmpeg';

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
    'Access-Control-Allow-Headers': 'Content-Type, Last-Event-ID',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Origin': config.allowOrigin,
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
  response.writeHead(200, {
    'Access-Control-Allow-Headers': 'Content-Type, Last-Event-ID',
    'Access-Control-Allow-Origin': config.allowOrigin,
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

function actingMember(url: URL): string | null {
  return url.searchParams.get('memberId');
}

function sessionMember(database: RewindDatabase, url: URL, now = new Date()): string | null {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return actingMember(url);
  const result = validateDemoSession(database, sessionId, now);
  return result.status === 'valid' ? result.session.actor.memberId : null;
}

function sessionScope(database: RewindDatabase, url: URL, now = new Date()) {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return { memberId: actingMember(url), groupId: null };
  const result = validateDemoSession(database, sessionId, now);
  return result.status === 'valid'
    ? { memberId: result.session.actor.memberId, groupId: result.session.groupId }
    : { memberId: null, groupId: null };
}

function requireSessionMember(
  database: RewindDatabase,
  url: URL,
  response: ServerResponse,
  config: RuntimeConfig,
  now: Date,
): { memberId: string; groupId: string } | null {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) {
    sendSessionRequired(response, config);
    return null;
  }
  const session = validateDemoSession(database, sessionId, now);
  if (session.status !== 'valid') {
    sendSessionRequired(response, config);
    return null;
  }
  return { memberId: session.session.actor.memberId, groupId: session.session.groupId };
}

type PremiereState = 'locked' | 'processing' | 'delayed' | 'ready';

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

function streamMp4(
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
  path: string,
  size: number,
  attachmentName?: string,
): void {
  const range = request.headers.range;
  let start = 0;
  let end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}` });
      response.end();
      return;
    }
    if (!match[1] && !match[2]) {
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
      response.writeHead(416, { 'Content-Range': `bytes */${size}` });
      response.end();
      return;
    }
    end = Math.min(end, size - 1);
  }
  const status = range ? 206 : 200;
  response.writeHead(status, {
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': config.allowOrigin,
    'Cache-Control': 'no-store',
    'Content-Length': String(end - start + 1),
    'Content-Type': 'video/mp4',
    ...(attachmentName
      ? { 'Content-Disposition': `attachment; filename="${attachmentName}"` }
      : {}),
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  createReadStream(path, { start, end })
    .on('error', () => response.destroy())
    .pipe(response);
}

export interface RuntimeServerOptions {
  now?: () => Date;
  realtimeHub?: RealtimeHub;
  realtimeHeartbeatIntervalMs?: number;
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > 64 * 1024) return null;
    chunks.push(buffer);
  }
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

async function stageSourceBody(
  request: IncomingMessage,
  stagingDir: string,
  sourcePath: string,
): Promise<number> {
  const contentLength = Number(request.headers['content-length'] ?? Number.NaN);
  if (Number.isFinite(contentLength) && contentLength <= 0) {
    throw new Error('empty source');
  }
  if (Number.isFinite(contentLength) && contentLength > MAX_STAGED_SOURCE_BYTES) {
    throw new Error('source too large');
  }
  await mkdir(stagingDir, { recursive: true });
  const partialPath = `${sourcePath}.${randomUUID()}.part`;
  const output = createWriteStream(partialPath, { flags: 'wx' });
  let bytes = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.byteLength;
      if (bytes > MAX_STAGED_SOURCE_BYTES) throw new Error('source too large');
      if (!output.write(buffer)) await once(output, 'drain');
    }
    await new Promise<void>((resolvePromise, reject) => {
      output.once('error', reject);
      output.end(() => resolvePromise());
    });
    if (bytes <= 0) throw new Error('empty source');
    await rename(partialPath, sourcePath);
    return bytes;
  } catch (error) {
    output.destroy();
    await rm(partialPath, { force: true });
    throw error;
  }
}

function authorize(
  database: RewindDatabase,
  response: ServerResponse,
  config: RuntimeConfig,
  groupId: string,
  memberId: string | null,
  resource: ProtectedResource,
): boolean {
  const decision = authorizeMember(database, groupId, memberId, resource);
  if (!decision.allowed) {
    sendDenied(response, config);
    return false;
  }
  return true;
}

function groupForMember(database: RewindDatabase, memberId: string | null) {
  if (!memberId) return null;
  const row = database
    .prepare(
      'SELECT group_id AS groupId FROM memberships WHERE member_id = ? ORDER BY group_id LIMIT 1',
    )
    .get(memberId) as { groupId?: string } | undefined;
  return row?.groupId ? getGroup(database, row.groupId) : null;
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
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Headers': 'Content-Type, Last-Event-ID',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Origin': config.allowOrigin,
    });
    response.end();
    return;
  }
  if (!['GET', 'POST', 'DELETE'].includes(request.method ?? '')) {
    sendJson(response, config, 405, {
      error: 'method_not_allowed',
      message: 'Only GET, POST, and DELETE are supported.',
    });
    return;
  }

  if (url.pathname === '/health' || url.pathname === '/version') {
    const health = healthPayload(config, database);
    sendJson(response, config, health.ready ? 200 : 503, health);
    return;
  }

  if (url.pathname === '/sessions/demo' && request.method === 'POST') {
    const body = await requestBody(request);
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
    const sessionId = url.searchParams.get('sessionId');
    const validation = sessionId ? validateDemoSession(database, sessionId, now()) : null;
    if (!validation || validation.status !== 'valid') {
      sendJson(response, config, 401, {
        error: 'session_required',
        message: 'Choose Demo access before resetting local Demo data.',
      });
      return;
    }
    if (
      !authorizeOwner(database, validation.session.groupId, validation.session.actor.memberId)
        .allowed
    ) {
      sendDenied(response, config);
      return;
    }
    const stagingDir = resolve(config.dataDir, 'media', 'staging');
    const releaseStagingLock = await acquireStagedSourceLock(stagingDir);
    try {
      await waitForStagedIntakesIdle();
      restoreFixture(database);
      // The lock prevents a concurrent upload from recreating a staged file
      // while reset is clearing every Demo-owned media artifact. Keep the
      // directory itself because hosted Compose binds it as a mount target.
      const mediaDir = resolve(config.dataDir, 'media');
      for (const entry of await readdir(mediaDir).catch(() => [])) {
        await rm(resolve(mediaDir, entry), { recursive: true, force: true });
      }
      await mkdir(stagingDir, { recursive: true });
      sendJson(response, config, 200, { reset: true });
    } finally {
      releaseStagingLock();
    }
    return;
  }

  const realtimeEventsMatch = url.pathname.match(/^\/realtime\/groups\/([^/]+)\/events$/);
  if (realtimeEventsMatch && request.method === 'GET') {
    const groupId = decodePathSegment(realtimeEventsMatch[1], response, config);
    if (groupId === null) return;
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
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
      return;
    }
    const session = validateDemoSession(database, sessionId, now());
    if (session.status !== 'valid') {
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
      return;
    }
    const access = authorizeMember(database, groupId, session.session.actor.memberId, 'message');
    if (!access.allowed) {
      if (!sendRealtimeAccessDenied(request, response, config)) sendDenied(response, config);
      return;
    }

    const lastEventHeader = request.headers['last-event-id'];
    const lastEventValue = Array.isArray(lastEventHeader)
      ? lastEventHeader[0]
      : (lastEventHeader ?? url.searchParams.get('sinceEventId'));
    const parsedLastEventId = lastEventValue ? Number(lastEventValue) : 0;
    const sinceEventId =
      Number.isSafeInteger(parsedLastEventId) && parsedLastEventId >= 0 ? parsedLastEventId : 0;
    const hub = options.realtimeHub;
    if (!hub) {
      sendJson(response, config, 500, {
        error: 'realtime_unavailable',
        message: 'The local realtime transport is not available.',
      });
      return;
    }

    response.writeHead(200, {
      'Access-Control-Allow-Headers': 'Content-Type, Last-Event-ID',
      'Access-Control-Allow-Origin': config.allowOrigin,
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    });
    response.write(': connected\n\n');

    const writeEvent = (event: Parameters<typeof encodeSseEvent>[0]) => {
      if (!response.writableEnded && !response.destroyed) response.write(encodeSseEvent(event));
    };
    let unsubscribe = () => {};
    const streamIsAuthorised = () => {
      const currentSession = getDemoSession(database, session.session.id);
      return Boolean(
        currentSession &&
        currentSession.actor.memberId === session.session.actor.memberId &&
        classifyDemoSession(currentSession.expiresAt, currentSession.invalidatedAt, now()) ===
          'valid' &&
        isMember(database, groupId, currentSession.actor.memberId),
      );
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
    // Register before replay so a message sent during reconnect is either
    // observed live or present in the replay query.
    unsubscribe = hub.subscribe(groupId, writeAuthorisedEvent);
    for (const event of listChatEvents(database, groupId, sinceEventId)) {
      writeAuthorisedEvent(event);
    }
    const heartbeat = setInterval(() => {
      if (response.writableEnded || response.destroyed || endUnauthorisedStream()) return;
      response.write(': keep-alive\n\n');
    }, options.realtimeHeartbeatIntervalMs ?? 15_000);
    heartbeat.unref();
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    response.once('close', cleanup);
    return;
  }

  const realtimeMessagesMatch = url.pathname.match(/^\/realtime\/groups\/([^/]+)\/messages$/);
  if (realtimeMessagesMatch && request.method === 'POST') {
    const groupId = decodePathSegment(realtimeMessagesMatch[1], response, config);
    if (groupId === null) return;
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) return sendSessionRequired(response, config);
    const session = validateDemoSession(database, sessionId, now());
    if (session.status !== 'valid') return sendSessionRequired(response, config);
    if (
      !authorize(database, response, config, groupId, session.session.actor.memberId, 'message')
    ) {
      return;
    }
    const body = await requestBody(request);
    const result = createChatMessage(database, {
      groupId,
      memberId: session.session.actor.memberId,
      sessionId: session.session.id,
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
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) return sendSessionRequired(response, config);
    const session = validateDemoSession(database, sessionId, now());
    if (session.status !== 'valid') return sendSessionRequired(response, config);
    if (
      !authorize(database, response, config, groupId, session.session.actor.memberId, 'message')
    ) {
      return;
    }
    if (request.method === 'GET') {
      const message = getMessage(database, groupId, messageId);
      if (!message) return sendNotFound(response, config);
      sendJson(response, config, 200, { message });
      return;
    }
    const body = await requestBody(request);
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
      memberId: session.session.actor.memberId,
      sessionId: session.session.id,
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
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      sendDenied(response, config);
      return;
    }
    const session = validateDemoSession(database, sessionId, now());
    if (session.status !== 'valid') {
      sendJson(response, config, 401, {
        error: 'session_required',
        message: 'Choose active Demo access before creating a group.',
      });
      return;
    }
    const body = await requestBody(request);
    const result = createGroup(database, session.session.actor.memberId, {
      name: typeof body?.name === 'string' ? body.name : '',
      prompt: typeof body?.prompt === 'string' ? body.prompt : '',
      now: now(),
    });
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
    const moved = updateDemoSessionGroup(database, sessionId, result.group?.id ?? '');
    if (!moved.ok) {
      sendJson(response, config, 500, {
        error: 'group_context_error',
        message: 'The local group was created but its Demo context could not be updated.',
      });
      return;
    }
    sendJson(response, config, 201, {
      group: result.group,
      cycle: result.cycle,
      session: moved.session,
    });
    return;
  }

  if (url.pathname === '/invites' && request.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');
    const groupId = url.searchParams.get('groupId');
    if (!sessionId) return sendSessionRequired(response, config);
    const session = validateDemoSession(database, sessionId, now());
    if (session.status !== 'valid') return sendSessionRequired(response, config);
    if (!groupId) return sendDenied(response, config);
    const body = await requestBody(request);
    const ttlSeconds =
      typeof body?.expiresInSeconds === 'number'
        ? body.expiresInSeconds
        : typeof body?.expiresInSeconds === 'string'
          ? Number(body.expiresInSeconds)
          : undefined;
    const result = createInvite(
      database,
      session.session.actor.memberId,
      groupId,
      ttlSeconds,
      now(),
    );
    if (!result.ok) {
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
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) return sendSessionRequired(response, config);
    const session = validateDemoSession(database, sessionId, now());
    if (session.status !== 'valid') return sendSessionRequired(response, config);
    const body = await requestBody(request);
    const code = typeof body?.code === 'string' ? body.code : (url.searchParams.get('code') ?? '');
    const result = acceptInvite(
      database,
      session.session.actor.memberId,
      code,
      url.searchParams.get('groupId') ?? undefined,
      now(),
    );
    if (!result.ok) {
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
    const moved = updateDemoSessionGroup(database, sessionId, result.group.id);
    if (!moved.ok) {
      sendJson(response, config, 500, {
        error: 'invite_context_error',
        message: 'The membership was created but Demo context could not be updated.',
      });
      return;
    }
    sendJson(response, config, 200, {
      invite: result.invite,
      group: result.group,
      session: moved.session,
    });
    return;
  }

  if (url.pathname === '/contributions/upload/source' && request.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');
    const groupId = url.searchParams.get('groupId');
    const idempotencyKey = url.searchParams.get('idempotencyKey') ?? '';
    if (!sessionId) return sendSessionRequired(response, config);
    const session = validateDemoSession(database, sessionId, now());
    if (session.status !== 'valid') return sendSessionRequired(response, config);
    if (!groupId) return sendDenied(response, config);
    if (
      !authorize(
        database,
        response,
        config,
        groupId,
        session.session.actor.memberId,
        'contribution',
      )
    )
      return;
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
    if (contentType !== 'video/mp4' && contentType !== 'application/octet-stream') {
      sendJson(response, config, 400, {
        error: 'upload_invalid_media',
        message: 'Upload the clip as an MP4 source.',
      });
      return;
    }
    const stagingDir = resolve(config.dataDir, 'media', 'staging');
    let releaseStagingLock: (() => void) | null = await acquireStagedSourceLock(stagingDir);
    let releaseActiveIntake: (() => void) | null = null;
    try {
      await cleanupOrphanedStagedSources(database, stagingDir);
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
        groupId,
        session.session.actor.memberId,
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
          groupId,
          session.session.actor.memberId,
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
        await stageSourceBody(request, stagingDir, claimedSourcePath);
        const probed = await probeClipWithFfmpeg(config.ffmpegBin, claimedSourcePath, stagingDir);
        database.exec('BEGIN');
        try {
          recordClipMediaMetadata(database, {
            sourceUri,
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
        await rm(claimedSourcePath, { force: true }).catch(() => undefined);
        resetStagedSourceClaim(database, sourceUri, claimedSourcePath, claimGeneration);
        const message =
          error instanceof Error && error.message === 'source too large'
            ? 'The clip is larger than 50 MB.'
            : 'The clip source could not be staged. Try again.';
        sendJson(response, config, 400, { error: 'upload_staging_failed', message });
      }
    } finally {
      releaseActiveIntake?.();
      releaseActiveIntake = null;
      releaseStagingLock?.();
      releaseStagingLock = null;
    }
    return;
  }

  if (url.pathname === '/contributions/upload' && request.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');
    const groupId = url.searchParams.get('groupId');
    if (!sessionId) return sendSessionRequired(response, config);
    const session = validateDemoSession(database, sessionId, now());
    if (session.status !== 'valid') return sendSessionRequired(response, config);
    if (!groupId) return sendDenied(response, config);
    const body = await requestBody(request);
    const input: ClipUploadInput = {
      idempotencyKey: typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : '',
      sourceUri: typeof body?.sourceUri === 'string' ? body.sourceUri : '',
      mimeType: typeof body?.mimeType === 'string' ? body.mimeType : '',
      byteLength: typeof body?.byteLength === 'number' ? body.byteLength : Number.NaN,
      durationSeconds:
        typeof body?.durationSeconds === 'number' ? body.durationSeconds : Number.NaN,
      width: typeof body?.width === 'number' ? body.width : Number.NaN,
      height: typeof body?.height === 'number' ? body.height : Number.NaN,
      hasAudio: body?.hasAudio === true,
      ...(typeof body?.mode === 'string'
        ? { mode: body.mode as 'soft-focus' | 'high-contrast' }
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
    };
    const result = createClipUpload(
      database,
      groupId,
      session.session.actor.memberId,
      input,
      now(),
      {
        stagingDir: resolve(config.dataDir, 'media', 'staging'),
        requireVerifiedMetadata: true,
      },
    );
    if (!result.ok) {
      if (result.reason === 'not_found') return sendNotFound(response, config);
      // Key validation happens before capability ownership is established. Do
      // not let an invalid-key request delete a URI supplied by another
      // capture (or an arbitrary caller-controlled URI).
      if (result.reason !== 'invalid_key') {
        cleanupStagedSource(database, input.sourceUri, resolve(config.dataDir, 'media', 'staging'));
      }
      sendJson(response, config, result.reason === 'quota_exceeded' ? 409 : 400, {
        error: `upload_${result.reason}`,
        message:
          result.reason === 'quota_exceeded'
            ? 'This cycle has no remaining contribution allowance.'
            : result.reason === 'invalid_key'
              ? 'Provide a retryable upload key.'
              : result.reason === 'invalid_mode'
                ? 'Choose a supported original capture mode.'
                : 'The clip must be an MP4 portrait video with audio, within 15 seconds and 50 MB.',
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
    const sessionId = url.searchParams.get('sessionId');
    const groupId = url.searchParams.get('groupId');
    if (!sessionId) return sendSessionRequired(response, config);
    const session = validateDemoSession(database, sessionId, now());
    if (session.status !== 'valid') return sendSessionRequired(response, config);
    if (!groupId) return sendDenied(response, config);
    if (
      !authorize(
        database,
        response,
        config,
        groupId,
        session.session.actor.memberId,
        'contribution',
      )
    )
      return;
    const stagingDir = resolve(config.dataDir, 'media', 'staging');
    const result = cancelClipUpload(database, groupId, session.session.actor.memberId, jobId, {
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
    const sessionId = url.searchParams.get('sessionId');
    const groupId = url.searchParams.get('groupId');
    if (!sessionId) return sendSessionRequired(response, config);
    const session = validateDemoSession(database, sessionId, now());
    if (session.status !== 'valid') return sendSessionRequired(response, config);
    if (!groupId) return sendDenied(response, config);
    if (
      !authorize(
        database,
        response,
        config,
        groupId,
        session.session.actor.memberId,
        'contribution',
      )
    )
      return;
    const result = await processClipJob(database, {
      jobId,
      groupId,
      ffmpegBin: config.ffmpegBin,
      stagingDir: resolve(config.dataDir, 'media', 'staging'),
      outputDir: resolve(config.dataDir, 'media', 'processed'),
      actorMemberId: session.session.actor.memberId,
    });
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

  if (request.method === 'POST' && url.pathname === '/cycles/demo/advance') {
    const groupId = url.searchParams.get('groupId');
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      sendSessionRequired(response, config);
      return;
    }
    const session = validateDemoSession(database, sessionId, now());
    if (session.status !== 'valid') {
      sendSessionRequired(response, config);
      return;
    }
    const memberId = session.session.actor.memberId;
    const advanceSecondsValue = url.searchParams.get('advanceSeconds');
    const advanceSeconds = advanceSecondsValue ? Number(advanceSecondsValue) : Number.NaN;
    if (!groupId) {
      sendDenied(response, config);
      return;
    }
    const result = advanceDemoCycle(database, {
      groupId,
      actingMemberId: memberId,
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
    const scope = sessionScope(database, url, now());
    const memberId = scope.memberId;
    const group =
      (scope.groupId ? getGroup(database, scope.groupId, memberId ?? undefined) : null) ??
      groupForMember(database, memberId);
    if (!group) {
      sendDenied(response, config);
      return;
    }
    if (!authorize(database, response, config, group.id, memberId, 'group')) return;
    sendJson(response, config, 200, {
      group: getGroup(database, group.id, memberId ?? undefined) ?? group,
    });
    return;
  }

  const groupMatch = url.pathname.match(/^\/groups\/([^/]+)$/);
  if (groupMatch) {
    const groupId = decodePathSegment(groupMatch[1], response, config);
    if (groupId === null) return;
    const memberId = sessionMember(database, url, now());
    if (!authorize(database, response, config, groupId, memberId, 'group')) return;
    const group = getGroup(database, groupId, memberId ?? undefined);
    if (!group) return sendNotFound(response, config);
    sendJson(response, config, 200, { group });
    return;
  }

  if (url.pathname === '/cycles/current') {
    const groupId = url.searchParams.get('groupId');
    if (!groupId) {
      sendDenied(response, config);
      return;
    }
    if (
      !authorize(database, response, config, groupId, sessionMember(database, url, now()), 'group')
    )
      return;
    const cycle = getCurrentCycle(
      database,
      groupId,
      sessionMember(database, url, now()) ?? undefined,
      now(),
    );
    if (!cycle) return sendNotFound(response, config);
    sendJson(response, config, 200, { cycle });
    return;
  }

  const messageMatch = url.pathname.match(/^\/messages\/([^/]+)$/);
  if (messageMatch) {
    const messageId = decodePathSegment(messageMatch[1], response, config);
    if (messageId === null) return;
    const groupId = url.searchParams.get('groupId');
    if (!groupId) {
      sendDenied(response, config);
      return;
    }
    if (
      !authorize(
        database,
        response,
        config,
        groupId,
        sessionMember(database, url, now()),
        'message',
      )
    )
      return;
    const message = getMessage(database, groupId, messageId);
    if (!message) return sendNotFound(response, config);
    sendJson(response, config, 200, { message });
    return;
  }

  const contributionMatch = url.pathname.match(/^\/contributions\/([^/]+)$/);
  if (contributionMatch) {
    const contributionId = decodePathSegment(contributionMatch[1], response, config);
    if (contributionId === null) return;
    const groupId = url.searchParams.get('groupId');
    if (!groupId) {
      sendDenied(response, config);
      return;
    }
    if (
      !authorize(
        database,
        response,
        config,
        groupId,
        sessionMember(database, url, now()),
        'contribution',
      )
    )
      return;
    if (request.method === 'DELETE') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) return sendSessionRequired(response, config);
      const session = validateDemoSession(database, sessionId, now());
      if (session.status !== 'valid') return sendSessionRequired(response, config);
      const result = deleteContribution(
        database,
        groupId,
        session.session.actor.memberId,
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
    const contribution = getContribution(database, groupId, contributionId);
    if (!contribution) return sendNotFound(response, config);
    sendJson(response, config, 200, { contribution });
    return;
  }

  const premiereMatch = url.pathname.match(/^\/cycles\/([^/]+)\/premiere$/);
  if (premiereMatch && request.method === 'GET') {
    const cycleId = decodePathSegment(premiereMatch[1], response, config);
    if (cycleId === null) return;
    const groupId = url.searchParams.get('groupId');
    if (!groupId) return sendDenied(response, config);
    const session = requireSessionMember(database, url, response, config, now());
    if (!session) return;
    if (session.groupId !== groupId) return sendDenied(response, config);
    if (!authorize(database, response, config, groupId, session.memberId, 'film')) return;
    const film = getPremiereFilm(database, groupId, cycleId);
    if (!film) return sendNotFound(response, config);
    const state = premiereState(film);
    const sessionId = url.searchParams.get('sessionId');
    sendJson(response, config, 200, {
      premiere:
        state === 'ready'
          ? {
              state,
              cycleId,
              filmId: film.filmId,
              playbackPath: `/films/${encodeURIComponent(film.filmId!)}/play?groupId=${encodeURIComponent(groupId)}&sessionId=${encodeURIComponent(sessionId!)}`,
            }
          : { state, cycleId },
    });
    return;
  }

  const playbackMatch = url.pathname.match(/^\/films\/([^/]+)\/play$/);
  if (playbackMatch && request.method === 'GET') {
    const filmId = decodePathSegment(playbackMatch[1], response, config);
    if (filmId === null) return;
    const groupId = url.searchParams.get('groupId');
    if (!groupId) return sendDenied(response, config);
    const session = requireSessionMember(database, url, response, config, now());
    if (!session) return;
    if (session.groupId !== groupId) return sendDenied(response, config);
    if (!authorize(database, response, config, groupId, session.memberId, 'film')) return;
    const film = database
      .prepare(
        `SELECT cycle_id AS cycleId FROM media_jobs
         WHERE id = ? AND group_id = ? AND kind = 'film'`,
      )
      .get(filmId, groupId) as { cycleId?: string } | undefined;
    if (!film?.cycleId) return sendNotFound(response, config);
    const premiere = getPremiereFilm(database, groupId, film.cycleId);
    if (
      !premiere ||
      premiere.filmId !== filmId ||
      premiereState(premiere) !== 'ready' ||
      !premiere.outputPath
    ) {
      return sendNotFound(response, config);
    }
    const path = await resolveOwnedProcessedPath(premiere.outputPath, config.dataDir);
    if (!path) return sendNotFound(response, config);
    const details = await stat(path).catch(() => null);
    if (!details || !details.isFile() || details.size <= 0) return sendNotFound(response, config);
    streamMp4(request, response, config, path, details.size);
    return;
  }

  if (url.pathname === '/archive' && request.method === 'GET') {
    const groupId = url.searchParams.get('groupId');
    if (!groupId) return sendDenied(response, config);
    const session = requireSessionMember(database, url, response, config, now());
    if (!session) return;
    if (session.groupId !== groupId) return sendDenied(response, config);
    if (!authorize(database, response, config, groupId, session.memberId, 'download')) return;
    const sessionId = url.searchParams.get('sessionId');
    const archive = listReleasedArchive(database, groupId, session.memberId);
    sendJson(response, config, 200, {
      archive: {
        films: archive.films.map((film) => ({
          ...film,
          downloadPath: `/films/${encodeURIComponent(film.id)}/download?groupId=${encodeURIComponent(groupId)}&sessionId=${encodeURIComponent(sessionId!)}`,
        })),
        clips: archive.clips.map((clip) => ({
          ...clip,
          downloadPath: `/clips/${encodeURIComponent(clip.id)}/download?groupId=${encodeURIComponent(groupId)}&sessionId=${encodeURIComponent(sessionId!)}`,
        })),
      },
    });
    return;
  }

  const filmDownloadMatch = url.pathname.match(/^\/films\/([^/]+)\/download$/);
  const clipDownloadMatch = url.pathname.match(/^\/clips\/([^/]+)\/download$/);
  if ((filmDownloadMatch || clipDownloadMatch) && request.method === 'GET') {
    const resourceId = decodePathSegment(
      (filmDownloadMatch ?? clipDownloadMatch)![1],
      response,
      config,
    );
    if (resourceId === null) return;
    const groupId = url.searchParams.get('groupId');
    if (!groupId) return sendDenied(response, config);
    const session = requireSessionMember(database, url, response, config, now());
    if (!session) return;
    if (session.groupId !== groupId) return sendDenied(response, config);
    if (!authorize(database, response, config, groupId, session.memberId, 'download')) return;
    const media = filmDownloadMatch
      ? getReleasedFilmDownload(database, groupId, resourceId)
      : getReleasedOwnClipDownload(database, groupId, session.memberId, resourceId);
    if (!media) return sendNotFound(response, config);
    const path = await resolveOwnedProcessedPath(media.outputPath, config.dataDir);
    if (!path) return sendNotFound(response, config);
    const details = await stat(path).catch(() => null);
    if (!details || !details.isFile() || details.size <= 0) return sendNotFound(response, config);
    streamMp4(
      request,
      response,
      config,
      path,
      details.size,
      filmDownloadMatch ? 'rewind-group-film.mp4' : 'rewind-my-clip.mp4',
    );
    return;
  }

  for (const resource of ['clip', 'film', 'download'] as const) {
    const match = url.pathname.match(new RegExp(`^\\/${resource}s\\/([^/]+)$`));
    if (match) {
      const resourceId = decodePathSegment(match[1], response, config);
      if (resourceId === null) return;
      const groupId = url.searchParams.get('groupId');
      if (!groupId) {
        sendDenied(response, config);
        return;
      }
      if (
        !authorize(
          database,
          response,
          config,
          groupId,
          sessionMember(database, url, now()),
          resource,
        )
      )
        return;
      const job = getMediaJob(database, groupId, resourceId, resource);
      if (!job) return sendNotFound(response, config);
      sendJson(response, config, 200, { [resource]: job });
      return;
    }
  }

  sendNotFound(response, config);
}

export function createRuntimeServer(
  config: RuntimeConfig,
  database: RewindDatabase,
  options: RuntimeServerOptions = {},
): Server {
  const realtimeHub = options.realtimeHub ?? new RealtimeHub();
  return createServer((request, response) => {
    void handleRequest(request, response, config, database, { ...options, realtimeHub }).catch(
      (error: unknown) => {
        if (!response.headersSent) {
          sendJson(response, config, 500, {
            error: 'internal_error',
            message: 'The local runtime could not complete the request.',
          });
        } else {
          response.destroy();
        }
        console.error('[rewind-local-runtime]', error);
      },
    );
  });
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { URL } from 'node:url';

import { SERVICE_VERSION, type RuntimeConfig } from './config';
import {
  getContribution,
  getCurrentCycle,
  getGroup,
  getMediaJob,
  getMessage,
  listProfiles,
  restoreFixture,
  type RewindDatabase,
} from './db';
import { advanceDemoCycle } from './cycles';
import { authorizeMember, SAFE_DENIAL, type ProtectedResource } from './policy';
import {
  createDemoSession,
  invalidateDemoSession,
  updateDemoSessionGroup,
  validateDemoSession,
} from './session';
import { createGroup } from './groups';
import { acceptInvite, createInvite } from './invites';
import { cancelClipUpload, createClipUpload, type ClipUploadInput } from './media';

export interface HealthPayload {
  ok: true;
  service: 'rewind-local-runtime';
  version: string;
  ready: true;
  checks: { sqlite: true; ffmpegConfigured: boolean };
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
    'Access-Control-Allow-Headers': 'Content-Type',
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

export interface RuntimeServerOptions {
  now?: () => Date;
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

function healthPayload(config: RuntimeConfig): HealthPayload {
  const localHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const lan = getLanAddress();
  return {
    ok: true,
    service: 'rewind-local-runtime',
    version: SERVICE_VERSION,
    ready: true,
    checks: { sqlite: true, ffmpegConfigured: Boolean(config.ffmpegBin) },
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
      'Access-Control-Allow-Headers': 'Content-Type',
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
    sendJson(response, config, 200, healthPayload(config));
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
    if (!sessionId || validateDemoSession(database, sessionId, now()).status !== 'valid') {
      sendJson(response, config, 401, {
        error: 'session_required',
        message: 'Choose Demo access before resetting local Demo data.',
      });
      return;
    }
    restoreFixture(database);
    sendJson(response, config, 200, { reset: true });
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
    };
    const result = createClipUpload(
      database,
      groupId,
      session.session.actor.memberId,
      input,
      now(),
    );
    if (!result.ok) {
      if (result.reason === 'not_found') return sendNotFound(response, config);
      sendJson(response, config, result.reason === 'quota_exceeded' ? 409 : 400, {
        error: `upload_${result.reason}`,
        message:
          result.reason === 'quota_exceeded'
            ? 'This cycle has no remaining contribution allowance.'
            : result.reason === 'invalid_key'
              ? 'Provide a retryable upload key.'
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
    const result = cancelClipUpload(database, groupId, session.session.actor.memberId, jobId);
    if (!result.ok) return sendNotFound(response, config);
    sendJson(response, config, 200, { cancelled: true, ...result });
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
    const cycle = getCurrentCycle(database, groupId);
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
    const contribution = getContribution(database, groupId, contributionId);
    if (!contribution) return sendNotFound(response, config);
    sendJson(response, config, 200, { contribution });
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
  return createServer((request, response) => {
    void handleRequest(request, response, config, database, options).catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, config, 500, {
          error: 'internal_error',
          message: 'The local runtime could not complete the request.',
        });
      } else {
        response.destroy();
      }
      console.error('[rewind-local-runtime]', error);
    });
  });
}

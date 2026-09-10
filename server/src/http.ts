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

function actingMember(url: URL): string | null {
  return url.searchParams.get('memberId');
}

function sessionMember(database: RewindDatabase, url: URL): string | null {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return actingMember(url);
  const result = validateDemoSession(database, sessionId);
  return result.status === 'valid' ? result.session.actor.memberId : null;
}

function sessionScope(database: RewindDatabase, url: URL) {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return { memberId: actingMember(url), groupId: null };
  const result = validateDemoSession(database, sessionId);
  return result.status === 'valid'
    ? { memberId: result.session.actor.memberId, groupId: result.session.groupId }
    : { memberId: null, groupId: null };
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
): Promise<void> {
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
    const sessionId = decodeURIComponent(sessionMatch[1]);
    if (request.method === 'GET') {
      const result = validateDemoSession(database, sessionId);
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
      const result = invalidateDemoSession(database, sessionId);
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
    if (!sessionId || validateDemoSession(database, sessionId).status !== 'valid') {
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
    const session = validateDemoSession(database, sessionId);
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

  if (url.pathname === '/profiles') {
    sendJson(response, config, 200, { profiles: listProfiles(database) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/cycles/demo/advance') {
    const groupId = url.searchParams.get('groupId');
    const sessionId = url.searchParams.get('sessionId');
    const memberId = sessionId ? sessionMember(database, url) : actingMember(url);
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
    const scope = sessionScope(database, url);
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
    const groupId = decodeURIComponent(groupMatch[1]);
    const memberId = sessionMember(database, url);
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
    if (!authorize(database, response, config, groupId, sessionMember(database, url), 'group'))
      return;
    const cycle = getCurrentCycle(database, groupId);
    if (!cycle) return sendNotFound(response, config);
    sendJson(response, config, 200, { cycle });
    return;
  }

  const messageMatch = url.pathname.match(/^\/messages\/([^/]+)$/);
  if (messageMatch) {
    const groupId = url.searchParams.get('groupId');
    if (!groupId) {
      sendDenied(response, config);
      return;
    }
    if (!authorize(database, response, config, groupId, sessionMember(database, url), 'message'))
      return;
    const message = getMessage(database, groupId, decodeURIComponent(messageMatch[1]));
    if (!message) return sendNotFound(response, config);
    sendJson(response, config, 200, { message });
    return;
  }

  const contributionMatch = url.pathname.match(/^\/contributions\/([^/]+)$/);
  if (contributionMatch) {
    const groupId = url.searchParams.get('groupId');
    if (!groupId) {
      sendDenied(response, config);
      return;
    }
    if (
      !authorize(database, response, config, groupId, sessionMember(database, url), 'contribution')
    )
      return;
    const contribution = getContribution(
      database,
      groupId,
      decodeURIComponent(contributionMatch[1]),
    );
    if (!contribution) return sendNotFound(response, config);
    sendJson(response, config, 200, { contribution });
    return;
  }

  for (const resource of ['clip', 'film', 'download'] as const) {
    const match = url.pathname.match(new RegExp(`^\\/${resource}s\\/([^/]+)$`));
    if (match) {
      const groupId = url.searchParams.get('groupId');
      if (!groupId) {
        sendDenied(response, config);
        return;
      }
      if (!authorize(database, response, config, groupId, sessionMember(database, url), resource))
        return;
      const job = getMediaJob(database, groupId, decodeURIComponent(match[1]), resource);
      if (!job) return sendNotFound(response, config);
      sendJson(response, config, 200, { [resource]: job });
      return;
    }
  }

  sendNotFound(response, config);
}

export function createRuntimeServer(config: RuntimeConfig, database: RewindDatabase): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, config, database).catch((error: unknown) => {
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

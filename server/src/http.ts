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
  type RewindDatabase,
} from './db';
import { authorizeMember, SAFE_DENIAL, type ProtectedResource } from './policy';

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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

function actingMember(url: URL): string | null {
  return url.searchParams.get('memberId');
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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Origin': config.allowOrigin,
    });
    response.end();
    return;
  }
  if (request.method !== 'GET') {
    sendJson(response, config, 405, {
      error: 'method_not_allowed',
      message: 'Only GET is supported.',
    });
    return;
  }

  if (url.pathname === '/health' || url.pathname === '/version') {
    sendJson(response, config, 200, healthPayload(config));
    return;
  }
  if (url.pathname === '/profiles') {
    sendJson(response, config, 200, { profiles: listProfiles(database) });
    return;
  }
  if (url.pathname === '/groups/current') {
    const group = groupForMember(database, actingMember(url));
    if (!group) {
      sendDenied(response, config);
      return;
    }
    if (!authorize(database, response, config, group.id, actingMember(url), 'group')) return;
    sendJson(response, config, 200, { group });
    return;
  }

  const groupMatch = url.pathname.match(/^\/groups\/([^/]+)$/);
  if (groupMatch) {
    const groupId = decodeURIComponent(groupMatch[1]);
    if (!authorize(database, response, config, groupId, actingMember(url), 'group')) return;
    const group = getGroup(database, groupId);
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
    if (!authorize(database, response, config, groupId, actingMember(url), 'group')) return;
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
    if (!authorize(database, response, config, groupId, actingMember(url), 'message')) return;
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
    if (!authorize(database, response, config, groupId, actingMember(url), 'contribution')) return;
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
      if (!authorize(database, response, config, groupId, actingMember(url), resource)) return;
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

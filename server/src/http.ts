import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { URL } from 'node:url';

import { MediaCapabilities } from './archive/capabilities';
import { SERVICE_VERSION, type RuntimeConfig } from './config';
import { isPostgres, schemaReadiness, type RewindDatabase } from './db';
import { requestObservation } from './observability';
import {
  newDatabaseTiming,
  serverTimingHeader,
  withDatabaseTiming,
} from './observability/database-timing';
import { RealtimeHub } from './realtime';
import { archiveRoutes, mediaAccessRoutes } from './routes/archive-routes';
import { handleRealAuthRequest } from './routes/auth-routes';
import { RequestPolicyError, finishRejectedRequest, sendRequestPolicyError } from './routes/body';
import { chatRoutes } from './routes/chat-routes';
import {
  findRoute,
  type MediaRouteContext,
  type Route,
  type RuntimeServerOptions,
} from './routes/context';
import { contributionRoutes } from './routes/contribution-routes';
import { createRequestLimiters } from './routes/limits';
import { handleRealGroupRequest } from './routes/real-routes';
import { authCorsHeaders, authJson, sendJson, sendNotFound } from './routes/respond';

// Route handlers live in ./routes: one table per family, matched in order.
export { authClientSource, authTransportIsSecure } from './routes/respond';
export type { RuntimeServerOptions } from './routes/context';

export interface HealthPayload {
  ok: boolean;
  service: 'rewind-local-runtime';
  version: string;
  ready: boolean;
  checks: {
    database: 'sqlite' | 'postgresql';
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

function healthPayload(config: RuntimeConfig, database: RewindDatabase): HealthPayload {
  const localHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const lan = getLanAddress();
  const schema = schemaReadiness(database);
  return {
    ok: schema.ready,
    service: 'rewind-local-runtime',
    version: SERVICE_VERSION,
    ready: schema.ready,
    checks: {
      database: isPostgres(database) ? 'postgresql' : 'sqlite',
      ffmpegConfigured: Boolean(config.ffmpegBin),
      schema,
    },
    addresses: {
      local: `http://${localHost}:${config.port}`,
      lan: lan ? `http://${lan}:${config.port}` : null,
    },
  };
}

function handleHealth(ctx: MediaRouteContext): void {
  const { response, config, database } = ctx;
  const health = healthPayload(config, database);
  sendJson(response, config, health.ready ? 200 : 503, health);
}

const routes: readonly Route<MediaRouteContext>[] = [
  ...mediaAccessRoutes,
  { methods: '*', path: /^\/(?:health|version)$/, handle: handleHealth },
  ...chatRoutes,
  ...contributionRoutes,
  ...archiveRoutes,
];

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
      /^\/(?:archive$|media\/access\/|cycles\/[^/]+\/premiere$|clips\/|contributions\/)/.test(
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
  const mediaHead = request.method === 'HEAD' && url.pathname.startsWith('/media/access/');
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
  if (url.pathname.startsWith('/auth/')) {
    await handleRealAuthRequest(
      request,
      response,
      config,
      database,
      requestLimiters.registration,
      requestLimiters.cognitoStates,
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
  const ctx: MediaRouteContext = {
    request,
    response,
    config,
    database,
    options,
    now,
    requestLimiters,
    url,
  };
  const found = findRoute(routes, request.method, url.pathname);
  if (found) return found.route.handle(ctx, found.match);
  sendNotFound(response, config);
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
    // Database work for this request (PostgreSQL), as Server-Timing.
    const timing = newDatabaseTiming();
    const writeHead = response.writeHead.bind(response) as (...args: unknown[]) => ServerResponse;
    (response as { writeHead: (...args: unknown[]) => ServerResponse }).writeHead = (
      ...args: unknown[]
    ) => {
      if (timing.statements > 0 && !response.headersSent)
        response.setHeader('Server-Timing', serverTimingHeader(timing));
      return writeHead(...args);
    };
    response.once('finish', () => {
      if (response.statusCode >= 500) observation.failure(response.statusCode);
      if (config.requestTiming)
        observation.timing(request.method, request.url, response.statusCode, timing);
    });
    const handled = withDatabaseTiming(timing, () =>
      handleRequest(request, response, config, database, {
        ...options,
        realtimeHub,
        mediaCapabilities,
        requestLimiters,
      }),
    );
    void handled.catch((error: unknown) => {
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

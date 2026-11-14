// JSON responses, path decoding and the auth transport/CORS checks.
import { timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { URL } from 'node:url';

import { REAL_SESSION_COOKIE } from '../auth';
import { type RuntimeConfig } from '../config';
import { SAFE_DENIAL } from '../policy';

export function sendJson(
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

export function sendNotFound(response: ServerResponse, config: RuntimeConfig): void {
  sendJson(response, config, 404, {
    error: 'not_found',
    message: 'The requested resource was not found.',
  });
}

export function sendDenied(response: ServerResponse, config: RuntimeConfig): void {
  sendJson(response, config, SAFE_DENIAL.status, SAFE_DENIAL);
}

export function decodePathSegment(
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

export function sendSessionRequired(response: ServerResponse, config: RuntimeConfig): void {
  sendJson(response, config, 401, {
    error: 'session_required',
    message: 'A valid sign-in is required.',
  });
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

export function authCorsHeaders(
  request: IncomingMessage,
  config: RuntimeConfig,
): Record<string, string> {
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

export function authOriginIsAllowed(request: IncomingMessage, config: RuntimeConfig): boolean {
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

export function authJson(
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

export function authToken(request: IncomingMessage): string | null {
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

/** The browser-visible origin; the transport check already vouched for it. */
export function publicOrigin(request: IncomingMessage, config: RuntimeConfig): string {
  const host = request.headers.host ?? 'localhost';
  const https =
    (request.socket as typeof request.socket & { encrypted?: boolean }).encrypted ||
    authenticatedProxyHttps(request, config);
  return `${https ? 'https' : 'http'}://${host}`;
}

export function redirectWithCookies(
  response: ServerResponse,
  location: string,
  cookies: string[],
): void {
  response.writeHead(302, {
    'Cache-Control': 'no-store',
    Location: location,
    'Set-Cookie': cookies,
  });
  response.end();
}

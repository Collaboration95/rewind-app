import { Buffer } from 'node:buffer';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer as createHttpServer, request as requestUpstream } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const STATIC_ASSET_PATTERN = /\.(?:css|gif|ico|jpe?g|js|map|png|svg|webp|woff2?)$/i;

function setCommonHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJson(response, status, body) {
  const encoded = JSON.stringify(body);
  setCommonHeaders(response);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

function isInside(root, candidate) {
  const remainder = relative(root, candidate);
  return (
    remainder === '' || (remainder && !remainder.startsWith('..') && !remainder.startsWith('/'))
  );
}

function contentType(path) {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Public legal pages answer at their extensionless path without sign-in,
 * instead of falling through to the SPA shell. */
export function legalPagePath(pathname) {
  const match = /^\/(privacy|support|terms)$/.exec(pathname);
  return match ? `/${match[1]}.html` : null;
}

async function resolveStaticFile(staticRoot, pathname) {
  let decodedPath;
  try {
    decodedPath = legalPagePath(pathname) ?? decodeURIComponent(pathname);
  } catch {
    return { error: 400 };
  }
  const candidate = resolve(staticRoot, `.${decodedPath}`);
  if (!isInside(staticRoot, candidate)) return { error: 404 };
  try {
    const details = await stat(candidate);
    if (details.isFile()) return { path: candidate };
  } catch {
    // A missing static path may still be a client-side route.
  }
  if (extname(decodedPath)) return { error: 404 };
  const fallback = resolve(staticRoot, 'index.html');
  try {
    const details = await stat(fallback);
    if (details.isFile()) return { path: fallback };
  } catch {
    return { error: 500 };
  }
  return { error: 500 };
}

async function serveStatic(request, response, staticRoot, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, {
      error: 'method_not_allowed',
      message: 'The web artifact only accepts GET and HEAD requests.',
    });
    return;
  }
  const resolved = await resolveStaticFile(staticRoot, url.pathname);
  if ('error' in resolved) {
    if (resolved.error === 400) {
      sendJson(response, 400, { error: 'invalid_path', message: 'The request path is malformed.' });
    } else if (resolved.error === 404) {
      sendJson(response, 404, {
        error: 'not_found',
        message: 'The requested asset was not found.',
      });
    } else {
      sendJson(response, 500, {
        error: 'web_artifact_unavailable',
        message: 'The web artifact is unavailable.',
      });
    }
    return;
  }

  const isShell = resolved.path === resolve(staticRoot, 'index.html');
  const cacheControl = isShell
    ? 'no-store'
    : STATIC_ASSET_PATTERN.test(resolved.path)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
  const details = await stat(resolved.path);
  setCommonHeaders(response);
  response.writeHead(200, {
    'Cache-Control': cacheControl,
    'Content-Length': details.size,
    'Content-Type': contentType(resolved.path),
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(resolved.path)
    .on('error', () => response.destroy())
    .pipe(response);
}

export function apiTarget(runtimeOrigin, url) {
  const runtimePath = url.pathname === '/api' ? '/' : url.pathname.slice('/api'.length);
  // Set the path on the trusted runtime URL instead of resolving user-controlled
  // path text as a URL reference. A path beginning with `//` would otherwise
  // replace the runtime authority and turn this same-origin proxy into an SSRF.
  const target = new URL(runtimeOrigin);
  target.pathname = runtimePath;
  target.search = url.search;
  return target;
}

export function runtimeProxyHeaders(inboundHeaders, originAuthSecret) {
  const headers = { ...inboundHeaders };
  if (originAuthSecret) {
    headers['x-forwarded-proto'] = 'https';
    headers['x-rewind-origin-auth'] = originAuthSecret;
  }
  return headers;
}

function proxyApi(request, response, runtimeOrigin, url, runtimeTimeoutMs, originAuthSecret) {
  const target = apiTarget(runtimeOrigin, url);
  const headers = {
    ...runtimeProxyHeaders(request.headers, originAuthSecret),
    host: target.host,
  };
  const upstream = requestUpstream(
    target,
    { method: request.method, headers },
    (upstreamResponse) => {
      setCommonHeaders(response);
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value !== undefined && name !== 'connection' && name !== 'keep-alive') {
          response.setHeader(name, value);
        }
      }
      response.setHeader('Cache-Control', 'no-store');
      response.writeHead(upstreamResponse.statusCode ?? 502);
      upstreamResponse.pipe(response);
    },
  );
  upstream.once('error', () => {
    if (!response.headersSent) {
      sendJson(response, 503, {
        error: 'runtime_unavailable',
        message: 'The Demo runtime is unavailable.',
      });
    } else {
      response.destroy();
    }
  });
  upstream.setTimeout(runtimeTimeoutMs, () => {
    upstream.destroy(new Error('runtime upstream timeout'));
  });
  request.pipe(upstream);
}

export function createProductionWebServer({
  staticDir,
  runtimeOrigin,
  runtimeTimeoutMs = 5_000,
  tls,
  originAuthSecret,
}) {
  const staticRoot = resolve(staticDir);
  const runtimeUrl = new URL(runtimeOrigin);
  if (!['http:', 'https:'].includes(runtimeUrl.protocol)) {
    throw new Error('runtimeOrigin must use http:// or https://.');
  }
  if (originAuthSecret && !tls) {
    throw new Error('originAuthSecret requires a TLS web boundary.');
  }
  const handleRequest = (request, response) => {
    const url = new URL(request.url ?? '/', 'http://rewind-web.local');
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      proxyApi(request, response, runtimeUrl, url, runtimeTimeoutMs, originAuthSecret);
      return;
    }
    void serveStatic(request, response, staticRoot, url).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: 'web_artifact_unavailable',
          message: 'The web artifact is unavailable.',
        });
      } else {
        response.destroy();
      }
    });
  };
  return tls ? createHttpsServer(tls, handleRequest) : createHttpServer(handleRequest);
}

export async function assertStaticArtifact(staticDir) {
  const indexPath = resolve(staticDir, 'index.html');
  await access(indexPath);
  return indexPath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  throw new Error('Use scripts/web-smoke-server.mjs to start the local production web boundary.');
}

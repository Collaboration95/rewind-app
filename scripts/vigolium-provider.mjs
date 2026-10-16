import { accessContext } from './vigolium-access.mjs';
import { createServer, request as forward } from 'node:http';
import { once } from 'node:events';
import { Buffer } from 'node:buffer';

export function providerSettings(env, live = false) {
  const provider = env.REWIND_AGENT_PROVIDER || 'openai-responses';
  const keys = {
    'openai-responses': 'OPENAI_API_KEY',
    'openai-api-key': 'OPENAI_API_KEY',
    'anthropic-api-key': 'ANTHROPIC_API_KEY',
  };
  if (!Object.hasOwn(keys, provider)) throw new Error('Unsupported external provider');
  if (live && env.REWIND_AGENT_DATA_SHARING !== 'approved') {
    throw new Error('Live scanning requires REWIND_AGENT_DATA_SHARING=approved');
  }
  if (live && (!env.REWIND_AGENT_MODEL || !env[keys[provider]])) {
    throw new Error(`Live scanning requires REWIND_AGENT_MODEL and ${keys[provider]}`);
  }
  return {
    provider,
    model: env.REWIND_AGENT_MODEL || 'configure-before-live-run',
    keyName: keys[provider],
  };
}

export function redact(text, secrets) {
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('[REDACTED]');
  }
  return text;
}

export function disposableTarget(value) {
  if (!value || value.disposable !== true || typeof value.origin !== 'string')
    throw new Error('Only a disposable Rewind target is supported');
  const url = new URL(value.origin);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Target must be a loopback HTTP origin with an explicit port');
  if (
    !(
      value.path === '/real/groups' ||
      /^\/realtime\/groups\/[a-zA-Z0-9-]+\/messages$/.test(value.path)
    ) ||
    typeof value.token !== 'string' ||
    !value.token ||
    /[\r\n]/.test(value.token)
  )
    throw new Error('Target must contain one supported endpoint and a temporary token');
  const requestBody = value.requestBody || { body: 'Disposable agentic trial message' };
  if (
    value.path === '/real/groups' &&
    (typeof requestBody.name !== 'string' ||
      typeof requestBody.prompt !== 'string' ||
      requestBody.maxMembers !== 4)
  )
    throw new Error('Group target requires a synthetic group creation seed');
  if (JSON.stringify(requestBody).length > 4096) throw new Error('Seed body exceeds its limit');
  return {
    origin: url.origin,
    path: value.path,
    token: value.token,
    requestBody,
    access: accessContext(value.access, value.path),
  };
}

export function summarizeFindings(jsonl) {
  const findings = jsonl
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.type === 'finding')
    .map(({ data }) => ({
      module: data.module_id,
      title: data.module_name,
      severity: data.severity,
      confidence: data.confidence,
      status: data.status,
      tags: data.tags || [],
      explanation: data.description,
    }));
  return {
    findingCount: findings.length,
    vulnerabilityCount: findings.filter((finding) => finding.severity !== 'info').length,
    informationalCount: findings.filter((finding) => finding.severity === 'info').length,
    sqlInjectionReported: findings.some(
      (finding) =>
        (finding.module?.startsWith('sqli-') || finding.tags.includes('sqli')) &&
        finding.severity !== 'info',
    ),
    findings,
  };
}

export function summaryHtml(report) {
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  return `<!doctype html><meta name="viewport" content="width=device-width"><title>Agentic trial</title><h1>Agentic trial: ${escape(report.status)}</h1><p>${escape(report.message)}</p><pre>${escape(JSON.stringify(report, null, 2))}</pre>`;
}

// This limits traffic through the seed target. It is not an OS sandbox for agent tools.
export async function scopedProxy(origin, path, { limit = 120, interval = 550, observe } = {}) {
  const paths = Array.isArray(path) ? path : [path];
  const backend = new URL(origin);
  if (
    backend.protocol !== 'http:' ||
    backend.hostname !== '127.0.0.1' ||
    !backend.port ||
    backend.pathname !== '/' ||
    backend.username ||
    backend.password ||
    backend.search ||
    backend.hash
  )
    throw new Error('Proxy backend must be a loopback HTTP origin');
  // Request data selects a precomputed entry; it never constructs the forwarding URL.
  const destinations = paths.map((allowedPath) => {
    if (
      !/^\/[a-zA-Z0-9/-]+$/.test(allowedPath) ||
      allowedPath.startsWith('//') ||
      allowedPath.includes('..')
    )
      throw new Error('Invalid proxy route');
    return { path: allowedPath, url: new URL(allowedPath, backend) };
  });
  const evidence = { forwarded: 0, denied: 0, statuses: {}, timestamps: [] };
  const timers = new Set();
  let scheduled = 0;
  let next = 0;
  let proxyOrigin;
  const server = createServer(async (request, response) => {
    // The JS SDK sends absolute-form request targets. Admit only this proxy's
    // exact origin/path; never turn an arbitrary absolute URL into an upstream.
    let requestedPath = request.url;
    let inScope = paths.includes(requestedPath);
    if (!inScope && request.url?.startsWith(`${proxyOrigin}/`)) {
      try {
        const requested = new URL(request.url);
        inScope =
          requested.origin === proxyOrigin &&
          paths.includes(requested.pathname + requested.search) &&
          !requested.hash &&
          !requested.username &&
          !requested.password;
        if (inScope) requestedPath = requested.pathname;
      } catch {
        /* Invalid request targets remain outside scope. */
      }
    }
    const destination = destinations.find((entry) => entry.path === requestedPath);
    if (!inScope || !destination || !['GET', 'POST'].includes(request.method)) {
      evidence.denied++;
      response.writeHead(403).end();
      return;
    }
    if (scheduled >= limit) {
      evidence.denied++;
      response.writeHead(429).end();
      return;
    }
    scheduled++;
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65536) {
          evidence.denied++;
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
    } catch {
      return;
    }
    const delay = Math.max(0, next - Date.now());
    next = Math.max(Date.now(), next) + interval;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (response.destroyed) return;
      evidence.forwarded++;
      evidence.timestamps.push(Date.now());
      const upstream = forward(
        destination.url,
        {
          method: request.method,
          headers: {
            'content-type': 'application/json',
            ...(request.headers.authorization
              ? { authorization: request.headers.authorization }
              : {}),
          },
          timeout: 5000,
        },
        (incoming) => {
          evidence.statuses[incoming.statusCode] =
            (evidence.statuses[incoming.statusCode] || 0) + 1;
          response.writeHead(incoming.statusCode, { 'content-type': 'application/json' });
          if (!observe) incoming.pipe(response);
          else {
            const responseChunks = [];
            let responseSize = 0;
            incoming.on('data', (chunk) => {
              responseSize += chunk.length;
              if (responseSize <= 65536) responseChunks.push(chunk);
              response.write(chunk);
            });
            incoming.on('end', () => {
              observe({
                method: request.method,
                path: requestedPath,
                authorization: request.headers.authorization,
                requestBody: Buffer.concat(chunks).toString(),
                status: incoming.statusCode,
                responseBody: responseSize <= 65536 ? Buffer.concat(responseChunks).toString() : '',
              });
              response.end();
            });
          }
        },
      );
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      upstream.end(Buffer.concat(chunks));
    }, delay);
    timers.add(timer);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  proxyOrigin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin: proxyOrigin,
    evidence,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

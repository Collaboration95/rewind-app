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

export function summaryHtml(report) {
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  return `<!doctype html><meta name="viewport" content="width=device-width"><title>Agentic trial</title><h1>Agentic trial: ${escape(report.status)}</h1><p>${escape(report.message)}</p><pre>${escape(JSON.stringify(report, null, 2))}</pre>`;
}

// This limits traffic through the seed target. It is not an OS sandbox for agent tools.
export async function scopedProxy(origin, path, { limit = 120, interval = 550 } = {}) {
  const destination = new URL(path, origin);
  const evidence = { forwarded: 0, denied: 0, statuses: {}, timestamps: [] };
  const timers = new Set();
  let scheduled = 0;
  let next = 0;
  const server = createServer(async (request, response) => {
    if (request.url !== path || !['GET', 'POST'].includes(request.method)) {
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
        destination,
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
          incoming.pipe(response);
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
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    evidence,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

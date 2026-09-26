import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { createProductionWebServer } from '../scripts/production-web-proxy.mjs';

const nginx = await readFile(new URL('../deploy/nginx.conf', import.meta.url), 'utf8');
const compose = await readFile(new URL('../deploy/compose.yaml', import.meta.url), 'utf8');
const dockerfile = await readFile(new URL('../deploy/web.Dockerfile', import.meta.url), 'utf8');

test('production web proxy keeps API and SPA routing boundaries explicit', () => {
  assert.match(nginx, /location \^~ \/api\//);
  assert.match(nginx, /location = \/api/);
  assert.match(nginx, /proxy_pass http:\/\/rewind_runtime\//);
  assert.match(nginx, /proxy_intercept_errors on/);
  assert.match(nginx, /proxy_hide_header Cache-Control/);
  assert.match(nginx, /add_header Cache-Control "no-store" always/);
  assert.match(nginx, /error_page 502 503 504 = @runtime_unavailable/);
  assert.match(nginx, /try_files \$uri =404/);
  assert.match(nginx, /try_files \$uri \$uri\/ \/index\.html/);
  assert.match(nginx, /public, max-age=31536000, immutable/);
});

test('Compose starts the web proxy only after the healthy runtime', () => {
  assert.match(compose, /dockerfile: deploy\/web\.Dockerfile/);
  assert.match(compose, /condition: service_healthy/);
  assert.match(
    compose,
    /\$\{REWIND_WEB_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{REWIND_WEB_PORT:-8080\}:8080/,
  );
  assert.match(compose, /127\.0\.0\.1:\$\{REWIND_RUNTIME_PORT:-8787\}:8787/);
  assert.match(compose, /rewind-demo-web/);
  assert.match(compose, /http:\/\/127\.0\.0\.1:8080\//);
  assert.doesNotMatch(compose, /cap_add:/);
});

test('the web image bakes the same-origin API prefix into the Expo artifact', () => {
  assert.match(dockerfile, /EXPO_PUBLIC_LOCAL_BASE_URL=\/api npm run build:web/);
  assert.match(dockerfile, /COPY deploy\/nginx\.conf \/etc\/nginx\/conf\.d\/default\.conf/);
  assert.match(dockerfile, /COPY --from=build \/app\/dist \/usr\/share\/nginx\/html/);
  assert.match(dockerfile, /USER nginx/);
  assert.match(dockerfile, /EXPOSE 8080/);
  assert.match(dockerfile, /pid \/tmp\/nginx\.pid/);
  assert.match(nginx, /listen 8080;/);
});

test('runtime-unavailable API responses stay JSON and never fall back to the shell', async () => {
  const staticDir = await mkdtemp(join(tmpdir(), 'rewind-web-contract-'));
  const upstream = createServer((request) => request.socket.destroy());
  const upstreamListening = once(upstream, 'listening');
  upstream.listen(0, '127.0.0.1');
  await upstreamListening;
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');
  const web = createProductionWebServer({
    staticDir,
    runtimeOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
    runtimeTimeoutMs: 100,
  });
  const webListening = once(web, 'listening');
  web.listen(0, '127.0.0.1');
  await webListening;
  try {
    await writeFile(join(staticDir, 'index.html'), '<!doctype html><div id="root"></div>');
    const address = web.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.doesNotMatch(body, /index\.html|\/app\//);
  } finally {
    await new Promise((resolve, reject) => {
      web.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(staticDir, { recursive: true, force: true });
  }
});

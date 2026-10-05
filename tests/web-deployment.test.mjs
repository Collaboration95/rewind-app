import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { apiTarget, createProductionWebServer } from '../scripts/production-web-proxy.mjs';

const nginx = await readFile(new URL('../deploy/nginx.conf', import.meta.url), 'utf8');
const compose = await readFile(new URL('../deploy/compose.yaml', import.meta.url), 'utf8');
const dockerfile = await readFile(new URL('../deploy/web.Dockerfile', import.meta.url), 'utf8');
const envExample = await readFile(new URL('../deploy/rewind.env.example', import.meta.url), 'utf8');

test('production web proxy keeps API and SPA routing boundaries explicit', () => {
  assert.match(nginx, /location \^~ \/api\//);
  assert.match(nginx, /location = \/api/);
  assert.match(nginx, /proxy_pass http:\/\/rewind_runtime\//);
  assert.equal(
    (nginx.match(/proxy_set_header X-Rewind-Origin-Auth \$http_x_rewind_origin_auth;/g) ?? [])
      .length,
    2,
  );
  assert.equal((nginx.match(/proxy_set_header X-Forwarded-Proto https;/g) ?? []).length, 2);
  assert.doesNotMatch(nginx, /proxy_set_header X-Forwarded-Proto \$http_x_forwarded_proto;/);
  assert.doesNotMatch(nginx, /return 308 https:/);
  assert.match(nginx, /proxy_intercept_errors on/);
  assert.match(nginx, /proxy_hide_header Cache-Control/);
  assert.match(nginx, /add_header Cache-Control "no-store" always/);
  const apiLocations = [
    ...nginx.matchAll(/location (?:= \/api|\^~ \/api\/) \{([\s\S]*?)\n    \}/g),
  ];
  assert.equal(apiLocations.length, 2);
  for (const [, location] of apiLocations) {
    assert.match(location, /proxy_intercept_errors on;/);
    assert.match(location, /error_page 502 504 = @runtime_unavailable;/);
    assert.doesNotMatch(location, /error_page[^;]*\b503\b/);
  }
  assert.match(
    nginx,
    /location @runtime_unavailable \{[\s\S]*?return 503 '\{"error":"runtime_unavailable","message":"The Demo runtime is unavailable\."\}';/,
  );
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
  assert.match(compose, /REWIND_ALLOW_ORIGIN:/);
  assert.match(compose, /REWIND_ORIGIN_AUTH_SECRET: '\$\{REWIND_ORIGIN_AUTH_SECRET:-\}'/);
  assert.doesNotMatch(compose, /web:[\s\S]*?REWIND_ORIGIN_AUTH_SECRET/);
  assert.doesNotMatch(compose, /REWIND_ALLOW_INSECURE_LOCAL_AUTH/);
  assert.match(compose, /rewind-demo-web/);
  assert.match(compose, /http:\/\/127\.0\.0\.1:8080\//);
  assert.doesNotMatch(compose, /cap_add:/);
});

test('the web image bakes the same-origin API prefix into the Expo artifact', () => {
  assert.match(dockerfile, /COPY scripts\/stamp-pwa-build\.mjs \.\/scripts\/stamp-pwa-build\.mjs/);
  assert.match(dockerfile, /EXPO_PUBLIC_LOCAL_BASE_URL=\/api npm run build:web/);
  assert.match(dockerfile, /COPY deploy\/nginx\.conf \/etc\/nginx\/conf\.d\/default\.conf/);
  assert.match(dockerfile, /COPY --from=build \/app\/dist \/usr\/share\/nginx\/html/);
  assert.match(dockerfile, /USER nginx/);
  assert.match(dockerfile, /EXPOSE 8080/);
  assert.match(dockerfile, /pid \/tmp\/nginx\.pid/);
  assert.match(nginx, /listen 8080;/);
  assert.match(envExample, /Configure this secret only on the runtime host and CloudFront/);
  assert.doesNotMatch(envExample, /^REWIND_ORIGIN_AUTH_SECRET=/m);
  assert.doesNotMatch(envExample, /^REWIND_ALLOW_INSECURE_LOCAL_AUTH=/m);
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

test('public legal pages resolve at extensionless paths without the SPA shell', async () => {
  assert.match(
    nginx,
    /location ~ \^\/\(privacy\|support\|terms\)\$ \{\s*try_files \/\$1\.html =404;/,
  );
  for (const page of ['privacy', 'support', 'terms'])
    await access(new URL(`../public/${page}.html`, import.meta.url));
  const staticDir = await mkdtemp(join(tmpdir(), 'rewind-web-legal-'));
  const web = createProductionWebServer({ staticDir, runtimeOrigin: 'http://127.0.0.1:9' });
  web.listen(0, '127.0.0.1');
  await once(web, 'listening');
  try {
    await writeFile(join(staticDir, 'index.html'), 'shell');
    for (const page of ['privacy', 'support', 'terms'])
      await writeFile(join(staticDir, `${page}.html`), `${page} page`);
    const base = `http://127.0.0.1:${web.address().port}`;
    for (const page of ['privacy', 'support', 'terms']) {
      for (const path of [`/${page}`, `/${page}.html`]) {
        const response = await fetch(base + path);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') ?? '', /text\/html/);
        assert.equal(await response.text(), `${page} page`);
      }
    }
    assert.equal(await (await fetch(`${base}/privacy/extra`)).text(), 'shell');
  } finally {
    await new Promise((resolve) => web.close(resolve));
    await rm(staticDir, { recursive: true, force: true });
  }
});

test('API path references cannot replace the configured runtime authority', () => {
  const runtimeOrigin = new URL('http://runtime.internal');
  const forgedPath = new URL('/api//attacker.example/path?source=test', 'http://rewind-web.local');

  const target = apiTarget(runtimeOrigin, forgedPath);

  assert.equal(target.origin, runtimeOrigin.origin);
  assert.equal(target.pathname, '//attacker.example/path');
  assert.equal(target.search, '?source=test');
});

test('API paths retain same-origin runtime routing and query parameters', () => {
  const runtimeOrigin = new URL('http://runtime.internal');
  const requestUrl = new URL('/api/health?check=ready', 'http://rewind-web.local');

  const target = apiTarget(runtimeOrigin, requestUrl);

  assert.equal(target.origin, runtimeOrigin.origin);
  assert.equal(target.pathname, '/health');
  assert.equal(target.search, '?check=ready');
});

// Opt in with local, pre-existing images; never pull or publish a container.
test(
  'nginx preserves application 503 and sanitizes gateway failures',
  {
    skip: !process.env.REWIND_NGINX_TEST_IMAGE,
  },
  async () => {
    const run = promisify(execFile);
    const docker = async (...args) => (await run('docker', args, { timeout: 30_000 })).stdout;
    const root = await mkdtemp(join(tmpdir(), 'rewind-nginx-503-'));
    const suffix = randomUUID();
    const network = `rewind-503-${suffix}`;
    const runtime = `${network}-runtime`;
    const web = `${network}-web`;
    const body = JSON.stringify({
      error: 'upload_intents_unavailable',
      message: 'Direct transfer is unavailable. Use the existing upload option.',
    });
    const safe = JSON.stringify({
      error: 'runtime_unavailable',
      message: 'The Demo runtime is unavailable.',
    });
    await writeFile(
      join(root, 'default.conf'),
      nginx.replace('server_name _;', 'server_name _;\n    proxy_read_timeout 200ms;'),
    );
    await writeFile(
      join(root, 'upstream.cjs'),
      `
    require('node:http').createServer((req, res) => {
      if (req.url === '/disconnect') return req.socket.destroy();
      if (req.url === '/timeout') return;
      const status = req.url === '/gateway502' ? 502 : req.url === '/gateway504' ? 504 : 503;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'Retry-After': '30' });
      res.end(status === 503 ? ${JSON.stringify(body)} : 'internal gateway details');
    }).listen(8787, '0.0.0.0');
  `,
    );
    try {
      await docker('network', 'create', '--internal', network);
      await docker(
        'run',
        '-d',
        '--pull=never',
        '--name',
        runtime,
        '--network',
        network,
        '--network-alias',
        'runtime',
        '-v',
        `${root}:/fixture:ro`,
        process.env.REWIND_NGINX_UPSTREAM_IMAGE ?? 'node:22.23.3-alpine3.24',
        'node',
        '/fixture/upstream.cjs',
      );
      await docker(
        'exec',
        runtime,
        'node',
        '-e',
        "fetch('http://127.0.0.1:8787').then(r=>{if(r.status!==503)process.exit(1)})",
      );
      await docker(
        'run',
        '-d',
        '--pull=never',
        '--name',
        web,
        '--network',
        network,
        '-v',
        `${join(root, 'default.conf')}:/etc/nginx/conf.d/default.conf:ro`,
        process.env.REWIND_NGINX_TEST_IMAGE,
      );
      await docker('exec', web, 'nginx', '-t');
      const probe = async (path) =>
        JSON.parse(
          await docker(
            'run',
            '--rm',
            '--pull=never',
            '--network',
            network,
            process.env.REWIND_NGINX_UPSTREAM_IMAGE ?? 'node:22.23.3-alpine3.24',
            'node',
            '-e',
            `fetch('http://${web}:8080${path}').then(async r => console.log(JSON.stringify({status:r.status,headers:Object.fromEntries(r.headers),body:await r.text()})))`,
          ),
        );
      for (const path of [
        '/api',
        '/api/real/groups/fixture/upload-intents',
        '/api/gateway502',
        '/api/gateway504',
        '/api/disconnect',
        '/api/timeout',
      ]) {
        const response = await probe(path);
        assert.equal(response.status, 503);
        assert.match(response.headers['content-type'], /application\/json/);
        assert.equal(response.headers['cache-control'], 'no-store');
        if (path === '/api' || path.endsWith('upload-intents')) {
          assert.equal(response.body, body);
          assert.equal(response.headers['retry-after'], '30');
        } else {
          assert.equal(response.body, safe);
          assert.doesNotMatch(response.body, /internal gateway details|<html/);
        }
      }
      await docker('stop', runtime);
      const refused = await probe('/api/health');
      assert.equal(refused.status, 503);
      assert.equal(refused.body, safe);
      assert.equal(refused.headers['cache-control'], 'no-store');
    } finally {
      await docker('rm', '-f', web, runtime).catch(() => {});
      await docker('network', 'rm', network).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);

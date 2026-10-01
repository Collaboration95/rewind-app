import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as forwardRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseConfig } from '../server/dist/config.js';
import { openDatabase } from '../server/dist/db.js';
import { createRuntimeServer } from '../server/dist/http.js';
import { createRealAccount } from '../server/dist/auth/index.js';

const outputDir = resolve('vigolium-result/active');
const dataDir = await mkdtemp(join(tmpdir(), 'rewind-vigolium-active-'));
const cli = resolve('node_modules/@vigolium/vigolium/bin/vigolium.js');
const baseline = JSON.stringify({
  name: 'Active scan fixture',
  prompt: 'Disposable security check',
  maxMembers: 4,
});
const evidence = { requests: 0, changedBodies: 0, statusCounts: {} };
const bodyHashes = new Set();
const pendingForwards = new Set();
let database;
let server;
let proxy;
let token;
const password = randomUUID();

async function run(args) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit' });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 240_000);
  try {
    const [code] = await once(child, 'exit');
    if (timedOut) throw new Error('Active scan exceeded four-minute process deadline');
    if (code !== 0) throw new Error(`Vigolium exited with code ${code}`);
  } finally {
    clearTimeout(timer);
  }
}

try {
  await mkdir(outputDir, { recursive: true });
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
    REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true',
  });
  database = openDatabase(config);
  const account = await createRealAccount(
    database,
    'active-scan-owner',
    'Active scan owner',
    password,
  );
  assert.equal(account.ok, true);
  server = createRuntimeServer(config, database);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'active-scan-owner', password, clientType: 'native' }),
  });
  assert.equal(login.status, 200);
  token = (await login.json()).token;
  assert.equal(typeof token, 'string');
  const valid = await fetch(`${origin}/real/groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: baseline,
  });
  assert.equal(valid.status, 201, 'Group creation baseline must work before scanning');
  const created = await valid.json();
  const chatPath = `/realtime/groups/${created.group.id}/messages`;
  const chatBaseline = JSON.stringify({ body: 'Disposable active scan message' });
  const chat = await fetch(`${origin}${chatPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: chatBaseline,
  });
  assert.equal(chat.status, 201, 'Chat baseline must work before scanning');
  await chat.json();
  const baselines = new Map([
    [chatPath, chatBaseline],
    ['/real/groups', baseline],
  ]);
  const endpointEvidence = Object.fromEntries(
    [...baselines.keys()].map((path) => [
      path,
      { requests: 0, changedBodies: 0, statusCounts: {} },
    ]),
  );
  // Enforce pacing independently of scan-request's module internals.
  let nextForwardAt = 0;
  const forwardedAt = [];
  proxy = createServer((request, response) => {
    if (request.method !== 'POST' || !baselines.has(request.url)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const now = Date.now();
    const delay = Math.max(0, nextForwardAt - now);
    nextForwardAt = Math.max(now, nextForwardAt) + 550;
    const timer = setTimeout(() => {
      pendingForwards.delete(timer);
      if (request.destroyed) return;
      forwardedAt.push(Date.now());
      const upstream = forwardRequest(
        new URL(request.url, origin),
        {
          method: request.method,
          headers: { ...request.headers, host: new URL(origin).host },
        },
        (incoming) => {
          response.writeHead(incoming.statusCode, incoming.headers);
          incoming.pipe(response);
        },
      );
      upstream.on('error', () => {
        response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    }, delay);
    pendingForwards.add(timer);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const scanOrigin = `http://127.0.0.1:${proxy.address().port}`;
  server.on('request', (request, response) => {
    if (request.method !== 'POST' || !baselines.has(request.url)) return;
    evidence.requests += 1;
    const endpoint = endpointEvidence[request.url];
    endpoint.requests += 1;
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      bodyHashes.add(createHash('sha256').update(body).digest('hex'));
      if (body !== baselines.get(request.url)) {
        evidence.changedBodies += 1;
        endpoint.changedBodies += 1;
      }
    });
    response.on('finish', () => {
      endpoint.statusCounts[response.statusCode] =
        (endpoint.statusCounts[response.statusCode] || 0) + 1;
      evidence.statusCounts[response.statusCode] =
        (evidence.statusCounts[response.statusCode] || 0) + 1;
    });
  });
  const flags = ['--db', join(dataDir, 'scan.sqlite'), '--skip-dependency-check'];
  for (const [path, body] of baselines) {
    const requestFile = join(dataDir, 'request.http');
    await writeFile(
      requestFile,
      `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${proxy.address().port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    await run([
      'scan-request',
      ...flags,
      '-i',
      requestFile,
      '-t',
      scanOrigin,
      '--module-id',
      'sqli-error-based',
      '--module-id',
      'sqli-boolean-blind',
      '--no-passive',
      '--no-tech-filter',
      '--rate-limit',
      '2',
      '--concurrency',
      '1',
      '--max-per-host',
      '1',
      '--timeout',
      '5s',
    ]);
    assert.ok(
      endpointEvidence[path].changedBodies > 0,
      `No body mutations observed for ${path}; active coverage not established`,
    );
  }
  assert.ok(
    evidence.changedBodies > 0,
    'Scanner completed without verified body mutations; active coverage not established',
  );
  await run([
    'export',
    ...flags,
    '--format',
    'html,jsonl',
    '--omit-response',
    '-o',
    join(dataDir, 'report'),
  ]);
  for (const extension of ['html', 'jsonl']) {
    const path = join(outputDir, `report.${extension}`);
    const content = (await readFile(join(dataDir, `report.${extension}`), 'utf8'))
      .replaceAll(token, '[REDACTED]')
      .replaceAll(password, '[REDACTED]');
    await writeFile(path, content);
  }
  const rows = (await readFile(join(outputDir, 'report.jsonl'), 'utf8'))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);
  const findings = rows.filter((row) => row.type === 'finding');
  const scope = {
    sourceCommit:
      process.env.GITHUB_SHA ||
      process.env.REWIND_SCAN_COMMIT ||
      execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    completedAt: new Date().toISOString(),
    mode: 'Focused active DAST',
    endpoints: endpointEvidence,
    inputs: ['name', 'prompt', 'maxMembers', 'body'],
    modules: ['sqli-error-based', 'sqli-boolean-blind'],
    ...evidence,
    distinctRequestBodies: bodyHashes.size,
    minimumForwardIntervalMs: Math.min(
      ...forwardedAt.slice(1).map((time, index) => time - forwardedAt[index]),
    ),
    findings: findings.length,
    limitations:
      'SQL error-based and boolean-based modules selected on group creation and chat JSON requests; actual request mutations are verified per endpoint, not per module. No time-based injection, XSS, browser, media, exhaustive authorization, source audit or production coverage.',
  };
  await writeFile(join(outputDir, 'scope.json'), JSON.stringify(scope, null, 2) + '\n');
  await writeFile(
    join(outputDir, 'summary.html'),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rewind active DAST trial</title><style>body{font:17px/1.6 system-ui;background:#111827;color:#e5e7eb;margin:0}main{max-width:760px;margin:auto;padding:24px}section{background:#1f2937;padding:20px;border-radius:12px;margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#93c5fd}</style><main><h1>Rewind active DAST trial</h1><p>Latest scanned commit: ${scope.sourceCommit}</p><section><h2>Verified active requests</h2><p>Authenticated group creation and chat message POSTs; JSON fields: name, prompt, maxMembers, body.</p><p>Selected modules: <code>sqli-error-based</code>, <code>sqli-boolean-blind</code></p><p>${evidence.requests} requests received · ${evidence.changedBodies} changed bodies · ${bodyHashes.size} distinct request bodies</p><pre>${JSON.stringify(endpointEvidence, null, 2)}</pre><p>Response statuses: ${JSON.stringify(evidence.statusCounts)}</p><p>${findings.length} scanner findings. ${findings.length === 0 ? 'No finding was detected by the selected checks; this does not exclude other injection techniques or vulnerabilities.' : 'Review the scanner evidence before treating findings as confirmed vulnerabilities.'}</p></section><section><h2>Coverage limits</h2><p>${scope.limitations}</p><p>Temporary loopback backend and account only. Raw request, credentials and scan databases are removed after the run. CI runs these same disposable active checks.</p></section><a href="report.html">Open full Vigolium evidence</a></main></html>`,
  );
  console.log(JSON.stringify(scope, null, 2));
} finally {
  for (const timer of pendingForwards) clearTimeout(timer);
  if (proxy?.listening) {
    const closed = once(proxy, 'close');
    proxy.close();
    proxy.closeAllConnections();
    await closed;
  }
  if (server?.listening) {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
  database?.close();
  await rm(dataDir, { recursive: true, force: true });
}

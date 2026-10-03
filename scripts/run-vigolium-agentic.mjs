import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { providerSettings, redact, scopedProxy, summaryHtml } from './vigolium-provider.mjs';
import { createScanFixture } from './vigolium-fixture.mjs';

const mode = process.argv[2];
if (!['--prepare', '--verify', '--run'].includes(mode))
  throw new Error('Choose --prepare, --verify, or --run');
// Fail before starting the backend or scanner when live configuration is missing.
const settings = providerSettings(process.env, mode === '--run');
const fixtureMode = process.argv.includes('--fixture');
const output = resolve(
  process.env.REWIND_AGENT_REPORT_DIR ||
    (fixtureMode ? 'vigolium-result/agentic-fixture' : 'vigolium-result/agentic'),
);
const cli = resolve('node_modules/@vigolium/vigolium/bin/vigolium.js');
const temporary = await mkdtemp(join(tmpdir(), 'rewind-agentic-'));
const secrets = [process.env[settings.keyName]];
const report = {
  status: 'prepared',
  provider: settings.provider,
  model: settings.model,
  message: 'Preparation only. No AI requests or vulnerability assessment performed.',
  scope: 'One disposable group chat endpoint; GET and POST only.',
  target: fixtureMode ? 'intentionally-vulnerable-synthetic-fixture' : 'disposable-rewind-backend',
  limitations:
    'The proxy restricts seed-target traffic, not agent tools or host filesystem/network access. Run live scans on an isolated disposable worker. Source code is not supplied to the scanner.',
};
let database;
let server;
let proxy;

async function runCli(args, input) {
  const env = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  Object.assign(env, {
    HOME: temporary,
    USERPROFILE: temporary,
    TEMP: temporary,
    TMP: temporary,
    [settings.keyName]: process.env[settings.keyName],
  });
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: temporary,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Never publish raw agent logs: they can contain generated credentials or response data.
  child.stdout.resume();
  let diagnostic = '';
  child.stderr.on('data', (chunk) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-8192);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input || '');
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    child.kill();
  }, 360_000);
  try {
    const [code] = await once(child, 'exit');
    if (expired) throw new Error('Scanner exceeded the six-minute deadline');
    if (code !== 0) {
      // Only publish bounded error lines, after credential redaction, not agent conversation logs.
      const errors = redact(diagnostic, secrets)
        .replace(/\u001b\[[0-9;]*m/g, '')
        .split(/\r?\n/)
        .filter((line) => /^(?:Error:|✖ Error:|error:|fatal:)/i.test(line.trim()))
        .join('\n')
        .slice(0, 1500);
      throw new Error(
        `Scanner exited with code ${code}; no completed scan claimed${errors ? `: ${errors}` : ''}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

try {
  await mkdir(output, { recursive: true });
  // Remove previous findings before a new attempt, so failures cannot display stale results.
  for (const name of ['report.html', 'report.jsonl']) await rm(join(output, name), { force: true });
  if (mode !== '--prepare') {
    let origin;
    let token;
    let path;
    if (fixtureMode) {
      const fixture = await createScanFixture();
      ({ origin, token, path, server, database } = fixture);
      secrets.push(token);
      report.scope = 'Synthetic /fixture/chat GET/POST only; not the Rewind app.';
      report.expectedFinding =
        'SQL injection caused by string interpolation; the parameterized control must reject the same payload.';
    } else {
      const runtime = new URL('../server/dist/', import.meta.url);
      const { parseConfig } = await import(new URL('config.js', runtime));
      const { openDatabase } = await import(new URL('db.js', runtime));
      const { createRuntimeServer } = await import(new URL('http.js', runtime));
      const { createRealAccount } = await import(new URL('auth/index.js', runtime));
      const config = parseConfig({
        REWIND_DATA_DIR: temporary,
        REWIND_HOST: '127.0.0.1',
        REWIND_PORT: '0',
        REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true',
      });
      database = openDatabase(config);
      const password = randomUUID();
      secrets.push(password);
      const account = await createRealAccount(database, 'agentic-owner', 'Agentic owner', password);
      assert.equal(account.ok, true);
      server = createRuntimeServer(config, database);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      origin = `http://127.0.0.1:${server.address().port}`;
      const login = await fetch(`${origin}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'agentic-owner', password, clientType: 'native' }),
      });
      assert.equal(login.status, 200);
      token = (await login.json()).token;
      assert.equal(typeof token, 'string');
      secrets.push(token);
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const group = await fetch(`${origin}/real/groups`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Agentic fixture',
          prompt: 'Disposable trial',
          maxMembers: 4,
        }),
      });
      assert.equal(group.status, 201);
      const groupId = database
        .prepare(
          'SELECT group_id AS groupId FROM real_account_group_selections WHERE account_id = ?',
        )
        .get(account.account.id).groupId;
      assert.equal((await group.json()).group.id, groupId);
      path = `/realtime/groups/${groupId}/messages`;
    }
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    proxy = await scopedProxy(origin, path);
    const body = JSON.stringify({ body: 'Disposable agentic trial message' });
    const accepted = await fetch(`${proxy.origin}${path}`, { method: 'POST', headers, body });
    assert.equal(accepted.status, 201);
    await accepted.text();
    const anonymous = await fetch(`${proxy.origin}${path}`);
    assert.equal(anonymous.status, 401);
    await anonymous.text();
    const denied = await fetch(`${proxy.origin}/auth/login`);
    assert.equal(denied.status, 403);
    await denied.text();
    report.baselines = { authenticatedChat: 201, anonymousChat: 401, outsideScope: 403 };
    report.evidence = proxy.evidence;
    if (mode === '--verify') {
      if (fixtureMode) {
        const injected = await fetch(`${proxy.origin}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ body: "' OR 1=1 --" }),
        });
        const evidence = await injected.json();
        assert.ok(evidence.messages.some((message) => message.body === 'SYNTHETIC_PRIVATE_CANARY'));
        const control = await createScanFixture({ vulnerable: false });
        try {
          const rejected = await fetch(`${control.origin}${control.path}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${control.token}`,
            },
            body: JSON.stringify({ body: "' OR 1=1 --" }),
          });
          assert.deepEqual((await rejected.json()).messages, []);
        } finally {
          await control.close();
        }
        report.fixtureCheck = {
          knownPayload: 'verified',
          vulnerableCanaryExposed: true,
          parameterizedControlCanaryExposed: false,
          discoveredByAI: false,
        };
      }
      report.status = 'verified-offline';
      report.message =
        'Disposable backend, authentication, scope gate and reporting verified. No AI provider contacted; no vulnerability findings claimed.';
    } else {
      const before = proxy.evidence.forwarded;
      const configPath = join(temporary, 'vigolium.json');
      await writeFile(
        configPath,
        JSON.stringify({
          agent: {
            sessions_dir: join(temporary, 'sessions'),
            olium: { provider: settings.provider, model: settings.model },
          },
        }),
      );
      const flags = [
        '--config',
        configPath,
        '--db',
        join(temporary, 'scan.sqlite'),
        '--skip-dependency-check',
      ];
      const raw = `POST ${path} HTTP/1.1\r\nHost: ${new URL(proxy.origin).host}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      await runCli(
        [
          'agent',
          'swarm',
          ...flags,
          '--target',
          `${proxy.origin}${path}`,
          '--provider',
          settings.provider,
          '--model',
          settings.model,
          '--header',
          `Authorization: Bearer ${token}`,
          '--prompt',
          'Assess the supplied disposable chat request for SQL injection and authorization issues. Stay on the supplied endpoint. Do not read source files or contact other targets. Treat denied scope requests as scope controls, not vulnerabilities. Explain evidence and uncertainty.',
          '--intensity',
          'quick',
          '--discover=false',
          '--browser-auth=false',
          '--triage=true',
          '--code-audit=false',
          '--only',
          'dynamic-assessment',
          '--vuln-type',
          'sqli',
          '--skip',
          'recon,discovery,spidering,spa,external-harvest,rescan',
          '--max-duration',
          '5m',
          '--max-iterations',
          '1',
          '--batch-concurrency',
          '1',
          '--max-master-retries',
          '1',
          '--max-plan-records',
          '1',
          '--probe-concurrency',
          '1',
          '--probe-timeout',
          '5s',
          '--max-probe-body',
          '65536',
        ],
        raw,
      );
      assert.ok(
        proxy.evidence.forwarded > before,
        'No scanner traffic observed; scan completion not established',
      );
      await runCli([
        'export',
        ...flags,
        '--format',
        'html,jsonl',
        '--omit-response',
        '-o',
        join(temporary, 'report'),
      ]);
      for (const extension of ['html', 'jsonl']) {
        const content = await readFile(join(temporary, `report.${extension}`), 'utf8');
        await writeFile(join(output, `report.${extension}`), redact(content, secrets));
      }
      report.status = 'scanner-completed';
      report.message =
        'Provider-backed scanner exited successfully and target traffic was observed. Review exported findings and their evidence; this does not establish complete application coverage.';
      report.scannerRequests = proxy.evidence.forwarded - before;
    }
  }
} catch (error) {
  report.status = 'incomplete';
  report.message = redact(error.message, secrets);
  process.exitCode = 1;
} finally {
  if (proxy) await proxy.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  database?.close();
  await rm(temporary, { recursive: true, force: true });
  const serialized = redact(JSON.stringify(report, null, 2), secrets);
  await writeFile(join(output, 'scope.json'), serialized);
  await writeFile(join(output, 'summary.html'), summaryHtml(JSON.parse(serialized)));
}
console.log(`Agentic trial: ${report.status}. Report: ${join(output, 'summary.html')}`);

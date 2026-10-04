import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  providerSettings,
  redact,
  scopedProxy,
  summarizeFindings,
  summaryHtml,
  disposableTarget,
} from './vigolium-provider.mjs';
import { createScanFixture, verifyFixturePayloads } from './vigolium-fixture.mjs';

const mode = process.argv[2];
if (!['--prepare', '--verify', '--run', '--replay'].includes(mode))
  throw new Error('Choose --prepare, --verify, --run, or --replay');
// Fail before starting the backend or scanner when live configuration is missing.
const settings = providerSettings(process.env, mode === '--run');
const fixtureMode = process.argv.includes('--fixture');
const targetFileIndex = process.argv.indexOf('--target-file');
const targetFile = targetFileIndex < 0 ? undefined : process.argv[targetFileIndex + 1];
if (targetFileIndex >= 0 && (!targetFile || fixtureMode))
  throw new Error('Choose either a target file or a synthetic fixture');
const output = resolve(
  process.env.REWIND_AGENT_REPORT_DIR ||
    (fixtureMode ? 'vigolium-result/agentic-fixture' : 'vigolium-result/agentic'),
);
if (mode === '--replay' && !fixtureMode) throw new Error('Replay requires the synthetic fixture');
const replayArtifacts =
  mode === '--replay'
    ? JSON.parse(await readFile(join(output, 'generated-artifacts.json'), 'utf8'))
    : undefined;
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
let fixtureEvidence;

async function retainSyntheticArtifacts(directory, depth = 0, artifacts = []) {
  if (depth > 6 || artifacts.length >= 10) return artifacts;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await retainSyntheticArtifacts(path, depth + 1, artifacts);
    else if (
      entry.isFile() &&
      artifacts.length < 10 &&
      (entry.name === 'swarm-plan.json' ||
        (entry.name.endsWith('.js') && /[\\/]extensions[\\/]/.test(path))) &&
      (await stat(path)).size <= 262144
    ) {
      artifacts.push({
        path: relative(temporary, path),
        content: redact(await readFile(path, 'utf8'), secrets),
      });
    }
  }
  return artifacts;
}

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
  });
  // Native execution/export needs no provider credential, including generated JS.
  if (args[0] === 'agent' && mode === '--run')
    env[settings.keyName] = process.env[settings.keyName];
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
    return redact(diagnostic, secrets)
      .replace(/\u001b\[[0-9;]*m/g, '')
      .split(/\r?\n/)
      .filter((line) =>
        /Scanning with modules:|Phase \[|Extensions:|scan error \(non-fatal\)|warning\(s\)/.test(
          line,
        ),
      )
      .slice(-12);
  } finally {
    clearTimeout(timer);
  }
}

try {
  await mkdir(output, { recursive: true });
  // Remove previous findings before a new attempt, so failures cannot display stale results.
  for (const name of [
    'report.html',
    'report.jsonl',
    'native-report.html',
    'native-report.jsonl',
    'generated-artifacts.json',
  ])
    await rm(join(output, name), { force: true });
  if (mode !== '--prepare') {
    let origin;
    let token;
    let path;
    if (targetFile) {
      const seed = JSON.parse(await readFile(targetFile, 'utf8'));
      ({ origin, token, path } = disposableTarget(seed));
      secrets.push(token);
      report.preflightBaselines = Object.fromEntries(
        [
          'login',
          'groupCreation',
          'ownerPost',
          'ownerRead',
          'anonymousRead',
          'outsiderRead',
          'outsiderPost',
        ]
          .filter((name) => Number.isInteger(seed.baselines?.[name]))
          .map((name) => [name, seed.baselines[name]]),
      );
      report.scope = 'Disposable Rewind chat endpoint, GET/POST only; no production data.';
      report.isolation =
        'Application runtime is in a separate container; scanner sees HTTP traffic only.';
    } else if (fixtureMode) {
      const fixture = await createScanFixture();
      ({ origin, token, path, server, database } = fixture);
      fixtureEvidence = fixture.evidence;
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
      const acceptedBefore = proxy.evidence.statuses[201] || 0;
      const runId = randomUUID();
      const configPath = join(temporary, 'vigolium.json');
      await writeFile(
        configPath,
        JSON.stringify({
          'dynamic-assessment': {
            extensions: {
              enabled: true,
              extension_dir: join(temporary, 'sessions', runId, 'extensions'),
            },
            enabled_modules: {
              active_modules: ['sqli-error-based'],
              passive_modules: ['auth-headers-detect'],
            },
          },
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
        '--scan-uuid',
        runId,
      ];
      // Vigolium otherwise infers HTTPS for raw requests on a nonstandard port.
      const raw = `POST ${path} HTTP/1.1\r\nHost: ${new URL(proxy.origin).host}\r\nOrigin: ${proxy.origin}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      if (mode === '--replay') {
        const directory = join(temporary, 'sessions', runId, 'extensions');
        await mkdir(directory, { recursive: true });
        const scripts = replayArtifacts.filter((artifact) => artifact.path.endsWith('.js'));
        assert.ok(scripts.length && scripts.length <= 10, 'No bounded generated scripts available');
        for (const [index, script] of scripts.entries()) {
          assert.ok(typeof script.content === 'string' && script.content.length <= 262144);
          // Relocate the disposable seed only; preserve the generated detector logic.
          const content = script.content.replaceAll(
            /http:\/\/127\.0\.0\.1:\d+\/fixture\/chat/g,
            `${proxy.origin}${path}`,
          );
          await writeFile(join(directory, `replayed-${index}.js`), content);
        }
        report.providerContacted = false;
        report.generation = 'replayed-retained-AI-extension';
      } else
        report.scannerDiagnostics = await runCli(
          [
            'agent',
            'swarm',
            ...flags,
            // Explicit input is required: --target makes Vigolium ignore piped stdin.
            '--input',
            '-',
            '--provider',
            settings.provider,
            '--model',
            settings.model,
            '--header',
            `Authorization: Bearer ${token}`,
            '--prompt',
            (fixtureMode
              ? 'Assess the supplied disposable chat POST JSON body for SQL injection. This synthetic endpoint uses SQLite and returns messages matching body. '
              : 'Assess the supplied disposable Rewind chat POST JSON body for SQL injection using HTTP evidence only. POST creates a message; GET reads messages. There is no known vulnerability. Literal storage or reflection of a payload is not SQL injection; normal message creation and changing message IDs are not evidence. Never invent a finding to satisfy the trial. ') +
              'Select sqli-error-based and generate a small custom extension using paired true/false controls. Limit it to 12 requests. Evaluate the observed baseline, true and false response differences: a false OR condition can preserve baseline matches, so do not require it to return zero rows. Require repeated stable true-versus-false differences and explain them; identical responses must never produce a finding. IMPORTANT SDK CONTRACT: ctx.request contains raw, method, url, headers only; ctx.request.body does not exist. Parse the JSON body from ctx.request.raw after its blank header/body separator. Return finding objects with name, url, matched, request, response and module tags ["sqli"]. Use plain module IDs and tags without Markdown list prefixes. Preserve the Authorization header, HTTP origin and endpoint path. Do not read source files or contact other targets. Treat denied scope requests as scope controls, not vulnerabilities. Explain evidence and uncertainty.',
            '--modules',
            'sqli-error-based',
            '--with-extensions',
            '--intensity',
            'quick',
            '--discover=false',
            '--browser-auth=false',
            '--triage=false',
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
      if (fixtureMode || targetFile) {
        // Preserve native findings before the dedicated extension database is used.
        await runCli([
          'export',
          ...flags,
          '--format',
          'html,jsonl',
          '--omit-response',
          '-o',
          join(temporary, 'native-report'),
        ]);
        for (const extension of ['html', 'jsonl']) {
          await writeFile(
            join(output, `native-report.${extension}`),
            redact(await readFile(join(temporary, `native-report.${extension}`), 'utf8'), secrets),
          );
        }
        report.nativeReport = 'native-report.html';
        const generated = await retainSyntheticArtifacts(join(temporary, 'sessions'));
        const scripts = generated
          .filter((artifact) => artifact.path.endsWith('.js'))
          .map((artifact) => join(temporary, artifact.path));
        assert.ok(
          scripts.length,
          'No generated extension retained; agentic detection is unverified',
        );
        // The installed swarm/native bridge did not execute generated probes.
        // Run the dedicated extension phase against its ingested authenticated seed.
        // Set the isolated default config as well: its native engine can reload it.
        const nativeConfig = JSON.parse(await readFile(configPath, 'utf8'));
        // Swarm's native module allowlist excludes generated extension IDs.
        delete nativeConfig['dynamic-assessment'].enabled_modules;
        // Keep standalone extension records separate from swarm scan state.
        const nativeFlags = [
          '--config',
          configPath,
          '--db',
          join(temporary, 'extensions.sqlite'),
          '--skip-dependency-check',
        ];
        const defaultExtensionDirectory = resolve(temporary, '.vigolium', 'extensions');
        assert.equal(
          relative(temporary, defaultExtensionDirectory),
          join('.vigolium', 'extensions'),
          'Extension cleanup must stay inside the owned temporary home',
        );
        // The native engine uses this isolated default directory reliably.
        // Remove only starter presets in our owned temp home, then copy the
        // unmodified AI-generated scripts; no exploit logic is substituted.
        await rm(defaultExtensionDirectory, { recursive: true, force: true });
        await mkdir(defaultExtensionDirectory, { recursive: true });
        for (const [index, script] of scripts.entries())
          await writeFile(
            join(defaultExtensionDirectory, `generated-${index}.js`),
            await readFile(script),
          );
        nativeConfig['dynamic-assessment'].extensions = {
          enabled: true,
          extension_dir: defaultExtensionDirectory,
          custom_dir: [],
        };
        const defaultConfigDirectory = join(temporary, '.vigolium');
        await mkdir(defaultConfigDirectory, { recursive: true });
        await writeFile(configPath, JSON.stringify(nativeConfig));
        await writeFile(
          join(defaultConfigDirectory, 'vigolium-configs.yaml'),
          JSON.stringify(nativeConfig),
        );
        await runCli(['ingest', ...nativeFlags, '--input', '-'], raw);
        report.extensionDiagnostics = await runCli([
          'run',
          'extension',
          ...nativeFlags,
          '--target',
          `${proxy.origin}${path}`,
          ...scripts.flatMap((script) => ['--ext', script]),
          '--concurrency',
          '1',
          '--rate-limit',
          '2',
          '--timeout',
          '5s',
          '--scanning-max-duration',
          '45s',
        ]);
        report.extensionExecution = 'explicit-native-extension-phase';
        flags.splice(0, flags.length, ...nativeFlags);
      }
      assert.ok(
        proxy.evidence.forwarded > before,
        'No scanner traffic observed; scan completion not established',
      );
      assert.ok(
        (proxy.evidence.statuses[201] || 0) > acceptedBefore,
        'No accepted authenticated POST observed from scanner; assessment remains incomplete',
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
        let content = await readFile(join(temporary, `report.${extension}`), 'utf8');
        if (extension === 'jsonl' && report.nativeReport) {
          const native = await readFile(join(output, 'native-report.jsonl'), 'utf8');
          content = [native.trim(), content.trim()].filter(Boolean).join('\n') + '\n';
        }
        await writeFile(join(output, `report.${extension}`), redact(content, secrets));
      }
      report.status = 'scanner-completed';
      report.assessment = summarizeFindings(await readFile(join(output, 'report.jsonl'), 'utf8'));
      if (fixtureMode) {
        report.independentVerification = await verifyFixturePayloads(
          fixtureEvidence.filter((probe) => probe.authenticated).map((probe) => probe.body),
        );
        report.detectionTrialPassed =
          report.assessment.sqlInjectionReported && report.independentVerification.confirmed;
      }
      report.message = fixtureMode
        ? report.detectionTrialPassed
          ? 'Scanner reported SQL injection and observed probe values independently reproduced it on the vulnerable fixture while the parameterized control rejected them. This proves the synthetic trial, not Rewind application coverage.'
          : report.independentVerification.confirmed
            ? 'Observed scanner probes independently confirmed SQL injection, but the scanner export did not report it. Finding integration remains incomplete.'
            : 'Scanner completed, but SQL injection detection was not independently verified. The detection trial has not passed.'
        : 'Provider-backed scanner completed with authenticated target traffic. Review exported findings and their evidence; this does not establish complete application coverage.';
      report.scannerRequests = proxy.evidence.forwarded - before;
      report.requestLimitReached = proxy.evidence.forwarded >= 120;
      if (fixtureMode && !report.detectionTrialPassed) process.exitCode = 1;
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
  if ((fixtureMode || targetFile) && ['--run', '--replay'].includes(mode)) {
    report.fixtureProbes = fixtureEvidence;
    const artifacts = await retainSyntheticArtifacts(join(temporary, 'sessions'));
    await writeFile(join(output, 'generated-artifacts.json'), JSON.stringify(artifacts, null, 2));
    report.generatedArtifactCount = artifacts.length;
  }
  await rm(temporary, { recursive: true, force: true });
  const serialized = redact(JSON.stringify(report, null, 2), secrets);
  await writeFile(join(output, 'scope.json'), serialized);
  await writeFile(join(output, 'summary.html'), summaryHtml(JSON.parse(serialized)));
}
console.log(`Agentic trial: ${report.status}. Report: ${join(output, 'summary.html')}`);

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  assertOwnedPortsAvailable,
  createCleanupStack,
  createLocalTlsProfile,
  localOnlyEnv,
  portsForRealAccountRun,
  redactRealAccountDiagnostic,
  runOwnedCommand,
} from './real-account-e2e-utils.mjs';
import { assertStaticArtifact, createProductionWebServer } from './production-web-proxy.mjs';

const projectRoot = process.cwd();
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
  throw new Error('Real-account E2E requires Node >=22.13.0, matching the project engine.');
}

const activeChildren = new Set();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    for (const child of activeChildren) child.kill('SIGTERM');
  });
}

function cleanFixtureEnv(source = process.env, overrides = {}) {
  const env = localOnlyEnv(source);
  for (const key of Object.keys(env)) {
    if (key.startsWith('REWIND_')) delete env[key];
  }
  return { ...env, ...overrides };
}

function appendBounded(previous, chunk) {
  return (previous + chunk.toString()).slice(-8_000);
}

function startOwnedProcess(command, args, env) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChildren.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => {
    output = appendBounded(output, chunk);
  });
  child.stderr.on('data', (chunk) => {
    output = appendBounded(output, chunk);
  });
  const exited = new Promise((resolve) => {
    child.once('error', (error) => {
      output = appendBounded(output, error.message);
      resolve({ code: 1, signal: null });
    });
    child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
  }).finally(() => activeChildren.delete(child));
  return { child, exited, getOutput: () => redactRealAccountDiagnostic(output) };
}

async function stopOwnedProcess(processHandle) {
  if (!processHandle || processHandle.child.exitCode !== null || processHandle.child.signalCode)
    return;
  if (processHandle.child.pid === undefined) {
    await processHandle.exited;
    return;
  }
  processHandle.child.kill('SIGTERM');
  const stopped = await Promise.race([
    processHandle.exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 8_000)),
  ]);
  if (stopped) return;
  processHandle.child.kill('SIGKILL');
  await processHandle.exited;
}

async function runChecked(command, args, env = localOnlyEnv()) {
  const exitCode = await runOwnedCommand(command, args, {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
  });
  if (exitCode !== 0) throw new Error(`${command} ${args.join(' ')} exited with code ${exitCode}.`);
}

async function waitForHealth(processHandle, runtimeOrigin) {
  const deadline = Date.now() + 20_000;
  let lastStatus = 'not reachable';
  while (Date.now() < deadline) {
    if (
      processHandle.child.pid === undefined ||
      processHandle.child.exitCode !== null ||
      processHandle.child.signalCode
    ) {
      throw new Error(`Owned runtime exited before becoming ready. ${processHandle.getOutput()}`);
    }
    try {
      const response = await fetch(`${runtimeOrigin}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
      lastStatus = `HTTP ${response.status}`;
    } catch {
      // The listener may need a moment to bind after its child starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `Owned runtime did not become healthy (${lastStatus}). ${processHandle.getOutput()}`,
  );
}

async function runPlaywright(runNumber, fixtureDir, profileDir, webOrigin) {
  const { runtimePort } = portsForRealAccountRun(runNumber);
  const screenshotPath = join(tmpdir(), `rewind-real-account-${process.pid}-run-${runNumber}.png`);
  const env = cleanFixtureEnv(process.env, {
    REWIND_REAL_ACCOUNT_RUN: String(runNumber),
    REWIND_REAL_ACCOUNT_PROFILE: profileDir,
    REWIND_REAL_ACCOUNT_DB: join(fixtureDir, 'data', 'rewind.sqlite'),
    REWIND_REAL_ACCOUNT_WEB_ORIGIN: webOrigin,
    REWIND_REAL_ACCOUNT_OUTPUT_DIR: join(fixtureDir, 'playwright-output'),
    REWIND_REAL_ACCOUNT_RUNTIME_PORT: String(runtimePort),
    REWIND_REAL_ACCOUNT_SCREENSHOT: screenshotPath,
  });
  const playwrightCli = join(projectRoot, 'node_modules/@playwright/test/cli.js');
  const result = startOwnedProcess(
    process.execPath,
    [playwrightCli, 'test', '--config=playwright.real-account.config.ts'],
    env,
  );
  const exit = await result.exited;
  const output = result.getOutput();
  if (output) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  if (exit.code !== 0) {
    throw new Error(`Real-account Playwright run ${runNumber} exited with code ${exit.code}.`);
  }
  console.log(`Real-account UI screenshot (run ${runNumber}): ${screenshotPath}`);
}

async function startFixtureRun(staticDir, rootDir, runNumber) {
  const ports = portsForRealAccountRun(runNumber);
  await assertOwnedPortsAvailable([ports.runtimePort, ports.webPort]);
  const fixtureDir = join(rootDir, `run-${runNumber}`);
  const dataDir = join(fixtureDir, 'data');
  const cleanup = createCleanupStack();
  cleanup.defer(() => rm(fixtureDir, { recursive: true, force: true }));

  try {
    await mkdir(dataDir, { recursive: true });
    const tls = await createLocalTlsProfile({ directory: fixtureDir, runNumber });
    const originAuthSecret = randomBytes(32).toString('base64url');
    const runtimeOrigin = `http://127.0.0.1:${ports.runtimePort}`;
    const runtimeEnv = cleanFixtureEnv(process.env, {
      REWIND_DATA_DIR: dataDir,
      REWIND_HOST: '127.0.0.1',
      REWIND_PORT: String(ports.runtimePort),
      REWIND_FFMPEG_BIN: 'ffmpeg',
      REWIND_ALLOW_ORIGIN: `https://localhost:${ports.webPort}`,
      REWIND_ORIGIN_AUTH_SECRET: originAuthSecret,
    });
    const runtime = startOwnedProcess(
      process.execPath,
      [join(projectRoot, 'server/dist/cli.js'), 'start'],
      runtimeEnv,
    );
    cleanup.defer(() => stopOwnedProcess(runtime));
    await waitForHealth(runtime, runtimeOrigin);

    const webServer = createProductionWebServer({
      staticDir,
      runtimeOrigin,
      tls: { key: await readFile(tls.serverKey), cert: await readFile(tls.serverCert) },
      originAuthSecret,
    });
    webServer.listen(ports.webPort, '127.0.0.1');
    await once(webServer, 'listening');
    cleanup.defer(
      () =>
        new Promise((resolve, reject) =>
          webServer.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    await assertStaticArtifact(staticDir);

    return {
      fixtureDir,
      profileDir: tls.profileDir,
      webOrigin: `https://localhost:${ports.webPort}`,
      cleanup,
    };
  } catch (error) {
    await cleanup.dispose();
    throw error;
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function main() {
  const rootDir = await mkdtemp(join(tmpdir(), 'rewind-real-account-e2e-'));
  try {
    const staticDir = join(rootDir, 'web-artifact');
    const expoCli = join(projectRoot, 'node_modules/expo/bin/cli');
    const buildEnv = localOnlyEnv(process.env, {
      EXPO_PUBLIC_DEMO_ACCESS: 'disabled',
      EXPO_PUBLIC_LOCAL_BASE_URL: '/api',
      EXPO_PUBLIC_INVITE_WEB_ORIGIN: '',
    });
    delete buildEnv.EXPO_PUBLIC_CAMERA_MODE;

    await runChecked('npm', ['run', 'server:build']);
    await runChecked(
      process.execPath,
      [expoCli, 'export', '--clear', '--platform', 'web', '--output-dir', staticDir],
      buildEnv,
    );
    await runChecked(
      process.execPath,
      [join(projectRoot, 'scripts/stamp-pwa-build.mjs'), staticDir],
      buildEnv,
    );
    await assertStaticArtifact(staticDir);

    const results = [];
    for (const runNumber of [1, 2]) {
      let fixture;
      let exitCode = 0;
      try {
        fixture = await startFixtureRun(staticDir, rootDir, runNumber);
        await runPlaywright(runNumber, fixture.fixtureDir, fixture.profileDir, fixture.webOrigin);
      } catch (error) {
        exitCode = 1;
        console.error(redactRealAccountDiagnostic(error instanceof Error ? error.message : error));
      } finally {
        try {
          await fixture?.cleanup.dispose();
          if (fixture && (await pathExists(fixture.fixtureDir))) {
            throw new Error('Owned fixture data remained after cleanup.');
          }
          if (fixture) {
            const ports = portsForRealAccountRun(runNumber);
            await assertOwnedPortsAvailable([ports.runtimePort, ports.webPort]);
          }
        } catch (error) {
          exitCode = 1;
          console.error(
            redactRealAccountDiagnostic(error instanceof Error ? error.message : error),
          );
        }
      }
      results.push({ runNumber, exitCode });
      if (exitCode === 0) console.log(`Real-account HTTPS fixture run ${runNumber}: passed.`);
    }
    if (results.some((result) => result.exitCode !== 0)) process.exitCode = 1;
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

await main();

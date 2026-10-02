import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertOwnedReadiness } from './production-e2e-server.mjs';
import { localOnlyEnv, runOwnedCommand, runProductionE2ePair } from './run-production-e2e.mjs';

async function makeTemporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rewind-production-runner-test-'));
  execFileSync('git', ['init', '-q'], { cwd: directory });
  await writeFile(join(directory, 'App.tsx'), 'export default 1;\n');
  await writeFile(join(directory, 'package-lock.json'), '{"lockfileVersion":3}\n');
  execFileSync('git', ['add', 'App.tsx', 'package-lock.json'], { cwd: directory });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function readinessSignals(overrides = {}) {
  const runtimePort = 41001;
  const webPort = 41002;
  const buildId = 'a'.repeat(24);
  const runtimeServer = {
    listening: true,
    address: () => ({ address: '127.0.0.1', port: runtimePort }),
  };
  const webServer = {
    listening: true,
    address: () => ({ address: '127.0.0.1', port: webPort }),
  };
  return {
    runtimeServer,
    webServer,
    runtimePort,
    webPort,
    healthStatus: 200,
    health: {
      ok: true,
      ready: true,
      service: 'rewind-local-runtime',
      addresses: { local: `http://127.0.0.1:${runtimePort}` },
    },
    workerStatus: 200,
    serviceWorker: `const CACHE_NAME = 'rewind-shell-v3-${buildId}';`,
    buildId,
    ...overrides,
  };
}

test('production readiness matches owned loopback ports, runtime health, and served build', () => {
  assert.equal(assertOwnedReadiness(readinessSignals()), true);
});

test('production readiness rejects a foreign owner, unhealthy runtime, or different artifact', () => {
  const cases = [
    readinessSignals({
      webServer: { listening: true, address: () => ({ address: '127.0.0.1', port: 8083 }) },
    }),
    readinessSignals({ health: { ok: false, ready: false, service: 'other', addresses: {} } }),
    readinessSignals({
      serviceWorker: "const CACHE_NAME = 'rewind-shell-v3-bbbbbbbbbbbbbbbbbbbbbbbb';",
    }),
  ];
  for (const signals of cases) assert.throws(() => assertOwnedReadiness(signals), /Production E2E/);
});

test('owned process runner returns the child failure exit code unchanged', async () => {
  const code = await runOwnedCommand(process.execPath, ['-e', 'process.exit(23)']);
  assert.equal(code, 23);
});

test('production pair builds server once and shares one temporary artifact cache across two isolated runs', async (t) => {
  const root = await makeTemporaryDirectory(t);
  const cacheRoot = join(root, 'artifact-cache');
  const commands = [];
  let removed = false;
  const exitCode = await runProductionE2ePair({
    root,
    sourceEnv: {
      npm_execpath: '/npm/cli.js',
      EXPO_PUBLIC_BUILD: 'demo',
      AWS_SECRET_ACCESS_KEY: 'unused',
    },
    makeCacheRoot: async () => {
      await mkdir(cacheRoot);
      return cacheRoot;
    },
    removeCacheRoot: async (path) => {
      await rm(path, { recursive: true, force: true });
      removed = true;
    },
    execute: async (command, args, options) => {
      commands.push({ command, args, env: options.env });
      return 0;
    },
    log: () => {},
  });

  assert.equal(exitCode, 0);
  assert.equal(commands.length, 3);
  assert.deepEqual(commands[0].args, ['/npm/cli.js', 'run', 'server:build']);
  assert.match(commands[1].args[0], /@playwright\/test\/cli\.js$/);
  assert.deepEqual(
    commands.slice(1).map(({ env }) => env.REWIND_E2E_RUN),
    ['1', '2'],
  );
  assert.equal(commands[0].env.REWIND_E2E_ARTIFACT_CACHE_DIR, cacheRoot);
  assert.equal(commands[1].env.REWIND_E2E_ARTIFACT_CACHE_DIR, cacheRoot);
  assert.equal(commands[2].env.REWIND_E2E_ARTIFACT_CACHE_DIR, cacheRoot);
  assert.equal('AWS_SECRET_ACCESS_KEY' in commands[1].env, false);
  assert.equal(removed, true);
});

test('production pair preserves the first browser failure after running both isolated cases and cleaning cache', async (t) => {
  const root = await makeTemporaryDirectory(t);
  const cacheRoot = join(root, 'artifact-cache');
  await mkdir(cacheRoot);
  const calls = [];
  const exitCode = await runProductionE2ePair({
    root,
    sourceEnv: {},
    makeCacheRoot: async () => cacheRoot,
    execute: async (_command, args) => {
      calls.push(args);
      return calls.length === 2 ? 29 : 0;
    },
    log: () => {},
  });
  assert.equal(exitCode, 29);
  assert.equal(calls.length, 3);
  await assert.rejects(rm(cacheRoot, { recursive: false }), { code: 'ENOENT' });
});

test('production pair preserves server-build failure and skips browser runs', async (t) => {
  const root = await makeTemporaryDirectory(t);
  const cacheRoot = join(root, 'artifact-cache');
  await mkdir(cacheRoot);
  const calls = [];
  const exitCode = await runProductionE2ePair({
    root,
    sourceEnv: {},
    makeCacheRoot: async () => cacheRoot,
    execute: async (_command, args) => {
      calls.push(args);
      return 31;
    },
    log: () => {},
  });
  assert.equal(exitCode, 31);
  assert.equal(calls.length, 1);
  await assert.rejects(rm(cacheRoot, { recursive: false }), { code: 'ENOENT' });
});

test('production pair rejects source changes made during the shared server build', async (t) => {
  const root = await makeTemporaryDirectory(t);
  const cacheRoot = join(root, 'artifact-cache');
  await mkdir(cacheRoot);
  const calls = [];
  const exitCode = await runProductionE2ePair({
    root,
    sourceEnv: {},
    makeCacheRoot: async () => cacheRoot,
    execute: async (_command, args) => {
      calls.push(args);
      await writeFile(join(root, 'App.tsx'), 'export default "changed during server build";\n');
      return 0;
    },
    log: () => {},
  });
  assert.equal(exitCode, 1);
  assert.equal(calls.length, 1);
  await assert.rejects(rm(cacheRoot, { recursive: false }), { code: 'ENOENT' });
});

test('production pair rejects source changes between its isolated browser runs', async (t) => {
  const root = await makeTemporaryDirectory(t);
  const cacheRoot = join(root, 'artifact-cache');
  await mkdir(cacheRoot);
  const calls = [];
  const exitCode = await runProductionE2ePair({
    root,
    sourceEnv: {},
    makeCacheRoot: async () => cacheRoot,
    execute: async (_command, args) => {
      calls.push(args);
      if (calls.length === 2) {
        await writeFile(join(root, 'App.tsx'), 'export default "changed between runs";\n');
      }
      return 0;
    },
    log: () => {},
  });
  assert.equal(exitCode, 1);
  assert.equal(calls.length, 2);
  await assert.rejects(rm(cacheRoot, { recursive: false }), { code: 'ENOENT' });
});

test('cleanup failure changes success to failure without replacing an earlier failure code', async (t) => {
  const root = await makeTemporaryDirectory(t);
  const execute = async (_command, args) => (args[0] === 'run' ? 0 : 0);
  const successfulCleanupFailure = await runProductionE2ePair({
    root,
    sourceEnv: {},
    makeCacheRoot: async () => join(root, 'cache-a'),
    removeCacheRoot: async () => {
      throw new Error('cleanup failed');
    },
    execute,
    log: () => {},
  });
  assert.equal(successfulCleanupFailure, 1);

  let call = 0;
  const earlierProcessFailure = await runProductionE2ePair({
    root,
    sourceEnv: {},
    makeCacheRoot: async () => join(root, 'cache-b'),
    removeCacheRoot: async () => {
      throw new Error('cleanup failed');
    },
    execute: async () => (++call === 1 ? 0 : 29),
    log: () => {},
  });
  assert.equal(earlierProcessFailure, 29);
});

test('child environment removes cloud credentials while preserving fixture and public settings', () => {
  const env = localOnlyEnv('2', '/tmp/cache', {
    AWS_REGION: 'region',
    AWS_ACCESS_KEY_ID: 'key',
    CLOUDSDK_CONFIG: '/config',
    EXPO_PUBLIC_LOCAL_BASE_URL: '/api',
    EXPO_PUBLIC_CAMERA_MODE: 'demo',
  });
  assert.equal(env.REWIND_E2E_RUN, '2');
  assert.equal(env.REWIND_E2E_ARTIFACT_CACHE_DIR, '/tmp/cache');
  assert.equal(env.EXPO_PUBLIC_LOCAL_BASE_URL, '/api');
  assert.equal(env.EXPO_PUBLIC_CAMERA_MODE, 'demo');
  assert.equal('AWS_REGION' in env, false);
  assert.equal('AWS_ACCESS_KEY_ID' in env, false);
  assert.equal('CLOUDSDK_CONFIG' in env, false);
});

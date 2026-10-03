import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { ensureBuildArtifact } from './build-artifact.mjs';
import { createProductionWebServer, assertStaticArtifact } from './production-web-proxy.mjs';

const projectRoot = process.cwd();
const seedNow = new Date('2026-09-01T00:00:00.000Z');
const demoNow = new Date('2026-09-11T12:00:01.000Z');
const crossGroupBootstrapGroupId = 'production-e2e-bootstrap-group';
const crossGroupBootstrapCycleId = 'production-e2e-bootstrap-cycle';

function seedCrossGroupBootstrap(database) {
  const startsAt = seedNow.toISOString();
  const endsAt = new Date(seedNow.getTime() + 11 * 24 * 60 * 60 * 1000).toISOString();
  database.exec('BEGIN');
  try {
    database
      .prepare(
        'INSERT INTO profiles (id, display_name, avatar_label, is_synthetic) VALUES (?, ?, ?, 1)',
      )
      .run('demo-6', 'Fable', 'Fable, second-group member');
    database
      .prepare('INSERT INTO groups (id, name, current_cycle_id) VALUES (?, ?, ?)')
      .run(crossGroupBootstrapGroupId, 'Production E2E Bootstrap', crossGroupBootstrapCycleId);
    database
      .prepare(
        `INSERT INTO cycles
          (id, group_id, prompt, starts_at, ends_at, status, lock_state,
           max_count, max_seconds, count_used, seconds_used)
         VALUES (?, ?, ?, ?, ?, 'collecting', 'locked', 5, 30, 0, 0)`,
      )
      .run(
        crossGroupBootstrapCycleId,
        crossGroupBootstrapGroupId,
        'A private bootstrap prompt for production E2E.',
        startsAt,
        endsAt,
      );
    database
      .prepare(
        `INSERT INTO memberships (group_id, member_id, role, accepted_at)
         VALUES (?, ?, 'owner', ?)`,
      )
      .run(crossGroupBootstrapGroupId, 'demo-6', startsAt);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function localOnlyEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('AWS_') ||
      key === 'AWS_PROFILE' ||
      key === 'AWS_DEFAULT_PROFILE' ||
      key === 'AWS_CONFIG_FILE' ||
      key === 'AWS_SHARED_CREDENTIALS_FILE' ||
      key.startsWith('CLOUDSDK_')
    ) {
      delete env[key];
    }
  }
  return env;
}

async function listen(server, port = 0) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Local E2E server did not expose a port.');
  return address.port;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

export function assertOwnedReadiness({
  runtimeServer,
  webServer,
  runtimePort,
  webPort,
  healthStatus,
  health,
  workerStatus,
  serviceWorker,
  buildId,
}) {
  const runtimeAddress = runtimeServer.address();
  const webAddress = webServer.address();
  if (
    !runtimeServer.listening ||
    typeof runtimeAddress === 'string' ||
    runtimeAddress?.address !== '127.0.0.1' ||
    runtimeAddress?.port !== runtimePort ||
    !webServer.listening ||
    typeof webAddress === 'string' ||
    webAddress?.address !== '127.0.0.1' ||
    webAddress?.port !== webPort
  ) {
    throw new Error('Production E2E readiness is not served by the owned loopback listeners.');
  }
  if (
    healthStatus !== 200 ||
    health?.ok !== true ||
    health?.ready !== true ||
    health?.service !== 'rewind-local-runtime' ||
    health?.addresses?.local !== `http://127.0.0.1:${runtimePort}`
  ) {
    throw new Error('Production E2E runtime health does not match the owned runtime.');
  }
  const servedBuildId =
    workerStatus === 200
      ? serviceWorker.match(/const CACHE_NAME = 'rewind-shell-v3-([a-f0-9]{24})';/)?.[1]
      : null;
  if (!buildId || servedBuildId !== buildId) {
    throw new Error('Production E2E web readiness does not match the verified artifact build.');
  }
  return true;
}

async function waitForOwnedReadiness({ runtimeServer, webServer, runtimePort, webPort, buildId }) {
  const deadline = Date.now() + 15_000;
  let lastFailure = 'not reachable';
  while (Date.now() < deadline) {
    if (!runtimeServer.listening || !webServer.listening) {
      throw new Error('An owned production E2E listener stopped before readiness.');
    }
    try {
      const [healthResponse, workerResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${webPort}/api/health`, { signal: AbortSignal.timeout(1_000) }),
        fetch(`http://127.0.0.1:${webPort}/sw.js`, { signal: AbortSignal.timeout(1_000) }),
      ]);
      const [health, serviceWorker] = await Promise.all([
        healthResponse.json().catch(() => null),
        workerResponse.text(),
      ]);
      assertOwnedReadiness({
        runtimeServer,
        webServer,
        runtimePort,
        webPort,
        healthStatus: healthResponse.status,
        health,
        workerStatus: workerResponse.status,
        serviceWorker,
        buildId,
      });
      return;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : 'readiness check failed';
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Production E2E owned readiness timed out (${lastFailure}).`);
}

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'rewind-production-e2e-runtime-'));
  const inheritedCacheRoot = process.env.REWIND_E2E_ARTIFACT_CACHE_DIR;
  const artifactCacheRoot =
    inheritedCacheRoot ?? (await mkdtemp(join(tmpdir(), 'rewind-production-e2e-build-')));
  const ownsArtifactCache = !inheritedCacheRoot;
  let runtimeServer;
  let webServer;
  let database;
  let closing = false;

  async function shutdown(exitCode = 0) {
    if (closing) return;
    closing = true;
    const cleanupSteps = [
      () => closeServer(webServer),
      () => closeServer(runtimeServer),
      () => database?.close(),
      () => rm(dataDir, { recursive: true, force: true }),
      ...(ownsArtifactCache ? [() => rm(artifactCacheRoot, { recursive: true, force: true })] : []),
    ];
    let cleanupFailed = false;
    for (const cleanup of cleanupSteps) {
      try {
        await cleanup();
      } catch {
        cleanupFailed = true;
      }
    }
    process.exitCode = cleanupFailed && exitCode === 0 ? 1 : exitCode;
  }

  let stopSignal;
  const stopRequested = new Promise((resolve) => {
    process.once('SIGINT', () => {
      stopSignal = 'SIGINT';
      resolve();
    });
    process.once('SIGTERM', () => {
      stopSignal = 'SIGTERM';
      resolve();
    });
  });

  try {
    const env = localOnlyEnv({
      EXPO_PUBLIC_CAMERA_MODE: 'demo',
      EXPO_PUBLIC_LOCAL_BASE_URL: '/api',
      REWIND_E2E_ARTIFACT_CACHE_DIR: artifactCacheRoot,
    });
    // Exercise the public welcome-to-Demo route without a special production
    // entry mode enabled at build time.
    delete env.EXPO_PUBLIC_DEMO_ACCESS;
    const artifact = await ensureBuildArtifact({
      projectRoot,
      cacheRoot: artifactCacheRoot,
      env,
      mode: 'production-e2e-demo',
    });
    await assertStaticArtifact(artifact.artifactDir);

    const { parseConfig } = await import('../server/dist/config.js');
    const { openDatabase, resetDatabase } = await import('../server/dist/db.js');
    const { createRuntimeServer } = await import('../server/dist/http.js');
    const config = parseConfig({
      REWIND_DATA_DIR: dataDir,
      REWIND_HOST: '127.0.0.1',
      REWIND_PORT: '0',
      REWIND_FFMPEG_BIN: 'ffmpeg',
    });

    // Reset before opening the database so every Playwright invocation starts
    // with no retained SQLite, WAL/SHM, media, or browser-owned state.
    resetDatabase(config);
    database = openDatabase(config, { seedNow });
    seedCrossGroupBootstrap(database);
    runtimeServer = createRuntimeServer(config, database, { now: () => demoNow });
    const runtimePort = await listen(runtimeServer);
    config.port = runtimePort;
    webServer = createProductionWebServer({
      staticDir: artifact.artifactDir,
      runtimeOrigin: `http://127.0.0.1:${runtimePort}`,
    });
    const webPort = Number(process.env.REWIND_E2E_PORT || 8083);
    await listen(webServer, webPort);
    await waitForOwnedReadiness({
      runtimeServer,
      webServer,
      runtimePort,
      webPort,
      buildId: artifact.buildId,
    });
    console.log(
      `Rewind production E2E boundary ready (owner ${process.pid}, web ${webPort}, build ${artifact.buildId}).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await shutdown(1);
    return;
  }

  await stopRequested;
  await shutdown(stopSignal === 'SIGINT' ? 130 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}

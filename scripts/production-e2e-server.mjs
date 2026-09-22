import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createProductionWebServer, assertStaticArtifact } from './production-web-proxy.mjs';

const projectRoot = process.cwd();
const expoCli = join(projectRoot, 'node_modules/expo/bin/cli');
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

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ?? `code ${code}`}`));
    });
  });
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

const artifactDir = await mkdtemp(join(tmpdir(), 'rewind-production-e2e-artifact-'));
const dataDir = await mkdtemp(join(tmpdir(), 'rewind-production-e2e-runtime-'));
let runtimeServer;
let webServer;
let database;
let closing = false;

async function shutdown(exitCode = 0) {
  if (closing) return;
  closing = true;
  await closeServer(webServer);
  await closeServer(runtimeServer);
  database?.close();
  await rm(artifactDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
  process.exitCode = exitCode;
}

process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));

try {
  const env = localOnlyEnv({
    EXPO_PUBLIC_CAMERA_MODE: 'demo',
    EXPO_PUBLIC_DEMO_ACCESS: 'entry',
    EXPO_PUBLIC_LOCAL_BASE_URL: '/api',
  });
  await run(process.env.npm_execpath || 'npm', ['run', 'server:build'], env);
  await run(
    process.execPath,
    [expoCli, 'export', '--clear', '--platform', 'web', '--output-dir', artifactDir],
    env,
  );
  await assertStaticArtifact(artifactDir);

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
  webServer = createProductionWebServer({
    staticDir: artifactDir,
    runtimeOrigin: `http://127.0.0.1:${runtimePort}`,
  });
  const webPort = Number(process.env.REWIND_E2E_PORT || 8083);
  await listen(webServer, webPort);
  console.log(`Rewind local browser E2E boundary ready on http://127.0.0.1:${webPort}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await shutdown(1);
}

await new Promise(() => undefined);

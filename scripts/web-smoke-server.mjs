import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProductionWebServer, assertStaticArtifact } from './production-web-proxy.mjs';

const projectRoot = process.cwd();
const expoCli = join(projectRoot, 'node_modules/expo/bin/cli');

function run(command, args, env = process.env) {
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

async function listen(server, host = '127.0.0.1', port = 0) {
  server.listen(port, host);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Smoke server did not expose a port.');
  return address.port;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function main() {
  const artifactDir = await mkdtemp(join(tmpdir(), 'rewind-web-artifact-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'rewind-web-runtime-'));
  let runtimeServer;
  let webServer;
  let database;
  let closing = false;

  const shutdown = async (exitCode = 0) => {
    if (closing) return;
    closing = true;
    await closeServer(webServer);
    await closeServer(runtimeServer);
    database?.close();
    await rm(artifactDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
    process.exitCode = exitCode;
  };

  process.once('SIGINT', () => void shutdown(0));
  process.once('SIGTERM', () => void shutdown(0));

  try {
    await run(process.env.npm_execpath || 'npm', ['run', 'server:build']);
    await run(
      process.execPath,
      [expoCli, 'export', '--platform', 'web', '--output-dir', artifactDir],
      {
        ...process.env,
        EXPO_PUBLIC_LOCAL_BASE_URL: '/api',
      },
    );
    await assertStaticArtifact(artifactDir);

    const { parseConfig } = await import('../server/dist/config.js');
    const { openDatabase } = await import('../server/dist/db.js');
    const { createRuntimeServer } = await import('../server/dist/http.js');
    const config = parseConfig({
      REWIND_DATA_DIR: dataDir,
      REWIND_HOST: '127.0.0.1',
      REWIND_PORT: '0',
      REWIND_FFMPEG_BIN: 'ffmpeg',
    });
    database = openDatabase(config);
    runtimeServer = createRuntimeServer(config, database);
    const runtimePort = await listen(runtimeServer);
    webServer = createProductionWebServer({
      staticDir: artifactDir,
      runtimeOrigin: `http://127.0.0.1:${runtimePort}`,
    });
    const webPort = Number(process.env.REWIND_WEB_SMOKE_PORT || 8082);
    await listen(webServer, '127.0.0.1', webPort);
    console.log(`Rewind production web smoke server listening on http://127.0.0.1:${webPort}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await shutdown(1);
    return;
  }

  await new Promise(() => undefined);
}

await main();

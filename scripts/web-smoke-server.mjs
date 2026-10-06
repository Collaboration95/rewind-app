import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProductionWebServer, assertStaticArtifact } from './production-web-proxy.mjs';

const projectRoot = process.cwd();
const expoCli = join(projectRoot, 'node_modules/expo/bin/cli');
const httpsPort = Number(process.env.REWIND_WEB_SMOKE_HTTPS_PORT || 8443);

function run(command, args, env = process.env, stdio = 'inherit') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env,
      stdio,
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
  let secureWebServer;
  let database;
  let closing = false;

  const shutdown = async (exitCode = 0) => {
    if (closing) return;
    closing = true;
    await closeServer(webServer);
    await closeServer(secureWebServer);
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
    const webExportEnv = {
      ...process.env,
      EXPO_PUBLIC_LOCAL_BASE_URL: '/api',
    };
    // Responsive/browser smoke coverage must exercise the real web adapter, so a
    // caller's simulator fixture setting must not leak into this artifact.
    delete webExportEnv.EXPO_PUBLIC_CAMERA_MODE;
    await run(
      process.execPath,
      [expoCli, 'export', '--clear', '--platform', 'web', '--output-dir', artifactDir],
      webExportEnv,
    );
    await assertStaticArtifact(artifactDir);

    const { parseConfig } = await import('../server/dist/config.js');
    const { openDatabase } = await import('../server/dist/db.js');
    const { createRuntimeServer } = await import('../server/dist/http.js');
    // Production builds send real credentials only over HTTPS. The plain
    // listener proves that refusal; the HTTPS one (throwaway self-signed
    // certificate, origin-authenticated proxy) carries signed-in specs.
    const originAuthSecret = randomBytes(32).toString('base64url');
    const config = parseConfig({
      REWIND_DATA_DIR: dataDir,
      REWIND_HOST: '127.0.0.1',
      REWIND_PORT: '0',
      REWIND_FFMPEG_BIN: 'ffmpeg',
      REWIND_ALLOW_ORIGIN: `https://localhost:${httpsPort}`,
      REWIND_ORIGIN_AUTH_SECRET: originAuthSecret,
    });
    database = openDatabase(config);
    runtimeServer = createRuntimeServer(config, database);
    const runtimeOrigin = `http://127.0.0.1:${await listen(runtimeServer)}`;
    webServer = createProductionWebServer({ staticDir: artifactDir, runtimeOrigin });
    const webPort = Number(process.env.REWIND_WEB_SMOKE_PORT || 8082);
    await listen(webServer, '127.0.0.1', webPort);

    const key = join(dataDir, 'tls.key');
    const cert = join(dataDir, 'tls.crt');
    await run(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '2',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      process.env,
      'ignore',
    );
    secureWebServer = createProductionWebServer({
      staticDir: artifactDir,
      runtimeOrigin,
      tls: { key: await readFile(key), cert: await readFile(cert) },
      originAuthSecret,
    });
    await listen(secureWebServer, '127.0.0.1', httpsPort);
    console.log(
      `Rewind production web smoke server listening on http://127.0.0.1:${webPort} and https://localhost:${httpsPort}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await shutdown(1);
    return;
  }

  await new Promise(() => undefined);
}

await main();

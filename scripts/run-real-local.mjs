// Run the real-account app locally: the server with SQLite in .local-data/real
// and Expo web with the Demo disabled, behind one same-origin dev proxy:
// /api/* goes to the server and everything else to Metro. Real sign-in
// normally requires HTTPS; REWIND_ALLOW_INSECURE_LOCAL_AUTH and the client's
// dev-build loopback exception permit plain HTTP only on localhost, so this is
// for a browser on this Mac, not a phone.
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiTarget } from './production-web-proxy.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiPort = Number(process.env.REWIND_PORT || 8787);
const metroPort = Number(process.env.REWIND_METRO_PORT || 8081);
const appPort = Number(process.env.REWIND_WEB_PORT || 8090);
const runtimeOrigin = `http://127.0.0.1:${apiPort}`;

const runtimeEnv = {
  ...process.env,
  REWIND_HOST: '127.0.0.1',
  REWIND_PORT: String(apiPort),
  REWIND_DATA_DIR: process.env.REWIND_DATA_DIR || resolve(projectRoot, '.local-data/real'),
  REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true',
  REWIND_ALLOW_ORIGIN: `http://localhost:${appPort}`,
};
const expoEnv = {
  ...process.env,
  EXPO_PUBLIC_LOCAL_BASE_URL: '/api',
  EXPO_PUBLIC_DEMO_ACCESS: 'disabled',
  EXPO_PUBLIC_CAMERA_MODE: process.env.EXPO_PUBLIC_CAMERA_MODE || '',
};

const children = new Set();
let stopping = false;

function start(command, args, env) {
  const child = spawn(command, args, { cwd: projectRoot, env, stdio: 'inherit' });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGINT');
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
process.once('exit', stop);

const exited = (child) =>
  new Promise((done, fail) => {
    child.once('error', fail);
    child.once('exit', (code) => done(code));
  });

async function waitForHealth(child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`The server exited. Is port ${apiPort} in use?`);
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((wait) => setTimeout(wait, 200));
  }
  throw new Error('The server did not become healthy within 10 seconds.');
}

// Same-origin dev proxy. The Host header is kept so the server sees a
// loopback request for localhost and applies its local-HTTP auth exception.
function startProxy() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    const target = isApi
      ? apiTarget(runtimeOrigin, url)
      : new URL(url.pathname + url.search, `http://127.0.0.1:${metroPort}`);
    const upstream = httpRequest(
      target,
      { method: request.method, headers: request.headers },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.once('error', () => {
      if (!response.headersSent) response.writeHead(502).end('Upstream unavailable');
      else response.destroy();
    });
    request.pipe(upstream);
  });
  // Metro's hot-reload WebSocket.
  server.on('upgrade', (request, socket, head) => {
    const upstream = connect(metroPort, '127.0.0.1', () => {
      const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  server.listen(appPort, '127.0.0.1');
  return server;
}

try {
  if ((await exited(start('npm', ['run', 'server:build'], runtimeEnv))) !== 0) {
    throw new Error('Server build failed.');
  }
  const runtime = start(process.execPath, ['server/dist/cli.js', 'start'], runtimeEnv);
  await waitForHealth(runtime);
  const proxy = startProxy();
  process.once('exit', () => proxy.close());
  console.log(`\nServer data: ${runtimeEnv.REWIND_DATA_DIR}`);
  console.log(`Open http://localhost:${appPort} and create test accounts on the sign-in screen.`);
  console.log('Press Ctrl-C to stop.\n');
  const expo = start(
    process.execPath,
    ['node_modules/expo/bin/cli', 'start', '--web', '--port', String(metroPort)],
    expoEnv,
  );
  const code = await exited(expo);
  if (code !== 0 && !stopping) process.exitCode = code || 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  stop();
}

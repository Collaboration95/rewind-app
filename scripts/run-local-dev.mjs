import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const port = Number(process.env.REWIND_PORT || 8787);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error('REWIND_PORT must be an integer from 1 to 65535.');
  process.exit(1);
}

function lanAddress() {
  const override = process.env.REWIND_LAN_IP?.trim();
  if (override) {
    if (isIP(override) !== 4 || override.startsWith('127.')) {
      throw new Error('REWIND_LAN_IP must be a non-loopback IPv4 address reachable by your phone.');
    }
    return override;
  }

  const interfaces = networkInterfaces();
  const names = Object.keys(interfaces).sort((a, b) => {
    const rank = (name) =>
      /^(en0|wlan0|wi-fi)$/i.test(name) ? 0 : /^(en|eth)/i.test(name) ? 1 : 2;
    return rank(a) - rank(b);
  });
  for (const name of names) {
    if (/^(utun|tun|tap|docker|vbox|bridge)/i.test(name)) continue;
    for (const address of interfaces[name] ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  throw new Error('No LAN IPv4 address found. Connect to Wi-Fi or set REWIND_LAN_IP.');
}

let ip;
try {
  ip = lanAddress();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const runtimeUrl = `http://${ip}:${port}`;
const runtimeEnv = { ...process.env, REWIND_HOST: '0.0.0.0', REWIND_PORT: String(port) };
const expoEnv = {
  ...process.env,
  EXPO_PUBLIC_LOCAL_BASE_URL: runtimeUrl,
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

function waitForExit(child) {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

async function waitForHealth(child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        'The local runtime exited before it became healthy. Is port 8787 already in use?',
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      const body = await response.json();
      if (response.ok && body.ok === true) return;
    } catch {
      // The runtime may still be starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error('The local runtime did not become healthy within 10 seconds.');
}

try {
  console.log(
    `Using LAN address ${ip}. Override with REWIND_LAN_IP if your phone uses another network.`,
  );
  try {
    const existing = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(750),
    });
    if (existing.status) {
      throw new Error(
        `Port ${port} already has a runtime. Stop it so this run uses the current code.`,
      );
    }
  } catch (error) {
    if (error.message.startsWith(`Port ${port} already`)) throw error;
  }
  const build = start('npm', ['run', 'server:build'], runtimeEnv);
  const buildResult = await waitForExit(build);
  if (buildResult.code !== 0) throw new Error('Server build failed.');

  const runtime = start(process.execPath, ['server/dist/cli.js', 'start'], runtimeEnv);
  await waitForHealth(runtime);
  console.log(`\nBackend: ${runtimeUrl}/health`);
  console.log('Open that URL in iPhone Safari to check LAN access.');
  console.log(
    'Sign in to the same Expo account in the CLI and Expo Go, then scan the Expo QR code.',
  );
  console.log(
    'Press w in Expo for the web UI using this same backend. Press Ctrl-C to stop both.\n',
  );

  const expo = start(process.execPath, ['node_modules/expo/bin/cli', 'start', '--lan'], expoEnv);
  const result = await waitForExit(expo);
  if (result.code !== 0 && !stopping) process.exitCode = result.code || 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  stop();
}

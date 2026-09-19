#!/usr/bin/env node

/**
 * Run the production-shaped runtime lifecycle against disposable local state.
 *
 * This intentionally exercises only the Compose runtime service. The web
 * image, AWS CLI, normal host mounts, and public URLs are not part of this
 * proof. Every mutable path is created below a fresh operating-system temp
 * directory and is removed in the finalizer.
 */

import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const COMPOSE_FILE = resolve(REPO_ROOT, 'deploy/compose.yaml');
const DEFAULT_TIMEOUT_SECONDS = 300;
const COMMAND_OUTPUT_LIMIT = 96 * 1024;
const HEALTH_POLL_MS = 250;

export class LifecycleSmokeError extends Error {
  constructor(stage, message) {
    super(message);
    this.name = 'LifecycleSmokeError';
    this.stage = stage;
  }
}

function parseTimeout(argv, env) {
  const flagIndex = argv.indexOf('--timeout-seconds');
  const raw = flagIndex === -1 ? env.REWIND_LIFECYCLE_TIMEOUT_SECONDS : argv[flagIndex + 1];
  const value = raw === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(raw);
  if (!Number.isInteger(value) || value < 15 || value > 900) {
    throw new LifecycleSmokeError(
      'configuration',
      'timeout must be an integer from 15 to 900 seconds',
    );
  }
  return value * 1000;
}

function assertDisposableTempBase(base) {
  const normalized = resolve(base);
  if (
    normalized === '/srv/rewind' ||
    normalized === '/srv' ||
    normalized === '/var' ||
    normalized === '/home' ||
    normalized === '/Users' ||
    normalized === REPO_ROOT
  ) {
    throw new LifecycleSmokeError(
      'configuration',
      'the operating-system temporary directory is not disposable for this harness',
    );
  }
}

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!port) throw new LifecycleSmokeError('configuration', 'could not reserve a loopback port');
  return port;
}

function appendOutput(target, chunk) {
  if (target.length >= COMMAND_OUTPUT_LIMIT) return target;
  const value = chunk.toString();
  return `${target}${value}`.slice(-COMMAND_OUTPUT_LIMIT);
}

function killProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

function runProcess(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ...result, stdout, stderr, timedOut });
    };

    child.once('error', (error) => {
      finish({ status: null, error });
    });
    child.stdout.on('data', (chunk) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.once('close', (status, signal) => {
      finish({ status, signal });
    });

    const timer = setTimeout(
      () => {
        timedOut = true;
        killProcessGroup(child, 'SIGTERM');
        setTimeout(() => {
          if (!settled) {
            killProcessGroup(child, 'SIGKILL');
            finish({ status: null, signal: 'SIGKILL' });
          }
        }, 1500).unref();
      },
      Math.max(1, timeoutMs),
    );
    timer.unref();
  });
}

export function redactDiagnostics(input, secrets = []) {
  let value = String(input ?? '');
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    value = value.split(String(secret)).join('[REDACTED]');
  }

  // Do not print host/container paths, even when a failed Compose command does.
  value = value.replace(
    /(?:\/(?:Users|home|private|tmp|var|srv|opt|app|workspace|Volumes|run)(?:[^\s'"`<>]*)|[A-Za-z]:\\[^\s'"`<>]*)/g,
    '[REDACTED_PATH]',
  );
  // Do not print values from environment-style diagnostics.
  value = value.replace(
    /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY|VALUE|URL|DIR|FILE|PROFILE|ORIGIN|CODE|BUCKET|PREFIX|PORT))=([^\s]+)/g,
    '$1=[REDACTED_VALUE]',
  );
  // Invitation/capability codes are never useful in CI diagnostics.
  value = value.replace(
    /\b((?:invitation|invite)(?:[-_ ]?code)?|capability[-_ ]?code)\s*[:=]?\s*[A-Za-z0-9][A-Za-z0-9_-]{3,}/gi,
    '$1=[REDACTED_CODE]',
  );
  // Media is asserted by exit status and filename, never by content.
  value = value.replace(
    /\b[^\s'"`<>]+\.(?:mp4|mov|webm|mkv|jpg|jpeg|png|heic|gif|media|tar\.gz)\b/gi,
    '[REDACTED_MEDIA]',
  );
  return value;
}

function safeCommandOutput(result, secrets) {
  return redactDiagnostics(`${result.stdout}\n${result.stderr}`, secrets).trim();
}

function remainingMs(context) {
  return context.deadline - Date.now();
}

async function compose(context, stage, args, timeoutMs = remainingMs(context)) {
  if (timeoutMs <= 0) throw new LifecycleSmokeError(stage, 'lifecycle deadline exceeded');
  const result = await runProcess(
    'docker',
    [
      'compose',
      '--project-name',
      context.projectName,
      '--env-file',
      context.envFile,
      '--file',
      COMPOSE_FILE,
      ...args,
    ],
    {
      cwd: REPO_ROOT,
      env: context.env,
      timeoutMs,
    },
  );
  context.commands.push({ stage, result });
  if (result.error) {
    throw new LifecycleSmokeError(stage, 'Docker Compose could not be started');
  }
  if (result.timedOut) {
    throw new LifecycleSmokeError(stage, 'Docker Compose command timed out');
  }
  if (result.status !== 0) {
    throw new LifecycleSmokeError(
      stage,
      `Docker Compose command failed with status ${result.status}`,
    );
  }
  return result;
}

async function composeBestEffort(context, stage, args, timeoutMs) {
  try {
    const result = await compose(context, stage, args, timeoutMs);
    return result;
  } catch {
    return null;
  }
}

async function requestJson(context, stage, pathname, options = {}, expectedStatus = 200) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(3000, Math.max(1, remainingMs(context))),
  );
  try {
    const response = await fetch(`http://127.0.0.1:${context.runtimePort}${pathname}`, {
      ...options,
      signal: controller.signal,
      headers: { ...(options.headers ?? {}), Accept: 'application/json' },
    });
    const body = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      // The assertion below reports a safe status-only failure.
    }
    if (response.status !== expectedStatus) {
      throw new LifecycleSmokeError(
        stage,
        `HTTP status ${response.status}; expected ${expectedStatus}`,
      );
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new LifecycleSmokeError(stage, 'runtime returned a non-JSON response');
    }
    return parsed;
  } catch (error) {
    if (error instanceof LifecycleSmokeError) throw error;
    throw new LifecycleSmokeError(stage, 'runtime request did not complete');
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(context, stage) {
  let lastError = null;
  while (remainingMs(context) > 0) {
    try {
      const payload = await requestJson(context, stage, '/health');
      if (
        payload.ready === true &&
        payload.checks?.schema?.ready === true &&
        Array.isArray(payload.checks.schema.missingMigrationKeys) &&
        payload.checks.schema.missingMigrationKeys.length === 0
      ) {
        return payload;
      }
      lastError = new LifecycleSmokeError(stage, 'runtime health was not ready');
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, HEALTH_POLL_MS));
  }
  throw new LifecycleSmokeError(stage, lastError?.message ?? 'runtime health timed out');
}

async function createContext(timeoutMs, baseEnv = process.env) {
  const tempBase = tmpdir();
  assertDisposableTempBase(tempBase);
  const root = await mkdtemp(join(tempBase, 'rewind-lifecycle-'));
  try {
    const dataDir = join(root, 'data');
    const mediaDir = join(root, 'media');
    await mkdir(dataDir, { mode: 0o777 });
    await mkdir(mediaDir, { mode: 0o777 });
    await chmod(dataDir, 0o777);
    await chmod(mediaDir, 0o777);

    const runtimePort = await freeLoopbackPort();
    const webPort = await freeLoopbackPort();
    const projectName = `rewind-lifecycle-${process.pid}-${Date.now()}`.toLowerCase();
    const envFile = join(root, 'compose.env');
    const envValues = {
      REWIND_DATA_HOST_DIR: dataDir,
      REWIND_MEDIA_HOST_DIR: mediaDir,
      REWIND_CONTAINER_NAME: `${projectName}-runtime`,
      REWIND_WEB_CONTAINER_NAME: `${projectName}-web`,
      REWIND_RUNTIME_PORT: String(runtimePort),
      REWIND_WEB_PORT: String(webPort),
    };
    await writeFile(
      envFile,
      `${Object.entries(envValues)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
      { mode: 0o600 },
    );

    const env = {
      ...baseEnv,
      ...envValues,
      COMPOSE_PROJECT_NAME: projectName,
      // Make accidental cloud integrations impossible for this local proof.
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_PROFILE: '',
    };
    const context = {
      root,
      dataDir,
      mediaDir,
      envFile,
      runtimePort,
      projectName,
      env,
      deadline: Date.now() + timeoutMs,
      commands: [],
      secrets: [
        root,
        dataDir,
        mediaDir,
        envFile,
        ...Object.values(envValues),
        'disposable-media-sentinel',
        'non-demo-sentinel',
      ],
    };

    const version = await runProcess('docker', ['compose', 'version'], {
      cwd: REPO_ROOT,
      env,
      timeoutMs: Math.min(5000, timeoutMs),
    });
    if (version.error || version.timedOut || version.status !== 0) {
      throw new LifecycleSmokeError('configuration', 'Docker Compose is required');
    }
    return context;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function writeLifecycleFixtures(context) {
  await compose(context, 'write persistence fixtures', [
    'exec',
    '--no-TTY',
    'runtime',
    'sh',
    '-c',
    "printf '%s' 'disposable-media-sentinel' > /var/lib/rewind/media/lifecycle-media.bin && printf '%s' 'non-demo-sentinel' > /var/lib/rewind/non-demo-sentinel.txt",
  ]);
}

async function assertPersistenceFixtures(context, stage) {
  await compose(context, stage, [
    'exec',
    '--no-TTY',
    'runtime',
    'sh',
    '-c',
    'test -f /var/lib/rewind/media/lifecycle-media.bin && test -f /var/lib/rewind/non-demo-sentinel.txt',
  ]);
}

async function assertResetFixtures(context) {
  await compose(context, 'assert reset cleanup', [
    'exec',
    '--no-TTY',
    'runtime',
    'sh',
    '-c',
    '! test -e /var/lib/rewind/media/lifecycle-media.bin && test -f /var/lib/rewind/non-demo-sentinel.txt && test -d /var/lib/rewind/media/staging',
  ]);
}

async function runLifecycle(context) {
  await compose(context, 'compose configuration', ['config', '--quiet']);
  await compose(context, 'build runtime image', ['build', 'runtime']);
  await compose(context, 'migrate and seed', ['run', '--rm', '--no-deps', 'runtime', 'migrate']);
  await compose(context, 'start runtime', ['up', '--detach', 'runtime']);
  await waitForHealth(context, 'initial health');

  const profiles = await requestJson(context, 'seed verification', '/profiles');
  if (!Array.isArray(profiles.profiles) || profiles.profiles.length !== 5) {
    throw new LifecycleSmokeError('seed verification', 'deterministic Demo fixture was not seeded');
  }
  const session = await requestJson(
    context,
    'owner session creation',
    '/sessions/demo',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'demo-1' }),
    },
    201,
  );
  const sessionId = typeof session.session?.id === 'string' ? session.session.id : '';
  if (!sessionId)
    throw new LifecycleSmokeError('owner session creation', 'owner session was not created');
  context.secrets.push(sessionId);
  await writeLifecycleFixtures(context);

  await compose(context, 'stop runtime for restart', ['stop', 'runtime']);
  await compose(context, 'restart runtime', ['up', '--detach', 'runtime']);
  await waitForHealth(context, 'post-restart health');
  await requestJson(context, 'session persistence', `/sessions/${encodeURIComponent(sessionId)}`);
  await assertPersistenceFixtures(context, 'restart persistence');

  const reset = await requestJson(
    context,
    'owner reset',
    `/demo/reset?sessionId=${encodeURIComponent(sessionId)}`,
    { method: 'POST' },
  );
  if (reset.reset !== true)
    throw new LifecycleSmokeError('owner reset', 'owner reset was not acknowledged');
  await assertResetFixtures(context);
  await waitForHealth(context, 'post-reset health');
  const postResetProfiles = await requestJson(context, 'post-reset fixture', '/profiles');
  if (!Array.isArray(postResetProfiles.profiles) || postResetProfiles.profiles.length !== 5) {
    throw new LifecycleSmokeError(
      'post-reset fixture',
      'Demo fixture was not restored after owner reset',
    );
  }
}

async function collectDiagnostics(context) {
  const diagnostics = [];
  const ps = await composeBestEffort(context, 'diagnostic compose ps', ['ps', '--all'], 5000);
  if (ps) diagnostics.push(`compose ps:\n${safeCommandOutput(ps, context.secrets)}`);
  const logs = await composeBestEffort(
    context,
    'diagnostic compose logs',
    ['logs', '--no-color', '--tail', '80', 'runtime'],
    5000,
  );
  if (logs) diagnostics.push(`compose logs:\n${safeCommandOutput(logs, context.secrets)}`);
  return diagnostics.filter((item) => item.trim()).join('\n');
}

async function cleanupContext(context, failure) {
  if (failure) {
    const diagnostics = await collectDiagnostics(context);
    if (diagnostics) {
      console.error('--- redacted lifecycle diagnostics ---');
      console.error(diagnostics);
      console.error('--- end redacted lifecycle diagnostics ---');
    }
  }
  await composeBestEffort(
    context,
    'cleanup Compose project',
    ['down', '--volumes', '--remove-orphans'],
    15_000,
  );
  await rm(context.root, { recursive: true, force: true });
}

export async function runLifecycleSmoke(argv = [], env = process.env) {
  const timeoutMs = parseTimeout(argv, env);
  let context;
  let cleaned = false;
  try {
    context = await createContext(timeoutMs, env);
    await runLifecycle(context);
    return { ok: true, timeoutMs };
  } catch (error) {
    if (context) {
      const safeError =
        error instanceof LifecycleSmokeError
          ? error
          : new LifecycleSmokeError('runtime', 'lifecycle smoke failed');
      await cleanupContext(context, safeError);
      cleaned = true;
      console.error(`Lifecycle smoke failed during ${safeError.stage}: ${safeError.message}.`);
    }
    throw error;
  } finally {
    if (context && !cleaned) {
      // Successful runs also remove the Compose project before deleting the
      // temp directory, so no disposable container or volume is retained.
      await cleanupContext(context, null);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log('Usage: deploy/lifecycle-smoke.mjs [--timeout-seconds N]');
    console.log('Runs a disposable local Compose migrate/seed/restart/reset lifecycle.');
    return;
  }
  await runLifecycleSmoke(argv);
  console.log(
    'Lifecycle smoke passed: migrate, seed, health, restart persistence, owner reset, post-reset health.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    if (error instanceof LifecycleSmokeError && error.stage === 'configuration') {
      console.error(`Lifecycle smoke failed during configuration: ${error.message}.`);
    } else if (!(error instanceof LifecycleSmokeError)) {
      console.error('Lifecycle smoke failed unexpectedly.');
    }
    process.exitCode = 1;
  });
}

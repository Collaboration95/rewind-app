import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { redactDiagnostics, runLifecycleSmoke } from '../../deploy/lifecycle-smoke.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const execFileAsync = promisify(execFile);

test('resolved Compose keeps local ports private and exposes only the hosted web origin', async () => {
  // Resolve only checked-in examples/defaults, without inherited deployment overrides.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(REWIND_|COMPOSE_)/.test(key)),
  );
  for (const [envFile, hostIp, port] of [
    ['/dev/null', '127.0.0.1', '8080'],
    [join(REPO_ROOT, 'deploy/rewind.env.example'), '0.0.0.0', '80'],
  ]) {
    const { stdout } = await execFileAsync(
      'docker',
      [
        'compose',
        '--env-file',
        envFile,
        '-f',
        join(REPO_ROOT, 'deploy/compose.yaml'),
        'config',
        '--format',
        'json',
      ],
      { cwd: REPO_ROOT, env },
    );
    const { services } = JSON.parse(stdout);
    const ports = (service) =>
      service.ports.map(({ host_ip, published, target }) => ({ host_ip, published, target }));
    assert.deepEqual(ports(services.web), [{ host_ip: hostIp, published: port, target: 8080 }]);
    assert.deepEqual(ports(services.runtime), [
      { host_ip: '127.0.0.1', published: '8787', target: 8787 },
    ]);
  }
});

test('resolved Compose preserves explicit HTTP request bounds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rewind-compose-http-limits-'));
  const envFile = join(root, 'rewind.env');
  await writeFile(
    envFile,
    [
      'REWIND_HTTP_IDLE_TIMEOUT_MS=11001',
      'REWIND_HTTP_UPLOAD_TIMEOUT_MS=22002',
      'REWIND_HTTP_MAX_CONCURRENT_INTAKES=3',
      'REWIND_HTTP_MAX_CONCURRENT_PROCESSING=4',
      '',
    ].join('\n'),
  );
  try {
    const { stdout } = await execFileAsync(
      'docker',
      [
        'compose',
        '--env-file',
        envFile,
        '-f',
        join(REPO_ROOT, 'deploy/compose.yaml'),
        'config',
        '--format',
        'json',
      ],
      { cwd: REPO_ROOT },
    );
    const resolved = JSON.parse(stdout);
    assert.deepEqual(
      {
        idle: resolved.services.runtime.environment.REWIND_HTTP_IDLE_TIMEOUT_MS,
        upload: resolved.services.runtime.environment.REWIND_HTTP_UPLOAD_TIMEOUT_MS,
        intake: resolved.services.runtime.environment.REWIND_HTTP_MAX_CONCURRENT_INTAKES,
        processing: resolved.services.runtime.environment.REWIND_HTTP_MAX_CONCURRENT_PROCESSING,
      },
      { idle: '11001', upload: '22002', intake: '3', processing: '4' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lifecycle smoke contract is disposable, bounded, and Compose-isolated', async () => {
  const [script, compose, readme, packageJson] = await Promise.all([
    readFile(join(REPO_ROOT, 'deploy/lifecycle-smoke.mjs'), 'utf8'),
    readFile(join(REPO_ROOT, 'deploy/compose.yaml'), 'utf8'),
    readFile(join(REPO_ROOT, 'deploy/README.md'), 'utf8'),
    readFile(join(REPO_ROOT, 'package.json'), 'utf8'),
  ]);

  assert.match(script, /mkdtemp\(/);
  assert.match(script, /--project-name/);
  assert.match(script, /--env-file/);
  assert.match(script, /build runtime image/);
  assert.match(script, /migrate and seed/);
  assert.match(script, /initial health/);
  assert.match(script, /restart persistence/);
  assert.match(script, /owner reset/);
  assert.match(script, /post-reset health/);
  assert.match(script, /setTimeout\(/);
  assert.match(script, /finally/);
  assert.match(script, /--volumes/);
  assert.match(script, /--remove-orphans/);
  assert.match(script, /redactDiagnostics/);
  assert.match(script, /REWIND_DATA_HOST_DIR/);
  assert.match(script, /REWIND_MEDIA_HOST_DIR/);
  assert.match(compose, /REWIND_RUNTIME_PORT:-8787/);
  assert.match(readme, /npm run test:host-lifecycle/);
  assert.equal(
    JSON.parse(packageJson).scripts['test:host-lifecycle'],
    'node deploy/lifecycle-smoke.mjs',
  );
});

test('failure diagnostics redact paths, environment values, invitation codes, and media content', () => {
  const raw = [
    'path=/tmp/rewind-lifecycle-secret/data',
    'REWIND_DATA_HOST_DIR=/tmp/rewind-lifecycle-secret/data',
    'invitation code INVITE-SECRET-1234',
    'media disposable-media-secret.mp4',
    'MEDIA_CONTENT_SECRET',
  ].join('\n');
  const redacted = redactDiagnostics(raw, ['MEDIA_CONTENT_SECRET']);

  assert.doesNotMatch(
    redacted,
    /rewind-lifecycle-secret|INVITE-SECRET-1234|disposable-media-secret|MEDIA_CONTENT_SECRET/,
  );
  assert.match(redacted, /REDACTED_PATH/);
  assert.match(redacted, /REDACTED_VALUE|REDACTED_CODE|REDACTED_MEDIA/);
});

test('a failed Compose assertion still removes its project and emits only redacted diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rewind-lifecycle-contract-'));
  const fakeBin = join(root, 'bin');
  const logPath = join(root, 'docker.log');
  await mkdirForTest(fakeBin);
  const fakeDocker = join(fakeBin, 'docker');
  await writeFile(
    fakeDocker,
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
printf 'WEB_BIND=%s WEB_PORT=%s\\n' "$REWIND_WEB_BIND_ADDRESS" "$REWIND_WEB_PORT" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *" compose version"*) exit 0 ;;
  *" build runtime"*)
    printf 'path=%s REWIND_DATA_HOST_DIR=%s invitation code INVITE-SECRET-1234 media disposable-media-sentinel.mp4\\n' "$REWIND_DATA_HOST_DIR" "$REWIND_DATA_HOST_DIR" >&2
    exit 42
    ;;
  *" logs "*)
    printf 'path=%s REWIND_DATA_HOST_DIR=%s invitation code INVITE-SECRET-1234 media disposable-media-sentinel.mp4\\n' "$REWIND_DATA_HOST_DIR" "$REWIND_DATA_HOST_DIR"
    exit 0
    ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  await chmod(fakeDocker, 0o755);

  const output = [];
  const originalError = console.error;
  console.error = (...args) => output.push(args.join(' '));
  try {
    await assert.rejects(
      runLifecycleSmoke([], {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        FAKE_DOCKER_LOG: logPath,
        REWIND_WEB_BIND_ADDRESS: '0.0.0.0',
        REWIND_WEB_PORT: '80',
      }),
      /status 42/,
    );
  } finally {
    console.error = originalError;
  }

  const printed = output.join('\n');
  assert.doesNotMatch(
    printed,
    /rewind-lifecycle-|INVITE-SECRET-1234|disposable-media-sentinel\.mp4|REWIND_DATA_HOST_DIR=\/|\/tmp\//,
  );
  assert.match(printed, /redacted lifecycle diagnostics/);
  assert.match(printed, /REDACTED_PATH|REDACTED_VALUE|REDACTED_CODE|REDACTED_MEDIA/);

  const log = await readFile(logPath, 'utf8');
  assert.match(log, /WEB_BIND=127\.0\.0\.1 WEB_PORT=\d+/);
  assert.doesNotMatch(log, /WEB_BIND=0\.0\.0\.0|WEB_PORT=80(?:\s|$)/);
  assert.match(log, /down .*--volumes .*--remove-orphans/);
  const envFileMatch = log.match(/--env-file (\S+)/);
  assert.ok(envFileMatch, 'fake Compose should receive the disposable env file');
  await assert.rejects(access(dirname(envFileMatch[1])), /ENOENT/);

  await rm(root, { recursive: true, force: true });
});

async function mkdirForTest(path) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path, { recursive: true });
}

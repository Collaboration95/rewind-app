import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import test from 'node:test';

import { redactDiagnostics, runLifecycleSmoke } from '../../deploy/lifecycle-smoke.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

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

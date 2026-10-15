import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const target = (overrides = {}) =>
  spawnSync('bash', ['deploy/database-target.sh'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      TARGET_ENVIRONMENT: 'release',
      GITHUB_REF: 'refs/heads/main',
      REWIND_DEPLOY_INSTANCE: 'rewind-release',
      REWIND_DEPLOY_ROLE_ARN: 'arn:aws:iam::330599756236:role/rewind-release-deploy',
      AWS_REGION: 'ap-southeast-1',
      OPERATION: 'status',
      ...overrides,
    },
  });

test('database operations accept only matched environment/branch/host/role/region', () => {
  assert.equal(target().status, 0);
  assert.equal(
    target({
      TARGET_ENVIRONMENT: 'dev',
      GITHUB_REF: 'refs/heads/dev',
      REWIND_DEPLOY_INSTANCE: 'rewind-demo',
      REWIND_DEPLOY_ROLE_ARN: 'arn:aws:iam::330599756236:role/rewind-demo-deploy',
    }).status,
    0,
  );
  for (const invalid of [
    { TARGET_ENVIRONMENT: '' },
    { TARGET_ENVIRONMENT: 'prod' },
    { GITHUB_REF: 'refs/heads/dev' },
    { REWIND_DEPLOY_INSTANCE: 'rewind-demo' },
    { REWIND_DEPLOY_ROLE_ARN: 'arn:aws:iam::330599756236:role/rewind-demo-deploy' },
    { AWS_REGION: 'us-east-1' },
    {
      OPERATION: 'bootstrap',
      REWIND_DATABASE_BOOTSTRAP_URI:
        's3://rewind-dev-media-330599756236/_config/dev-database-bootstrap.env',
    },
  ]) {
    assert.notEqual(target(invalid).status, 0, JSON.stringify(invalid));
  }
});

test('host refuses cross-environment and missing release backup settings before Docker', () => {
  for (const settings of [
    'REWIND_MEDIA_ENVIRONMENT=dev; REWIND_DATABASE_ENVIRONMENT=dev; REWIND_OPERATION_ENVIRONMENT=release',
    'REWIND_MEDIA_ENVIRONMENT=release; REWIND_DATABASE_ENVIRONMENT=release',
    'REWIND_MEDIA_ENVIRONMENT=release; REWIND_DATABASE_ENVIRONMENT=dev',
  ]) {
    const result = spawnSync(
      'bash',
      ['-c', `source deploy/operator-common.sh; ${settings}; require_database_target`],
      { cwd: root, encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
  }
});

test('quiesce stops timer and every runtime writer, and a failed drain stays recoverable', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rewind-database-maintenance-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const log = path.join(dir, 'calls');
    writeFileSync(path.join(dir, 'current-release'), 'fixture');
    writeFileSync(
      path.join(dir, 'rewind.env'),
      'REWIND_MEDIA_ENVIRONMENT=release\nREWIND_DATABASE_ENVIRONMENT=release\nREWIND_BACKUP_BUCKET=rewind-release-backups-330599756236\nREWIND_BACKUP_PREFIX=rewind-release\n',
    );
    writeFileSync(path.join(dir, 'compose.yaml'), '');
    writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n', {
      mode: 0o755,
    });
    writeFileSync(
      path.join(bin, 'docker'),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in *'ps --status running --services'*) [ "$STILL_RUNNING" != 1 ] || echo runtime ;; esac
`,
      { mode: 0o755 },
    );
    const invoke = (extra = {}) =>
      spawnSync('bash', ['deploy/database-maintenance.sh', 'quiesce'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          HOST_ROOT: dir,
          COMPOSE_FILE: path.join(dir, 'compose.yaml'),
          CALLS: log,
          REWIND_OPERATION_ENVIRONMENT: 'release',
          ...extra,
        },
      });
    assert.equal(invoke().status, 0);
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, /systemctl stop rewind-backup.timer rewind-backup.service/);
    assert.match(calls, /stop --timeout 120 web runtime/);
    assert.ok(calls.indexOf('systemctl stop') < calls.indexOf('stop --timeout'));
    assert.equal(readFileSync(path.join(dir, 'database-maintenance'), 'utf8').trim(), 'release');
    assert.notEqual(invoke({ STILL_RUNNING: '1' }).status, 0);
    assert.equal(readFileSync(path.join(dir, 'database-maintenance'), 'utf8').trim(), 'release');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

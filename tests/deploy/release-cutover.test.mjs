import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'rewind-release-cutover-'));
  const settings = (selected = '', environment = 'release') =>
    `REWIND_AUTH_PASSWORD=false\nREWIND_MEDIA_ENVIRONMENT=${environment}\nREWIND_DATABASE_ENVIRONMENT=release\nREWIND_BACKUP_BUCKET=rewind-release-backups-330599756236\nREWIND_BACKUP_PREFIX=rewind-release\nREWIND_DATABASE_APP_URL=postgres://fixture@release/rewind\nREWIND_DATABASE_URL=${selected}\n`;
  writeFileSync(path.join(dir, 'settings'), settings());
  writeFileSync(path.join(dir, 'bootstrap'), 'REWIND_DATABASE_ADMIN_URL=fixture-secret\n');
  writeFileSync(
    path.join(dir, 'aws'),
    `#!/bin/sh
printf 'aws %s\n' "$*" >> "$CALLS"
[ "$SLOW_DOWNLOAD" != 1 ] || /bin/sleep 2
case "$*" in
  *release-database-bootstrap.env*) cat "$FIXTURE/bootstrap" ;;
  *) cat "$FIXTURE/settings" ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(dir, 'ssh'),
    `#!/bin/sh
printf 'ssh %s\n' "$*" >> "$CALLS"
case "$*" in
  *database-status.sh*) printf '{"engine":"postgresql","ready":true,"environment":"release"}\n' ;;
  *database-bootstrap.sh*) cat > "$FIXTURE/bootstrap-input"; [ "$FAIL_BOOTSTRAP" != 1 ] ;;
  *'bash -s'*) cat > "$FIXTURE/import-script" ;;
  *configure*) cat > "$FIXTURE/configure-input" ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(path.join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return {
    dir,
    settings,
    run(mode, extra = {}) {
      return spawnSync('bash', ['deploy/release-cutover.sh', mode], {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          FIXTURE: dir,
          CALLS: path.join(dir, 'calls'),
          GITHUB_REF: 'refs/heads/main',
          REWIND_DEPLOY_INSTANCE: 'rewind-release',
          REWIND_DEPLOY_ROLE_ARN: 'arn:aws:iam::330599756236:role/rewind-release-deploy',
          AWS_REGION: 'ap-southeast-1',
          REWIND_HOSTED_ENV_URI: 's3://rewind-release-media-330599756236/_config/release.env',
          REWIND_DATABASE_BOOTSTRAP_URI:
            's3://rewind-release-media-330599756236/_config/release-database-bootstrap.env',
          REWIND_SSH_OPTS: '-o BatchMode=yes',
          REWIND_HOST_IP: '192.0.2.1',
          REWIND_RELEASE_BUNDLE_SHA256: 'a'.repeat(64),
          REWIND_RELEASE_CUTOVER_WAIT_SECONDS: '1',
          ...extra,
        },
      });
    },
    calls() {
      return existsSync(path.join(dir, 'calls'))
        ? readFileSync(path.join(dir, 'calls'), 'utf8')
        : '';
    },
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('combined release cutover preserves the existing protected ordering and streams secrets privately', () => {
  const f = fixture();
  try {
    const result = f.run('reconcile');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RELEASE_CUTOVER_RECONCILED/);
    assert.doesNotMatch(result.stdout + result.stderr + f.calls(), /fixture-secret/);
    assert.equal(
      readFileSync(path.join(f.dir, 'bootstrap-input'), 'utf8'),
      'REWIND_DATABASE_ADMIN_URL=fixture-secret\n',
    );
    const calls = f.calls();
    assert.ok(calls.indexOf('release-host.sh install') < calls.indexOf('database-bootstrap.sh'));
    assert.ok(calls.indexOf('database-bootstrap.sh') < calls.indexOf('bash -s'));
    const imported = readFileSync(path.join(f.dir, 'import-script'), 'utf8');
    assert.ok(imported.indexOf('quiesce') < imported.indexOf('backup.sh'));
    assert.ok(imported.indexOf('backup.sh') < imported.indexOf('database-import.sh'));
    assert.match(imported, /--manifest "\$REWIND_FINAL_IMPORT_MANIFEST"/);
    assert.match(imported, /check-maintenance/);
    assert.ok(calls.indexOf('configure') < calls.indexOf('release-host.sh install'));
  } finally {
    f.close();
  }
});

test('wrong branch, dev resources, password sign-in and premature cutover fail before host changes', () => {
  for (const extra of [
    { GITHUB_REF: 'refs/heads/dev' },
    { REWIND_DEPLOY_INSTANCE: 'rewind-demo' },
    { REWIND_HOSTED_ENV_URI: 's3://rewind-dev-media-330599756236/_config/dev.env' },
    {
      REWIND_DATABASE_BOOTSTRAP_URI:
        's3://rewind-dev-media-330599756236/_config/dev-database-bootstrap.env',
    },
    { REWIND_RELEASE_BUNDLE_SHA256: '' },
  ]) {
    const f = fixture();
    try {
      assert.notEqual(f.run('reconcile', extra).status, 0);
      assert.doesNotMatch(f.calls(), /ssh /);
    } finally {
      f.close();
    }
  }
  for (const content of [
    (fixtureSettings) =>
      fixtureSettings.replace('REWIND_AUTH_PASSWORD=false', 'REWIND_AUTH_PASSWORD=true'),
    (fixtureSettings) =>
      fixtureSettings.replace(
        'REWIND_DATABASE_URL=\n',
        'REWIND_DATABASE_URL=postgres://fixture@release/rewind\n',
      ),
    (fixtureSettings) =>
      fixtureSettings.replace('REWIND_MEDIA_ENVIRONMENT=release', 'REWIND_MEDIA_ENVIRONMENT=dev'),
  ]) {
    const f = fixture();
    try {
      writeFileSync(path.join(f.dir, 'settings'), content(f.settings()));
      assert.notEqual(f.run('reconcile').status, 0);
      assert.doesNotMatch(f.calls(), /ssh /);
    } finally {
      f.close();
    }
  }
});

test('bootstrap failure does not quiesce SQLite or begin import', () => {
  const f = fixture();
  try {
    assert.notEqual(f.run('reconcile', { FAIL_BOOTSTRAP: '1' }).status, 0);
    assert.doesNotMatch(f.calls(), /bash -s/);
  } finally {
    f.close();
  }
});

test('activation timeout leaves writers stopped and never configures or installs', () => {
  const f = fixture();
  try {
    const result = f.run('activate');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /writers remain stopped/);
    assert.doesNotMatch(f.calls(), /ssh /);
  } finally {
    f.close();
  }
});

test('activation requires the Terraform-selected release app URL, then installs and verifies backups', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.dir, 'settings'), f.settings('postgres://different@dev/rewind'));
    assert.notEqual(f.run('activate').status, 0);
    assert.doesNotMatch(f.calls(), /ssh /);
    writeFileSync(path.join(f.dir, 'settings'), f.settings('postgres://fixture@release/rewind'));
    const result = f.run('activate');
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls();
    assert.ok(calls.indexOf('configure') < calls.indexOf('release-host.sh install'));
    assert.ok(calls.indexOf('release-host.sh install') < calls.indexOf('database-status.sh'));
    assert.match(calls, /backup.sh/);
    assert.equal(
      readFileSync(path.join(f.dir, 'configure-input'), 'utf8'),
      f.settings('postgres://fixture@release/rewind'),
    );
  } finally {
    f.close();
  }
});

test('a slow settings read cannot activate after the deadline, and waits cannot exceed 25 minutes', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.dir, 'settings'), f.settings('postgres://fixture@release/rewind'));
    assert.notEqual(f.run('activate', { SLOW_DOWNLOAD: '1' }).status, 0);
    assert.doesNotMatch(f.calls(), /ssh /);
    assert.notEqual(f.run('activate', { REWIND_RELEASE_CUTOVER_WAIT_SECONDS: '1501' }).status, 0);
    assert.doesNotMatch(f.calls(), /ssh /);
  } finally {
    f.close();
  }
});

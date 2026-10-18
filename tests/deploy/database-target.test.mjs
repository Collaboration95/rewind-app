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
    writeFileSync(path.join(dir, 'current-release'), '1'.repeat(40));
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
case "$*" in 'image inspect --format'*) echo 1111111111111111111111111111111111111111 ;; *'ps --status running --services'*) [ "$STILL_RUNNING" != 1 ] || echo runtime ;; esac
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

test('stopped-runtime tools require the installed qualified image and export its SHA', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rewind-installed-image-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const sha = '1'.repeat(40);
    writeFileSync(path.join(dir, 'current-release'), sha);
    writeFileSync(
      path.join(bin, 'docker'),
      '#!/bin/sh\n[ "$1 $2 $3" = "image inspect --format" ] || exit 2\n[ "$5" = "rewind-demo:$EXPECTED_SHA" ] || exit 3\n[ "$MISSING_IMAGE" != 1 ] || exit 4\nprintf "%s\\n" "$EXPECTED_SHA"\n',
      { mode: 0o755 },
    );
    const invoke = (overrides = {}) =>
      spawnSync(
        'bash',
        [
          '-c',
          'source deploy/operator-common.sh; resolve_installed_release; bash -c \'printf "%s" "$REWIND_RELEASE_SHA"\'',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            HOST_ROOT: dir,
            EXPECTED_SHA: sha,
            REWIND_RELEASE_SHA: '',
            ...overrides,
          },
        },
      );
    assert.equal(invoke().status, 0);
    assert.equal(invoke().stdout, sha);
    assert.notEqual(invoke({ REWIND_RELEASE_SHA: 'local' }).status, 0);
    assert.notEqual(invoke({ MISSING_IMAGE: '1' }).status, 0);
    writeFileSync(path.join(dir, 'current-release'), 'local');
    assert.notEqual(invoke().status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery comparison rejects changed content, missing/extra tables and wrong environment', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rewind-recovery-comparison-'));
  try {
    const table = { table: 'groups', rows: 1, sha256: 'a'.repeat(64) };
    const baseline = {
      ready: true,
      engine: 'postgresql',
      environment: 'release',
      migrationVersion: 30,
      appliedMigrationVersion: 30,
      tables: [table],
    };
    writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify(baseline));
    const compare = (report) => {
      writeFileSync(path.join(dir, 'restored.json'), JSON.stringify(report));
      return spawnSync(
        'bash',
        [
          '-c',
          'source deploy/operator-common.sh; compare_database_reports "$BASELINE" "$RESTORED"',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            BASELINE: path.join(dir, 'baseline.json'),
            RESTORED: path.join(dir, 'restored.json'),
          },
        },
      );
    };
    assert.equal(compare(baseline).status, 0);
    for (const change of [
      { tables: [{ ...table, sha256: 'b'.repeat(64) }] },
      { tables: [{ ...table, rows: 0 }] },
      { tables: [] },
      { tables: [table, { ...table, table: 'unexpected' }] },
      { environment: 'dev' },
      { ready: false },
      { appliedMigrationVersion: 29 },
    ])
      assert.notEqual(compare({ ...baseline, ...change }).status, 0, JSON.stringify(change));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('final import workflow passes its freshly produced manifest and stops on failed backup', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rewind-final-import-'));
  try {
    mkdirSync(path.join(dir, 'backups'));
    mkdirSync(path.join(dir, 'deploy'));
    const manifest = 'rewind-20261018T123456Z.manifest.json';
    writeFileSync(
      path.join(dir, 'deploy/database-maintenance.sh'),
      '#!/bin/bash\nprintf stopped > "$HOST_FIXTURE/maintenance"\n',
    );
    writeFileSync(
      path.join(dir, 'deploy/backup.sh'),
      `#!/bin/bash\n[[ "$FAIL_BACKUP" != 1 ]] || exit 19\nprintf '%s\\n' '${manifest}' > "$REWIND_BACKUP_MANIFEST_OUTPUT"\n`,
    );
    writeFileSync(
      path.join(dir, 'deploy/database-import.sh'),
      `#!/bin/bash\n[[ "$*" == '--confirm --manifest ${manifest}' && "$REWIND_FINAL_IMPORT_MANIFEST" == '${manifest}' ]] || exit 20\nprintf imported > "$HOST_FIXTURE/imported"\n`,
    );
    const ssh = path.join(dir, 'ssh');
    writeFileSync(
      ssh,
      '#!/bin/bash\ncommand="${1//\\/srv\\/rewind/$HOST_FIXTURE}"\nexec bash -c "$command"\n',
      { mode: 0o755 },
    );
    const workflow = readFileSync('.github/workflows/database-operations.yml', 'utf8');
    const block = workflow
      .split('      - name: Import the latest SQLite backup')[1]
      .split('      - name: Resume public traffic')[0];
    const script = block
      .split('        run: |\n')[1]
      .split('\n')
      .map((line) => line.replace(/^          /, ''))
      .join('\n');
    const invoke = (fail = '0') =>
      spawnSync('bash', ['-c', script], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          MANIFEST: '',
          REPLACE: 'false',
          TARGET_ENVIRONMENT: 'release',
          REWIND_SSH: ssh,
          HOST_FIXTURE: dir,
          FAIL_BACKUP: fail,
          GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
        },
      });
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(dir, 'imported'), 'utf8'), 'imported');
    rmSync(path.join(dir, 'imported'));
    assert.notEqual(invoke('1').status, 0);
    assert.equal(readFileSync(path.join(dir, 'maintenance'), 'utf8'), 'stopped');
    assert.throws(() => readFileSync(path.join(dir, 'imported')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('managed rehearsal pins the stopped baseline and fails on same-count restored corruption', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rewind-pinned-restore-'));
  try {
    const baseline = {
      ready: true,
      engine: 'postgresql',
      environment: 'release',
      migrationVersion: 30,
      appliedMigrationVersion: 30,
      capturedAt: '2026-10-18T00:00:00.000000Z',
      tables: [{ table: 'groups', rows: 1, sha256: 'a'.repeat(64) }],
    };
    writeFileSync(path.join(dir, 'fixture-baseline.json'), JSON.stringify(baseline));
    writeFileSync(
      path.join(dir, 'bad.json'),
      JSON.stringify({ ...baseline, tables: [{ ...baseline.tables[0], sha256: 'b'.repeat(64) }] }),
    );
    writeFileSync(
      path.join(dir, 'ssh'),
      `#!/bin/bash
printf '%s\\n' "$*" >> "$FIXTURE/calls"
case "$*" in
 *quiesce-recovery*) touch "$FIXTURE/stopped" ;;
 *--endpoint*) if [[ "$CORRUPT" == 1 ]]; then cat "$FIXTURE/bad.json"; else cat "$FIXTURE/fixture-baseline.json"; fi ;;
 *database-status.sh*) cat "$FIXTURE/fixture-baseline.json" ;;
 *) exit 21 ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(dir, 'aws'),
      `#!/bin/bash
printf '%s\\n' "$*" >> "$FIXTURE/calls"
case "$*" in
 *latestRestorableTime*) echo 2026-10-18T00:00:01Z ;;
 *relationalDatabase.state*) echo available ;;
 *masterEndpoint*) echo db.example:5432 ;;
 *create-relational-database-from-snapshot*) [[ "$*" == *'--restore-time 2026-10-18T00:00:00.000000Z'* && "$*" != *--use-latest-restorable-time* ]] || exit 22 ;;
 *) exit 23 ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(dir, 'date'),
      `#!/bin/bash
case "$*" in *+%s%6N*) echo 1792281601000000 ;; *+%s*) echo 1792281601 ;; *) echo 20261018000000 ;; esac
`,
      { mode: 0o755 },
    );
    const workflow = readFileSync('.github/workflows/database-operations.yml', 'utf8');
    const block = workflow
      .split('      - name: Rehearse a point-in-time restore')[1]
      .split('      - name: Delete the rehearsal database')[0];
    const script = block
      .split('        run: |\n')[1]
      .split('\n')
      .map((line) => line.replace(/^          /, ''))
      .join('\n');
    // Workflow scratch files are runner-local; keep this invocation inside its fixture.
    const run = script.replace(
      'source deploy/operator-common.sh',
      `source '${root}/deploy/operator-common.sh'`,
    );
    const invoke = (corrupt) =>
      spawnSync('bash', ['-c', run], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          FIXTURE: dir,
          REWIND_SSH: path.join(dir, 'ssh'),
          REWIND_DATABASE_NAME: 'rewind-release-postgres',
          REWIND_DATABASE_ZONE: 'ap-southeast-1a',
          TARGET_ENVIRONMENT: 'release',
          GITHUB_ENV: path.join(dir, 'github-env'),
          GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
          CORRUPT: corrupt,
        },
      });
    const passed = invoke('0');
    assert.equal(passed.status, 0, passed.stderr);
    assert.notEqual(invoke('1').status, 0);
    assert.equal(readFileSync(path.join(dir, 'stopped'), 'utf8'), '');
    const calls = readFileSync(path.join(dir, 'calls'), 'utf8');
    assert.ok(calls.indexOf('quiesce-recovery') < calls.indexOf('database-status.sh'));
    assert.match(calls, /database-status.sh --require-stopped-writers/);
    assert.doesNotMatch(calls, /use-latest-restorable-time|maintenance.sh resume/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

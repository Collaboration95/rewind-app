import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';
import { parseConfig } from '../dist/config.js';
import { createRuntimeServer } from '../dist/http.js';
import { processClipJob, runAuditedJob } from '../dist/jobs/index.js';
import { verifyMediaIntegrity, recordIntegrityFailure } from '../dist/media/integrity.js';
import { operationalSnapshot } from '../dist/observability/index.js';
import { accountFixture } from './helpers/upload-intents.mjs';
import { createRealGroup } from '../dist/groups/real.js';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';
import { REAL_AUTH_ENV } from './helpers/real-http.mjs';
import { createRealAccount } from '../dist/auth/index.js';

const execFileAsync = promisify(execFile);
async function fixture(run) {
  const root = await mkdtemp(`${tmpdir()}/rewind-operational-`);
  const config = parseConfig({
    REWIND_DATA_DIR: root,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
    ...REAL_AUTH_ENV,
  });
  const database = openFixtureDatabase(config);
  try {
    await run({ root, config, database });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('actual SQLite HTTP failure logs only generated correlation, status and duration', async () => {
  await fixture(async ({ config, database }) => {
    const secret =
      '/private/media-secret.mp4?token=token-secret invite-secret person@example.test message-secret';
    const password = 'synthetic observability password';
    const created = await createRealAccount(database, 'ops-member', 'ops-member', password);
    assert.equal(created.ok, true);
    database.exec(
      `CREATE TRIGGER operational_failure BEFORE INSERT ON real_account_sessions BEGIN SELECT RAISE(ABORT, '${secret}'); END;`,
    );
    const logs = [];
    const original = console.error;
    console.error = (...args) => logs.push(args);
    const server = createRuntimeServer(config, database);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      for (let i = 0; i < 2; i++) {
        const response = await fetch(`${base}/auth/login?invite=invite-secret&token=token-secret`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Request-Id': 'client-secret',
            Cookie: 'cookie-secret',
            Authorization: 'Bearer auth-secret',
          },
          body: JSON.stringify({
            username: 'ops-member',
            password,
            clientType: 'native',
            content: secret,
          }),
        });
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), {
          error: 'internal_error',
          message: 'The local runtime could not complete the request.',
        });
        assert.match(response.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
        const record = JSON.parse(logs[i][0]);
        assert.equal(record.requestId, response.headers.get('x-request-id'));
        assert.deepEqual(Object.keys(record).sort(), [
          'durationMs',
          'event',
          'requestId',
          'statusCode',
        ]);
        assert.equal(logs[i].length, 1);
        assert.equal(record.event, 'api.failure');
        assert.equal(record.statusCode, 500);
        assert.ok(record.durationMs >= 0 && record.durationMs <= 86_400_000);
      }
      assert.notEqual(JSON.parse(logs[0][0]).requestId, JSON.parse(logs[1][0]).requestId);
      const denial = await fetch(`${base}/contributions?groupId=demo-group`);
      assert.equal(denial.status, 401);
      await denial.json();
      assert.equal(logs.length, 2);
      assert.doesNotMatch(
        JSON.stringify(logs),
        /private|secret|example|stack|message|member|group/,
      );
      database.exec('DROP TRIGGER operational_failure');
      const success = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'ops-member', password, clientType: 'native' }),
      });
      assert.equal(success.status, 200);
      await success.json();
      assert.equal(logs.length, 2);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      console.error = original;
    }
  });
});

test('actual invalid job metadata and tampered local bytes produce aggregate failure signals', async () => {
  await fixture(async ({ root, database }) => {
    database.exec(
      "INSERT INTO media_jobs (id,group_id,kind,status,created_at) VALUES ('operational-invalid','demo-group','clip','pending','2026-10-03T00:00:00Z')",
    );
    const failure = await processClipJob(database, {
      jobId: 'operational-invalid',
      ffmpegBin: 'ffmpeg',
      stagingDir: `${root}/staging`,
      outputDir: `${root}/processed`,
    });
    assert.equal(failure.ok, false);
    assert.equal(
      database.prepare("SELECT error_code FROM media_jobs WHERE id = 'operational-invalid'").get()
        .error_code,
      'invalid_metadata',
    );
    const path = `${root}/owned-tampered-bytes`;
    await writeFile(path, 'changed');
    database
      .prepare(
        "UPDATE media_jobs SET output_sha256 = ?, output_bytes = 8, output_verified_at = ? WHERE id = 'operational-invalid'",
      )
      .run(createHash('sha256').update('original').digest('hex'), new Date().toISOString());
    const integrity = await verifyMediaIntegrity(database, 'operational-invalid', path);
    assert.equal(integrity.outcome, 'mismatch');
    assert.equal(
      recordIntegrityFailure(database, {
        jobId: 'operational-invalid',
        kind: 'clip',
        result: integrity,
      }),
      true,
    );
    const snapshot = operationalSnapshot(database);
    assert.equal(snapshot.jobs.failed, 1);
    assert.equal(snapshot.storage.integrityFailures, 1);
    assert.doesNotMatch(
      JSON.stringify(snapshot),
      /operational-invalid|owned-tampered|demo-group|output_path|sha256/,
    );
  });
});

test('readonly CLI reports numeric queue, reminder and scheduled state without changing database', async () => {
  await fixture(async ({ config, database }) => {
    const now = new Date('2026-10-03T12:00:00Z');
    accountFixture(database, 'operational-owner', now);
    const result = createRealGroup(
      database,
      { id: 'operational-owner', displayName: 'Private owner' },
      { name: 'Private group', prompt: 'Private content', maxMembers: 5 },
      now,
    );
    assert.ok(result?.group?.id);
    const groupId = result.group.id;
    database
      .prepare("UPDATE cycles SET ends_at = '2026-10-02T12:00:00Z' WHERE group_id = ?")
      .run(groupId);
    database
      .prepare(
        "INSERT INTO reminder_outbox (id,group_id,account_id,local_sunday,scheduled_at,destination_generation,state,attempts,next_attempt_at,created_at,updated_at,response_category) VALUES ('secret-reminder',?,'operational-owner','2026-09-27','2026-09-27T19:00:00Z',1,'failed',3,'2026-09-27T19:00:00Z','2026-09-27T19:00:00Z','2026-09-27T19:00:00Z','secret-provider-error')",
      )
      .run(groupId);
    database
      .prepare(
        "INSERT INTO media_jobs (id,group_id,kind,status,created_at,attempt_count,processing_started_at,failed_at,error_code) VALUES ('secret-film',?,'film','failed','2026-10-03T10:00:00Z',3,'2026-10-03T10:00:00Z','2026-10-03T10:00:02Z','/private/signed?token=secret')",
      )
      .run(groupId);
    database.exec(
      "INSERT INTO media_jobs (id,group_id,kind,status,created_at) VALUES ('secret-pending','demo-group','clip','pending','2026-10-03T11:00:00Z')",
    );
    const snapshot = operationalSnapshot(database, now);
    assert.equal(snapshot.jobs.exhaustedFilms, 1);
    // A retained job timestamp is not an audited attempt duration.
    assert.equal(snapshot.jobs.longestRecordedFailedAttemptMs, 0);
    assert.ok(snapshot.jobs.oldestActiveAgeSeconds >= 3600);
    assert.equal(snapshot.reminders.failed, 1);
    assert.equal(snapshot.scheduler.overdueCollecting, 1);
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const before = await readFile(config.databasePath);
    const { stdout } = await execFileAsync(process.execPath, [
      'scripts/server-operational-metrics.mjs',
      config.databasePath,
    ]);
    const output = JSON.parse(stdout);
    assert.equal(output.reminders.failed, 1);
    assert.equal(output.jobs.exhaustedFilms, 1);
    assert.doesNotMatch(stdout, /secret|Private|operational-owner|signed|provider-error/);
    assert.deepEqual(await readFile(config.databasePath), before);
    await assert.rejects(
      execFileAsync(process.execPath, [
        'scripts/server-operational-metrics.mjs',
        `${config.dataDir}/secret-nonexistent.sqlite`,
      ]),
      (error) => {
        assert.deepEqual(
          JSON.parse(error.stderr.split('\n').find((line) => line.startsWith('{'))),
          { event: 'operational.snapshot_unavailable' },
        );
        assert.doesNotMatch(error.stderr, /secret-nonexistent/);
        return true;
      },
    );
    const unbuiltCli = `${config.dataDir}/secret-unbuilt-cli.mjs`;
    await writeFile(unbuiltCli, await readFile('scripts/server-operational-metrics.mjs'));
    await assert.rejects(
      execFileAsync(process.execPath, [unbuiltCli, config.databasePath]),
      (error) => {
        assert.deepEqual(
          JSON.parse(error.stderr.split('\n').find((line) => line.startsWith('{'))),
          { event: 'operational.snapshot_unavailable' },
        );
        assert.doesNotMatch(
          error.stderr,
          /secret-unbuilt|observability\/index|ERR_MODULE_NOT_FOUND/,
        );
        return true;
      },
    );
  });
});

test('completed and failed attempt durations survive terminal processing timestamp cleanup', async (t) => {
  await fixture(async ({ database }) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-03T12:00:00Z') });
    assert.equal(
      await runAuditedJob(database, {
        jobId: 'owned-duration-completed',
        run: () => {
          t.mock.timers.tick(1250);
          return 'completed';
        },
      }),
      'completed',
    );
    await assert.rejects(
      runAuditedJob(database, {
        jobId: 'owned-duration-failed',
        run: () => {
          t.mock.timers.tick(500);
          throw new Error('/private/owned-error?token=never-log');
        },
      }),
    );
    const snapshot = operationalSnapshot(database);
    assert.equal(snapshot.jobs.longestRecordedCompletedAttemptMs, 1250);
    assert.equal(snapshot.jobs.longestRecordedFailedAttemptMs, 500);
    assert.doesNotMatch(JSON.stringify(snapshot), /owned-duration|private|never-log/);
    const outsideWindow = operationalSnapshot(database, new Date('2026-10-05T12:00:00Z'));
    assert.equal(outsideWindow.jobs.longestRecordedCompletedAttemptMs, 0);
    assert.equal(outsideWindow.jobs.longestRecordedFailedAttemptMs, 0);
  });
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const { parseConfig } = await import('../dist/config.js');
const { migrateDatabase, openDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { listQueueJobs } = await import('../dist/jobs/queue.js');

const SESSION_REQUIRED = {
  error: 'session_required',
  message: 'Choose Demo access before changing local Demo data.',
};
const SAFE_DENIAL = {
  allowed: false,
  status: 403,
  error: 'forbidden',
  message: 'You do not have access to this resource.',
};

async function withRuntime(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-queue-observability-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
  });
  const database = openDatabase(config);
  const server = createRuntimeServer(config, database);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await run({ baseUrl, config, database });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function createSession(baseUrl, memberId = 'demo-1', groupId) {
  const response = await fetch(`${baseUrl}/sessions/demo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, ...(groupId ? { groupId } : {}) }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).session;
}

function insertQueueFixtures(database) {
  const insert = database.prepare(
    `INSERT INTO media_jobs
       (id, group_id, contribution_id, kind, status, output_path, created_at,
        error_code, processing_started_at, progress, attempt_count, updated_at, failed_at)
     VALUES (?, 'demo-group', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    'clip-pending-a',
    'clip',
    'pending',
    '/private/raw-a.mp4',
    '2026-09-01T00:00:00.000Z',
    null,
    null,
    0,
    0,
    '2026-09-01T00:00:00.000Z',
    null,
  );
  insert.run(
    'clip-pending-b',
    'clip',
    'pending',
    '/private/raw-b.mp4',
    '2026-09-01T00:00:00.000Z',
    null,
    null,
    0,
    0,
    '2026-09-01T00:00:00.000Z',
    null,
  );
  insert.run(
    'film-processing',
    'film',
    'processing',
    '/private/film.mp4',
    '2026-09-01T00:01:00.000Z',
    null,
    '2026-09-01T00:02:00.000Z',
    40,
    1,
    '2026-09-01T00:02:00.000Z',
    null,
  );
  insert.run(
    'clip-failed-secret',
    'clip',
    'failed',
    '/private/failed-output.mp4',
    '2026-09-01T00:03:00.000Z',
    'file:///private/raw-secret.mp4',
    null,
    0,
    2,
    '2026-09-01T00:04:00.000Z',
    '2026-09-01T00:04:00.000Z',
  );
  insert.run(
    'film-failed-unknown',
    'film',
    'failed',
    null,
    '2026-09-01T00:05:00.000Z',
    'raw-error-with-token',
    null,
    75,
    3,
    '2026-09-01T00:06:00.000Z',
    '2026-09-01T00:06:00.000Z',
  );
}

test('queue migration repairs malformed filter/order indexes after its receipt is recorded', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-queue-migration-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  try {
    database.exec(`
      DROP INDEX media_jobs_queue_group_idx;
      DROP INDEX media_jobs_queue_group_kind_idx;
      DROP INDEX media_jobs_queue_group_status_idx;
      DROP INDEX media_jobs_queue_group_kind_status_idx;
      CREATE INDEX media_jobs_queue_group_idx ON media_jobs (kind);
      CREATE INDEX media_jobs_queue_group_kind_idx ON media_jobs (group_id);
      CREATE INDEX media_jobs_queue_group_status_idx ON media_jobs (status);
      CREATE INDEX media_jobs_queue_group_kind_status_idx ON media_jobs (created_at);
    `);
    migrateDatabase(database);
    for (const [name, expected] of [
      ['media_jobs_queue_group_idx', ['group_id', 'created_at', 'id']],
      ['media_jobs_queue_group_kind_idx', ['group_id', 'kind', 'created_at', 'id']],
      ['media_jobs_queue_group_status_idx', ['group_id', 'status', 'created_at', 'id']],
      [
        'media_jobs_queue_group_kind_status_idx',
        ['group_id', 'kind', 'status', 'created_at', 'id'],
      ],
    ]) {
      assert.deepEqual(
        database
          .prepare(`PRAGMA index_info(${name})`)
          .all()
          .sort((left, right) => left.seqno - right.seqno)
          .map((row) => row.name),
        expected,
        name,
      );
    }
    assert.deepEqual(
      database
        .prepare('PRAGMA table_info(media_jobs)')
        .all()
        .map((row) => row.name)
        .filter((name) => name === 'updated_at' || name === 'failed_at'),
      ['updated_at', 'failed_at'],
    );
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('queue API is authenticated, group-scoped, paginated, redacted, and retry-aware', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    insertQueueFixtures(database);
    const unauthenticated = await fetch(`${baseUrl}/jobs?groupId=demo-group`);
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(await unauthenticated.json(), SESSION_REQUIRED);

    const session = await createSession(baseUrl);
    const suffix = `groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`;
    const firstPageResponse = await fetch(
      `${baseUrl}/jobs?${suffix}&kind=clip&status=pending&limit=1`,
    );
    assert.equal(firstPageResponse.status, 200);
    const firstPage = await firstPageResponse.json();
    assert.equal(firstPage.jobs.length, 1);
    assert.equal(firstPage.jobs[0].id, 'clip-pending-a');
    assert.equal(firstPage.jobs[0].retryable, true);
    assert.equal(firstPage.pagination.hasMore, true);
    assert.ok(firstPage.pagination.nextCursor);
    const secondPageResponse = await fetch(
      `${baseUrl}/jobs?${suffix}&kind=clip&status=pending&limit=1&cursor=${encodeURIComponent(firstPage.pagination.nextCursor)}`,
    );
    assert.equal(secondPageResponse.status, 200);
    assert.deepEqual(
      (await secondPageResponse.json()).jobs.map((job) => job.id),
      ['clip-pending-b'],
    );

    const allJobsResponse = await fetch(`${baseUrl}/jobs?${suffix}&limit=10`);
    assert.equal(allJobsResponse.status, 200);
    const allJobs = await allJobsResponse.json();
    assert.deepEqual(
      allJobs.jobs.map((job) => job.id),
      [
        'clip-pending-a',
        'clip-pending-b',
        'film-processing',
        'clip-failed-secret',
        'film-failed-unknown',
      ],
    );
    const processing = allJobs.jobs.find((job) => job.id === 'film-processing');
    assert.deepEqual(processing, {
      id: 'film-processing',
      kind: 'film',
      status: 'processing',
      attempts: 1,
      failureCategory: null,
      progress: 40,
      createdAt: '2026-09-01T00:01:00.000Z',
      updatedAt: '2026-09-01T00:02:00.000Z',
      processingStartedAt: '2026-09-01T00:02:00.000Z',
      failedAt: null,
      retryable: false,
    });
    const failedClip = allJobs.jobs.find((job) => job.id === 'clip-failed-secret');
    assert.equal(failedClip.failureCategory, 'unknown');
    assert.equal(failedClip.retryable, true);
    assert.equal(failedClip.attempts, 2);
    const exhaustedFilm = allJobs.jobs.find((job) => job.id === 'film-failed-unknown');
    assert.equal(exhaustedFilm.failureCategory, 'unknown');
    assert.equal(exhaustedFilm.retryable, false);
    const serialized = JSON.stringify(allJobs);
    assert.doesNotMatch(serialized, /private|raw-secret|raw-error-with-token|failed-output/);
    assert.deepEqual(Object.keys(processing).sort(), [
      'attempts',
      'createdAt',
      'failedAt',
      'failureCategory',
      'id',
      'kind',
      'processingStartedAt',
      'progress',
      'retryable',
      'status',
      'updatedAt',
    ]);

    const invalidCursor = await fetch(`${baseUrl}/jobs?${suffix}&cursor=not-a-cursor`);
    assert.equal(invalidCursor.status, 400);
    assert.deepEqual((await invalidCursor.json()).error, 'invalid_jobs_request');

    const missingGroup = await fetch(
      `${baseUrl}/jobs?sessionId=${encodeURIComponent(session.id)}&status=not-a-status`,
    );
    assert.equal(missingGroup.status, 403);
    assert.deepEqual(await missingGroup.json(), SAFE_DENIAL);

    database.exec(`
      INSERT INTO profiles (id, display_name, avatar_label, is_synthetic)
        VALUES ('queue-outsider', 'Queue Outsider', 'Queue Outsider', 1);
      INSERT INTO groups (id, name, current_cycle_id)
        VALUES ('queue-other-group', 'Queue Other Group', NULL);
      INSERT INTO memberships (group_id, member_id, role, accepted_at)
        VALUES ('queue-other-group', 'queue-outsider', 'member', '2026-09-01T00:00:00.000Z');
    `);
    const foreignSession = await createSession(baseUrl, 'queue-outsider', 'queue-other-group');
    const crossGroup = await fetch(
      `${baseUrl}/jobs?groupId=demo-group&sessionId=${encodeURIComponent(foreignSession.id)}&status=not-a-status`,
    );
    assert.equal(crossGroup.status, 403);
    assert.deepEqual(await crossGroup.json(), SAFE_DENIAL);
  });
});

test('jobs CLI emits the same redacted bounded contract', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-queue-cli-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  database
    .prepare(
      `INSERT INTO media_jobs
        (id, group_id, kind, status, output_path, created_at, error_code, progress, attempt_count)
       VALUES (?, ?, 'clip', 'failed', ?, ?, ?, ?, ?)`,
    )
    .run(
      'cli-failed-job',
      'demo-group',
      '/private/cli-secret.mp4',
      '2026-09-02T00:00:00.000Z',
      '/private/cli-error',
      0,
      1,
    );
  database.close();
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['server/dist/cli.js', 'jobs', '--group', 'demo-group', '--status', 'failed', '--json'],
      { env: { ...process.env, REWIND_DATA_DIR: dataDir }, maxBuffer: 1_000_000 },
    );
    const output = JSON.parse(stdout);
    assert.equal(output.version, '0.1.0');
    assert.equal(output.jobs[0].id, 'cli-failed-job');
    assert.equal(output.jobs[0].failureCategory, 'unknown');
    assert.doesNotMatch(stdout, /private|cli-error|cli-secret/);
    assert.equal(output.pagination.limit, 50);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('queue read model uses keyset order without exposing ready or download rows', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-queue-model-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  try {
    insertQueueFixtures(database);
    const page = listQueueJobs(database, { groupId: 'demo-group', limit: 2 });
    assert.deepEqual(
      page.jobs.map((job) => job.id),
      ['clip-pending-a', 'clip-pending-b'],
    );
    assert.equal(page.pagination.hasMore, true);
    assert.doesNotMatch(JSON.stringify(page), /download|output_path|error_code/);
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { migrateDatabase, openDatabase, schemaReadiness } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');

const NOW = new Date('2026-09-10T12:00:00.000Z');
const DENIED = {
  allowed: false,
  status: 403,
  error: 'forbidden',
  message: 'You do not have access to this resource.',
};

async function withRuntime(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-ledger-api-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
  });
  const database = openDatabase(config, { seedNow: '2026-09-01T00:00:00.000Z' });
  const server = createRuntimeServer(config, database, { now: () => NOW });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run({ baseUrl, database });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function createSession(baseUrl, memberId = 'demo-1', groupId = 'demo-group') {
  const response = await fetch(`${baseUrl}/sessions/demo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, groupId }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).session.id;
}

function insertContribution(database, id, memberId, status, createdAt, durationSeconds = 4) {
  const jobId = `job-${id}`;
  database
    .prepare(
      `INSERT INTO contributions
        (id, cycle_id, member_id, duration_seconds, created_at, deleted_at)
       VALUES (?, 'demo-cycle', ?, ?, ?, ?)`,
    )
    .run(id, memberId, durationSeconds, createdAt, status === 'deleted' ? NOW.toISOString() : null);
  database
    .prepare(
      `INSERT INTO media_jobs
        (id, group_id, contribution_id, kind, status, created_at, updated_at,
         output_path, source_path, source_uri, error_code)
       VALUES (?, 'demo-group', ?, 'clip', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      jobId,
      id,
      status,
      createdAt,
      createdAt,
      '/private/locked-output.mp4',
      '/private/locked-source.mp4',
      'file:///private/locked-source.mp4',
      status === 'failed' ? '/private/error-with-secret' : null,
    );
}

function insertFixtures(database) {
  insertContribution(database, 'clip-pending', 'demo-1', 'pending', '2026-09-09T00:00:00.000Z', 3);
  insertContribution(
    database,
    'clip-processing',
    'demo-1',
    'processing',
    '2026-09-09T01:00:00.000Z',
    5,
  );
  insertContribution(database, 'clip-ready', 'demo-1', 'ready', '2026-09-09T02:00:00.000Z', 6);
  insertContribution(database, 'clip-failed', 'demo-1', 'failed', '2026-09-09T03:00:00.000Z', 2);
  insertContribution(database, 'clip-deleted', 'demo-1', 'deleted', '2026-09-09T04:00:00.000Z');
  insertContribution(database, 'clip-replaced', 'demo-1', 'deleted', '2026-09-09T05:00:00.000Z');
  database
    .prepare('UPDATE contributions SET replaced_by_contribution_id = ? WHERE id = ?')
    .run('clip-ready', 'clip-replaced');
  insertContribution(database, 'peer-clip', 'demo-2', 'ready', '2026-09-09T06:00:00.000Z');
  database.exec(`
    INSERT INTO cycles
      (id, group_id, prompt, starts_at, ends_at, status, lock_state,
       max_count, max_seconds, count_used, seconds_used)
    VALUES ('prior-cycle', 'demo-group', 'Old prompt',
      '2026-08-01T00:00:00.000Z', '2026-08-12T00:00:00.000Z',
      'archived', 'unlocked', 5, 30, 0, 0);
    INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at)
    VALUES ('prior-contribution', 'prior-cycle', 'demo-1', 3, '2026-08-02T00:00:00.000Z');
    INSERT INTO profiles (id, display_name, avatar_label, is_synthetic)
    VALUES ('outsider', 'Outsider', 'Outsider', 1);
    INSERT INTO groups (id, name, current_cycle_id)
    VALUES ('other-group', 'Other Group', 'other-cycle');
    INSERT INTO cycles
      (id, group_id, prompt, starts_at, ends_at, status, lock_state,
       max_count, max_seconds, count_used, seconds_used)
    VALUES ('other-cycle', 'other-group', 'Other prompt',
      '2026-09-01T00:00:00.000Z', '2026-09-12T00:00:00.000Z',
      'collecting', 'locked', 5, 30, 0, 0);
    INSERT INTO memberships (group_id, member_id, role, accepted_at)
    VALUES ('other-group', 'outsider', 'member', '2026-09-01T00:00:00.000Z');
    INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at)
    VALUES ('other-contribution', 'other-cycle', 'outsider', 3,
      '2026-09-09T00:00:00.000Z');
  `);
}

test('migration 016 records readiness and repairs a malformed index after receipt', async () => {
  await withRuntime(async ({ database }) => {
    assert.equal(schemaReadiness(database).ready, true);
    assert.equal(schemaReadiness(database).expectedMigrationVersion, 16);
    assert.equal(
      database.prepare('SELECT version FROM schema_migrations WHERE version = 16').get()?.version,
      16,
    );
    database.exec(`
      DROP INDEX contributions_ledger_member_idx;
      CREATE INDEX contributions_ledger_member_idx ON contributions (member_id);
    `);
    assert.deepEqual(schemaReadiness(database).missingMigrationKeys, ['contribution-ledger-v1']);
    migrateDatabase(database);
    assert.equal(schemaReadiness(database).ready, true);
    assert.deepEqual(
      database
        .prepare('PRAGMA index_info(contributions_ledger_member_idx)')
        .all()
        .map((row) => row.name),
      ['cycle_id', 'member_id', 'created_at', 'id'],
    );

    database.exec(`
      DROP INDEX contributions_ledger_member_idx;
      ALTER TABLE contributions DROP COLUMN replaced_by_contribution_id;
    `);
    assert.deepEqual(schemaReadiness(database).missingMigrationKeys, ['contribution-ledger-v1']);
    migrateDatabase(database);
    assert.equal(schemaReadiness(database).ready, true);
    assert.equal(
      database
        .prepare('PRAGMA table_info(contributions)')
        .all()
        .some((row) => row.name === 'replaced_by_contribution_id'),
      true,
    );
  });
});

test('GET /contributions is self-only, current-cycle, paginated, filterable and redacted', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    insertFixtures(database);
    const sessionId = await createSession(baseUrl);
    const query = `groupId=demo-group&sessionId=${encodeURIComponent(sessionId)}`;
    const firstResponse = await fetch(`${baseUrl}/contributions?${query}&limit=2&memberId=demo-2`);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.equal(first.cycleId, 'demo-cycle');
    assert.equal(first.memberId, 'demo-1');
    assert.deepEqual(
      first.entries.map((entry) => entry.contributionId),
      ['demo-contribution', 'clip-pending'],
    );
    assert.equal(first.pagination.hasMore, true);
    const secondResponse = await fetch(
      `${baseUrl}/contributions?${query}&limit=2&cursor=${encodeURIComponent(first.pagination.nextCursor)}`,
    );
    assert.equal(secondResponse.status, 200);
    assert.deepEqual(
      (await secondResponse.json()).entries.map((entry) => entry.contributionId),
      ['clip-processing', 'clip-ready'],
    );

    const allResponse = await fetch(`${baseUrl}/contributions?${query}`);
    assert.equal(allResponse.status, 200);
    assert.equal(allResponse.headers.get('cache-control'), 'no-store');
    const all = await allResponse.json();
    assert.deepEqual(
      all.entries.map((entry) => entry.state),
      ['sealed', 'queued', 'processing', 'sealed', 'failed', 'deleted', 'replaced'],
    );
    assert.equal(
      all.entries.find((entry) => entry.state === 'ready'),
      undefined,
    );
    assert.deepEqual(
      all.entries.find((entry) => entry.contributionId === 'clip-deleted').restored,
      { count: 1, seconds: 4 },
    );
    assert.equal(
      all.entries.find((entry) => entry.contributionId === 'clip-failed').failureCategory,
      'unknown',
    );
    assert.equal(all.allowance.deletionAvailability, 'available');
    assert.doesNotMatch(
      JSON.stringify(all),
      /private|locked|file:\/\/|output_path|source_uri|source_path|error-with-secret|download|share|thumbnail/i,
    );
    assert.equal(
      all.entries.some((entry) => entry.contributionId === 'peer-clip'),
      false,
    );
    assert.equal(
      all.entries.some((entry) => entry.contributionId === 'prior-contribution'),
      false,
    );
    assert.equal(
      all.entries.some((entry) => entry.contributionId === 'other-contribution'),
      false,
    );

    const failed = await fetch(`${baseUrl}/contributions?${query}&state=failed`);
    assert.deepEqual(
      (await failed.json()).entries.map((entry) => entry.contributionId),
      ['clip-failed'],
    );
    const replaced = await fetch(`${baseUrl}/contributions?${query}&state=replaced`);
    assert.deepEqual(
      (await replaced.json()).entries.map((entry) => entry.contributionId),
      ['clip-replaced'],
    );
    const peerSession = await createSession(baseUrl, 'demo-2');
    const peer = await fetch(
      `${baseUrl}/contributions?groupId=demo-group&sessionId=${peerSession}`,
    );
    assert.deepEqual(
      (await peer.json()).entries.map((entry) => entry.contributionId),
      ['peer-clip'],
    );
    const replay = await fetch(
      `${baseUrl}/contributions?groupId=demo-group&sessionId=${peerSession}&limit=2&cursor=${encodeURIComponent(first.pagination.nextCursor)}`,
    );
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, 'invalid_ledger_request');
  });
});

test('ledger denial happens before filters and hides group existence', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    insertFixtures(database);
    const noSession = await fetch(`${baseUrl}/contributions?groupId=demo-group&state=invalid`);
    assert.equal(noSession.status, 401);
    assert.equal((await noSession.json()).error, 'session_required');
    const outsider = await createSession(baseUrl, 'outsider', 'other-group');
    const foreign = await fetch(
      `${baseUrl}/contributions?groupId=demo-group&sessionId=${outsider}&state=invalid`,
    );
    assert.equal(foreign.status, 403);
    assert.deepEqual(await foreign.json(), DENIED);
    const ownSession = await createSession(baseUrl);
    for (const groupId of ['unknown-group', '']) {
      const denied = await fetch(
        `${baseUrl}/contributions?groupId=${groupId}&sessionId=${ownSession}&state=invalid`,
      );
      assert.equal(denied.status, 403);
      assert.deepEqual(await denied.json(), DENIED);
    }
    for (const query of ['state=invalid', 'limit=101', 'cursor=invalid']) {
      const invalid = await fetch(
        `${baseUrl}/contributions?groupId=demo-group&sessionId=${ownSession}&${query}`,
      );
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error, 'invalid_ledger_request');
    }
    const ownOther = await fetch(
      `${baseUrl}/contributions?groupId=other-group&sessionId=${outsider}`,
    );
    assert.equal(ownOther.status, 200);
    assert.deepEqual(
      (await ownOther.json()).entries.map((entry) => entry.contributionId),
      ['other-contribution'],
    );
  });
});

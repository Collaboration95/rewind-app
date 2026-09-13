import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { getCurrentCycle, migrateDatabase, openDatabase, openDatabaseAt, seedDatabase } =
  await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');
const {
  advanceCycleLifecycle,
  advanceDemoCycle,
  CYCLE_DURATION_MS,
  createCycleEngine,
  MAX_DEMO_ADVANCE_SECONDS,
  publishCycleRelease,
} = await import('../dist/cycles/index.js');

async function withDatabase(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-cycle-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  try {
    return await run({ config, database });
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('one deterministic engine calculates one-day and four-week windows', () => {
  let now = new Date('2026-09-10T12:00:00.000Z');
  const engine = createCycleEngine(() => now);
  assert.equal(engine.durationMs('one-day'), 24 * 60 * 60 * 1000);
  assert.equal(engine.durationMs('four-week'), 28 * 24 * 60 * 60 * 1000);
  assert.deepEqual(engine.createWindow({ preset: 'one-day' }), {
    startsAt: '2026-09-10T12:00:00.000Z',
    endsAt: '2026-09-11T12:00:00.000Z',
  });
  assert.deepEqual(engine.createWindow({ preset: 'four-week' }), {
    startsAt: '2026-09-10T12:00:00.000Z',
    endsAt: '2026-10-08T12:00:00.000Z',
  });
  now = new Date('2026-09-11T12:00:00.000Z');
  assert.equal(
    engine.phase({
      startsAt: '2026-09-10T12:00:00.000Z',
      endsAt: '2026-09-11T12:00:00.000Z',
      status: 'collecting',
    }),
    'ended',
  );
});

test('engine advances a cycle deterministically without changing its duration', () => {
  const engine = createCycleEngine(() => new Date('2026-09-10T12:00:00.000Z'));
  const initial = engine.createWindow({
    preset: 'one-day',
    startsAt: '2026-09-10T00:00:00.000Z',
  });
  const advanced = engine.advanceWindow(initial, 3_600);
  assert.equal(
    Date.parse(advanced.endsAt) - Date.parse(advanced.startsAt),
    CYCLE_DURATION_MS['one-day'],
  );
  assert.equal(advanced.endsAt, '2026-09-10T23:00:00.000Z');
  assert.equal(engine.remainingSeconds(advanced), 39_600);
});

test('only the persisted owner can advance a demo cycle and controls are recorded', async () => {
  await withDatabase(async ({ database }) => {
    const occurredAt = new Date('2026-09-10T12:00:00.000Z');
    const original = database
      .prepare('SELECT starts_at AS startsAt, ends_at AS endsAt FROM cycles WHERE id = ?')
      .get('demo-cycle');

    const denied = advanceDemoCycle(database, {
      groupId: 'demo-group',
      actingMemberId: 'demo-2',
      advanceSeconds: 3_600,
      clock: () => occurredAt,
    });
    assert.deepEqual(denied, {
      allowed: false,
      status: 403,
      error: 'forbidden',
      message: 'You do not have access to this resource.',
    });
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM cycle_control_events').get().count,
      0,
    );

    const advanced = advanceDemoCycle(database, {
      groupId: 'demo-group',
      actingMemberId: 'demo-1',
      advanceSeconds: 3_600,
      clock: () => occurredAt,
    });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;
    assert.equal(advanced.advanceSeconds, 3_600);
    assert.equal(advanced.eventId.startsWith('cycle-control-'), true);
    assert.equal(Date.parse(advanced.cycle.endsAt), Date.parse(original.endsAt) - 3_600 * 1000);
    const event = database
      .prepare(
        `SELECT cycle_id AS cycleId, group_id AS groupId, actor_member_id AS actorMemberId,
           advance_seconds AS advanceSeconds, occurred_at AS occurredAt
         FROM cycle_control_events WHERE id = ?`,
      )
      .get(advanced.eventId);
    assert.deepEqual(
      { ...event },
      {
        cycleId: 'demo-cycle',
        groupId: 'demo-group',
        actorMemberId: 'demo-1',
        advanceSeconds: 3_600,
        occurredAt: '2026-09-10T12:00:00.000Z',
      },
    );
  });
});

test('owner controls reject invalid or excessive advances without changing the cycle', async () => {
  await withDatabase(async ({ database }) => {
    const before = database
      .prepare('SELECT starts_at AS startsAt, ends_at AS endsAt FROM cycles WHERE id = ?')
      .get('demo-cycle');
    for (const advanceSeconds of [0, -1, 1.5, MAX_DEMO_ADVANCE_SECONDS + 1]) {
      assert.deepEqual(
        advanceDemoCycle(database, {
          groupId: 'demo-group',
          actingMemberId: 'demo-1',
          advanceSeconds,
        }),
        { ok: false, reason: 'invalid_request' },
      );
    }
    const after = database
      .prepare('SELECT starts_at AS startsAt, ends_at AS endsAt FROM cycles WHERE id = ?')
      .get('demo-cycle');
    assert.deepEqual(after, before);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM cycle_control_events').get().count,
      0,
    );
  });
});

test('cycle lifecycle transitions wait for release and create one successor idempotently', async () => {
  await withDatabase(async ({ database }) => {
    const boundary = new Date('2026-09-11T00:00:00.000Z');
    database
      .prepare('UPDATE cycles SET starts_at = ?, ends_at = ? WHERE id = ?')
      .run('2026-09-10T00:00:00.000Z', boundary.toISOString(), 'demo-cycle');

    const revealing = advanceCycleLifecycle(database, {
      groupId: 'demo-group',
      clock: () => boundary,
    });
    assert.equal(revealing.ok, true);
    assert.equal(revealing.action, 'revealing');
    assert.equal(
      advanceCycleLifecycle(database, {
        groupId: 'demo-group',
        clock: () => new Date('2026-09-11T00:00:01.000Z'),
      }).action,
      'waiting_for_release',
    );

    const publishedAt = new Date('2026-09-11T00:01:00.000Z');
    assert.equal(
      publishCycleRelease(database, {
        groupId: 'demo-group',
        cycleId: 'demo-cycle',
        publishedAt,
      }).action,
      'published',
    );
    assert.equal(
      publishCycleRelease(database, {
        groupId: 'demo-group',
        cycleId: 'demo-cycle',
        publishedAt: new Date('2026-09-11T00:02:00.000Z'),
      }).action,
      'already_published',
    );
    const archived = advanceCycleLifecycle(database, {
      groupId: 'demo-group',
      clock: () => publishedAt,
    });
    assert.equal(archived.ok, true);
    assert.equal(archived.action, 'archived');
    assert.equal(archived.cycle.status, 'archived');
    assert.equal(archived.nextCycle.previousCycleId, 'demo-cycle');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM cycles').get().count, 2);

    const replay = advanceCycleLifecycle(database, {
      groupId: 'demo-group',
      cycleId: 'demo-cycle',
      clock: () => new Date('2026-09-11T00:02:00.000Z'),
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.action, 'already_archived');
    assert.equal(replay.nextCycle.id, archived.nextCycle.id);
  });
});

test('lifecycle migration applies after the canonical quota/media migrations', async () => {
  await withDatabase(async ({ database }) => {
    assert.equal(
      database.prepare('SELECT 1 FROM schema_migrations WHERE version = 9').get()?.['1'],
      1,
    );
    assert.equal(
      database
        .prepare(
          "SELECT 1 FROM schema_migration_markers WHERE migration_key = 'cycle-lifecycle-v1'",
        )
        .get()?.['1'],
      1,
    );
    assert.equal(getCurrentCycle(database, 'demo-group').releaseStatus, 'unpublished');
  });
});

test('a legacy #54 version-006 lifecycle database is promoted without losing quota state', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-legacy-cycle-first-`);
  const databasePath = `${dataDir}/rewind.sqlite`;
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    database.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    for (const version of [1, 2, 3, 4, 5]) {
      database.exec(
        readFileSync(
          `server/migrations/${String(version).padStart(3, '0')}-${
            ['initial', 'session-audit', 'cycle-controls', 'invites', 'media-idempotency'][
              version - 1
            ]
          }.sql`,
          'utf8',
        ),
      );
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(version, new Date().toISOString());
    }
    seedDatabase(database);
    database.exec(
      `ALTER TABLE cycles ADD COLUMN release_status TEXT NOT NULL DEFAULT 'unpublished'
         CHECK (release_status IN ('unpublished', 'published'));
       ALTER TABLE cycles ADD COLUMN release_published_at TEXT;
       ALTER TABLE cycles ADD COLUMN previous_cycle_id TEXT REFERENCES cycles(id) ON DELETE SET NULL;
       CREATE UNIQUE INDEX cycles_previous_cycle_idx ON cycles (previous_cycle_id) WHERE previous_cycle_id IS NOT NULL;
       CREATE TABLE cycle_lifecycle_events (
         id TEXT PRIMARY KEY,
         cycle_id TEXT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
         group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
         transition TEXT NOT NULL CHECK (transition IN ('collecting_to_revealing', 'revealing_to_archived', 'next_cycle_created')),
         occurred_at TEXT NOT NULL,
         UNIQUE (cycle_id, transition)
       );
       CREATE INDEX cycle_lifecycle_events_group_idx ON cycle_lifecycle_events (group_id, occurred_at DESC, id DESC);
       CREATE UNIQUE INDEX cycle_lifecycle_events_receipt_idx ON cycle_lifecycle_events (cycle_id, transition);`,
    );
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?)')
      .run(new Date().toISOString());
    database.close();

    const upgraded = openDatabaseAt(databasePath);
    try {
      assert.equal(
        upgraded.prepare('SELECT 1 FROM schema_migrations WHERE version = 9').get()?.['1'],
        1,
      );
      assert.equal(
        upgraded.prepare('SELECT 1 FROM contribution_quota_windows LIMIT 1').get() !== undefined,
        true,
      );
      assert.equal(
        upgraded.prepare('SELECT 1 FROM cycle_lifecycle_events LIMIT 1').get() !== undefined,
        false,
      );
      assert.equal(getCurrentCycle(upgraded, 'demo-group').releaseStatus, 'unpublished');
    } finally {
      upgraded.close();
    }
  } finally {
    try {
      database.close();
    } catch {
      // The database is already closed after the successful upgrade setup.
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('lifecycle migration repairs a partial DDL shape even after version 009 was recorded', async () => {
  await withDatabase(async ({ database }) => {
    database.exec(
      `DROP INDEX cycles_previous_cycle_idx;
       DROP INDEX cycle_lifecycle_events_group_idx;
       DROP INDEX cycle_lifecycle_events_receipt_idx;
       ALTER TABLE cycles DROP COLUMN previous_cycle_id;
       ALTER TABLE cycle_lifecycle_events RENAME TO cycle_lifecycle_events_broken;
       CREATE TABLE cycle_lifecycle_events (id TEXT PRIMARY KEY);`,
    );
    migrateDatabase(database);
    assert.equal(
      database
        .prepare('PRAGMA table_info(cycles)')
        .all()
        .some((row) => row.name === 'previous_cycle_id'),
      true,
    );
    assert.equal(
      database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cycle_lifecycle_events'",
        )
        .get()
        .sql.includes('cycle_id'),
      true,
    );
    assert.equal(
      database
        .prepare('SELECT name FROM pragma_index_list(?) WHERE name = ?')
        .get('cycles', 'cycles_previous_cycle_idx') !== undefined,
      true,
    );
  });
});

test('HTTP owner control requires a valid session and derives the actor from it', async () => {
  await withDatabase(async ({ config, database }) => {
    const server = createRuntimeServer(config, database);
    server.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const denied = await fetch(
        `${baseUrl}/cycles/demo/advance?groupId=demo-group&memberId=demo-2&advanceSeconds=60`,
        { method: 'POST' },
      );
      assert.equal(denied.status, 401);
      assert.deepEqual(await denied.json(), {
        error: 'session_required',
        message: 'Choose Demo access before changing local Demo data.',
      });

      for (const sessionId of ['', 'missing-session']) {
        const missing = await fetch(
          `${baseUrl}/cycles/demo/advance?groupId=demo-group&memberId=demo-1&sessionId=${sessionId}&advanceSeconds=60`,
          { method: 'POST' },
        );
        assert.equal(missing.status, 401);
        assert.equal((await missing.json()).error, 'session_required');
      }

      const sessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: 'demo-1' }),
      });
      assert.equal(sessionResponse.status, 201);
      const { session } = await sessionResponse.json();

      const memberIdIsIgnored = await fetch(
        `${baseUrl}/cycles/demo/advance?groupId=demo-group&memberId=demo-2&sessionId=${encodeURIComponent(session.id)}&advanceSeconds=60`,
        { method: 'POST' },
      );
      assert.equal(memberIdIsIgnored.status, 200);

      const nonOwnerSessionResponse = await fetch(`${baseUrl}/sessions/demo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: 'demo-2' }),
      });
      const { session: nonOwnerSession } = await nonOwnerSessionResponse.json();
      const nonOwner = await fetch(
        `${baseUrl}/cycles/demo/advance?groupId=demo-group&memberId=demo-1&sessionId=${encodeURIComponent(nonOwnerSession.id)}&advanceSeconds=60`,
        { method: 'POST' },
      );
      assert.equal(nonOwner.status, 403);

      const allowed = await fetch(
        `${baseUrl}/cycles/demo/advance?groupId=demo-group&memberId=demo-2&sessionId=${encodeURIComponent(session.id)}&advanceSeconds=60`,
        { method: 'POST' },
      );
      assert.equal(allowed.status, 200);
      const body = await allowed.json();
      assert.equal(body.cycle.id, 'demo-cycle');
      assert.equal(body.advanceSeconds, 60);
      assert.match(body.eventId, /^cycle-control-/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

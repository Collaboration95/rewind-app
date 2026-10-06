import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';
import { seedLegacyFixture } from './helpers/legacy-fixture.mjs';

const { parseConfig } = await import('../dist/config.js');
const { getCurrentCycle, migrateDatabase, openDatabaseAt } = await import('../dist/db.js');
const { advanceCycleLifecycle, CYCLE_DURATION_MS, createCycleEngine, publishCycleRelease } =
  await import('../dist/cycles/index.js');

async function withDatabase(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-cycle-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openFixtureDatabase(config);
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

function readyFilm(database, config, cycleId) {
  const path = `${config.dataDir}/${cycleId}.mp4`;
  const bytes = Buffer.from('synthetic lifecycle integrity fixture');
  writeFileSync(path, bytes);
  database
    .prepare(
      `UPDATE media_jobs SET status = 'ready', output_path = ?, output_sha256 = ?,
     output_bytes = ?, output_verified_at = ? WHERE kind = 'film' AND cycle_id = ?`,
    )
    .run(
      path,
      createHash('sha256').update(bytes).digest('hex'),
      bytes.length,
      '2026-09-11T00:01:00.000Z',
      cycleId,
    );
  return path;
}

test('closure creates one immediate boundary-anchored successor and publication keeps a 24-hour premiere', async () => {
  await withDatabase(async ({ database, config }) => {
    const boundary = new Date('2026-09-11T00:00:00.000Z');
    database
      .prepare('UPDATE cycles SET starts_at = ?, ends_at = ? WHERE id = ?')
      .run('2026-09-10T00:00:00.000Z', boundary.toISOString(), 'demo-cycle');
    const closed = advanceCycleLifecycle(database, {
      groupId: 'demo-group',
      clock: () => boundary,
    });
    assert.equal(closed.action, 'revealing');
    assert.equal(closed.cycle.lockState, 'locked');
    assert.equal(closed.nextCycle.startsAt, boundary.toISOString());
    assert.equal(closed.nextCycle.endsAt, '2026-09-12T00:00:00.000Z');
    assert.equal(getCurrentCycle(database, 'demo-group').id, closed.nextCycle.id);
    assert.equal(
      advanceCycleLifecycle(database, {
        groupId: 'demo-group',
        cycleId: 'demo-cycle',
        clock: () => boundary,
      }).action,
      'waiting_for_release',
    );
    assert.equal(
      publishCycleRelease(database, {
        groupId: 'demo-group',
        cycleId: 'demo-cycle',
        clock: () => boundary,
      }).reason,
      'not_ready',
    );
    const path = readyFilm(database, config, 'demo-cycle');
    const publishedAt = new Date('2026-09-11T00:01:00.000Z');
    assert.equal(
      publishCycleRelease(database, { groupId: 'demo-group', cycleId: 'demo-cycle', publishedAt })
        .action,
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
    assert.equal(
      advanceCycleLifecycle(database, {
        groupId: 'demo-group',
        cycleId: 'demo-cycle',
        clock: () => new Date('2026-09-12T00:00:59.999Z'),
      }).action,
      'premiere',
    );
    const archived = advanceCycleLifecycle(database, {
      groupId: 'demo-group',
      cycleId: 'demo-cycle',
      clock: () => new Date('2026-09-12T00:01:00.000Z'),
    });
    assert.equal(archived.action, 'archived');
    assert.equal(archived.nextCycle.id, closed.nextCycle.id);
    assert.equal(getCurrentCycle(database, 'demo-group').id, closed.nextCycle.id);
    assert.equal(readFileSync(path).length > 0, true, 'archiving retains film bytes');
    assert.equal(
      advanceCycleLifecycle(database, {
        groupId: 'demo-group',
        cycleId: 'demo-cycle',
        clock: () => new Date('2026-09-13T00:00:00.000Z'),
      }).action,
      'already_archived',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM cycles').get().n, 2);
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS n FROM media_jobs WHERE kind = 'film' AND cycle_id IS NOT NULL",
        )
        .get().n,
      1,
    );
  });
});

test('missing, corrupt or unverified film never publishes or archives; next capture is independent', async () => {
  await withDatabase(async ({ database, config }) => {
    const boundary = new Date('2026-09-11T00:00:00.000Z');
    database
      .prepare('UPDATE cycles SET starts_at = ?, ends_at = ? WHERE id = ?')
      .run('2026-09-10T00:00:00.000Z', boundary.toISOString(), 'demo-cycle');
    const closed = advanceCycleLifecycle(database, {
      groupId: 'demo-group',
      clock: () => boundary,
    });
    database
      .prepare(
        "UPDATE media_jobs SET status = 'ready', output_path = '/missing-film.mp4' WHERE cycle_id = ? AND kind = 'film'",
      )
      .run('demo-cycle');
    assert.equal(
      publishCycleRelease(database, {
        groupId: 'demo-group',
        cycleId: 'demo-cycle',
        clock: () => boundary,
      }).reason,
      'not_ready',
    );
    const path = readyFilm(database, config, 'demo-cycle');
    writeFileSync(path, 'tampered output');
    assert.equal(
      publishCycleRelease(database, {
        groupId: 'demo-group',
        cycleId: 'demo-cycle',
        clock: () => boundary,
      }).reason,
      'not_ready',
    );
    database
      .prepare(
        "UPDATE cycles SET release_status = 'published', release_published_at = ? WHERE id = ?",
      )
      .run(boundary.toISOString(), 'demo-cycle');
    assert.equal(
      advanceCycleLifecycle(database, {
        groupId: 'demo-group',
        cycleId: 'demo-cycle',
        clock: () => new Date('2026-09-12T00:00:00.000Z'),
      }).action,
      'waiting_for_release',
    );
    assert.equal(getCurrentCycle(database, 'demo-group').id, closed.nextCycle.id);
    readyFilm(database, config, 'demo-cycle');
    assert.equal(
      advanceCycleLifecycle(database, {
        groupId: 'demo-group',
        cycleId: 'demo-cycle',
        clock: () => new Date('2026-09-12T00:00:00.000Z'),
      }).action,
      'archived',
    );
  });
});

test('late restart repairs legacy closure without shifting boundary or rewinding a newer current cycle', async () => {
  await withDatabase(async ({ database, config }) => {
    database
      .prepare("UPDATE cycles SET starts_at = ?, ends_at = ?, status = 'revealing' WHERE id = ?")
      .run('2026-09-10T00:00:00.000Z', '2026-09-11T00:00:00.000Z', 'demo-cycle');
    const second = openDatabaseAt(config.databasePath);
    try {
      const repaired = advanceCycleLifecycle(second, {
        groupId: 'demo-group',
        cycleId: 'demo-cycle',
        clock: () => new Date('2026-09-12T01:00:00.000Z'),
      });
      assert.equal(repaired.nextCycle.startsAt, '2026-09-11T00:00:00.000Z');
      const next = advanceCycleLifecycle(database, {
        groupId: 'demo-group',
        clock: () => new Date('2026-09-12T01:00:00.000Z'),
      });
      assert.equal(next.nextCycle.startsAt, '2026-09-12T00:00:00.000Z');
      for (const connection of [second, database, second]) {
        const replay = advanceCycleLifecycle(connection, {
          groupId: 'demo-group',
          cycleId: 'demo-cycle',
          clock: () => new Date('2026-09-13T00:00:00.000Z'),
        });
        assert.equal(replay.nextCycle.id, repaired.nextCycle.id);
        assert.equal(getCurrentCycle(connection, 'demo-group').id, next.nextCycle.id);
      }
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM cycles').get().n, 3);
      assert.equal(
        database
          .prepare(
            "SELECT COUNT(*) AS n FROM media_jobs WHERE kind = 'film' AND cycle_id IS NOT NULL",
          )
          .get().n,
        2,
      );
    } finally {
      second.close();
    }
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
    seedLegacyFixture(database);
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

test('real four-week rollover rejects ended quota and enables next capture while film is pending', async () => {
  const { createRealAccount } = await import('../dist/auth/index.js');
  const { createRealGroup, getCurrentRealGroup } = await import('../dist/groups/real.js');
  const { contributionQuotaWindow } = await import('../dist/contributions/index.js');
  const { createClipUpload } = await import('../dist/media/index.js');
  await withDatabase(async ({ database }) => {
    const start = new Date('2026-09-01T00:00:00.000Z');
    const account = await createRealAccount(
      database,
      'cycle-owner',
      'Cycle Owner',
      'synthetic lifecycle test password',
      start,
    );
    assert.equal(account.ok, true);
    const group = createRealGroup(
      database,
      account.account,
      { name: 'Real cycle', prompt: 'Remember today', maxMembers: 2 },
      start,
    );
    const boundary = new Date(group.cycle.endsAt);
    assert.equal(boundary.getTime() - start.getTime(), CYCLE_DURATION_MS['four-week']);
    assert.throws(() => contributionQuotaWindow(group.cycle, boundary), RangeError);
    const closed = advanceCycleLifecycle(database, {
      groupId: group.group.id,
      clock: () => boundary,
    });
    assert.equal(closed.nextCycle.startsAt, group.cycle.endsAt);
    assert.equal(
      Date.parse(closed.nextCycle.endsAt) - boundary.getTime(),
      CYCLE_DURATION_MS['four-week'],
    );
    const current = getCurrentRealGroup(database, account.account.id);
    assert.equal(current.cycle.id, closed.nextCycle.id);
    assert.equal(current.releases[0].state, 'processing');
    assert.equal(current.releases[0].cycleId, group.cycle.id);
    const upload = createClipUpload(
      database,
      group.group.id,
      group.memberId,
      {
        idempotencyKey: 'real-cycle-upload-1',
        sourceUri: 'synthetic-cycle-fixture',
        mimeType: 'video/mp4',
        byteLength: 100,
        durationSeconds: 2,
        width: 720,
        height: 1280,
        hasAudio: true,
      },
      boundary,
    );
    assert.equal(upload.ok, true);
    assert.equal(upload.upload.contribution.cycleId, closed.nextCycle.id);
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS n FROM contributions WHERE cycle_id = ?')
        .get(group.cycle.id).n,
      0,
    );
  });
});

test('concurrent lifecycle processes persist one successor, job and transition receipt', async () => {
  await withDatabase(async ({ database, config }) => {
    database
      .prepare('UPDATE cycles SET starts_at = ?, ends_at = ? WHERE id = ?')
      .run('2026-09-10T00:00:00.000Z', '2026-09-11T00:00:00.000Z', 'demo-cycle');
    const script = `const {openDatabaseAt}=await import(${JSON.stringify(resolve('server/dist/db.js'))});
      const {advanceCycleLifecycle}=await import(${JSON.stringify(resolve('server/dist/cycles/lifecycle.js'))});
      const db=openDatabaseAt(process.argv[1]);
      const result=advanceCycleLifecycle(db,{groupId:'demo-group',cycleId:'demo-cycle',clock:()=>new Date('2026-09-11T00:00:00.000Z')});
      console.log(JSON.stringify({ok:result.ok,id:result.nextCycle?.id})); db.close();`;
    const runs = await Promise.all(
      Array.from({ length: 4 }, () =>
        promisify(execFile)(process.execPath, [
          '--input-type=module',
          '-e',
          script,
          config.databasePath,
        ]),
      ),
    );
    const results = runs.map((run) => JSON.parse(run.stdout));
    assert.equal(
      results.every((result) => result.ok),
      true,
    );
    assert.equal(new Set(results.map((result) => result.id)).size, 1);
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS n FROM cycles WHERE previous_cycle_id = ?')
        .get('demo-cycle').n,
      1,
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS n FROM media_jobs WHERE cycle_id = ? AND kind = 'film'")
        .get('demo-cycle').n,
      1,
    );
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS n FROM cycle_lifecycle_events WHERE cycle_id = ?')
        .get('demo-cycle').n,
      2,
    );
  });
});

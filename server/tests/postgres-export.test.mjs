// Reverse export (#505): PostgreSQL back to a fresh SQLite file without losing
// writes made after the cutover. Needs REWIND_TEST_DATABASE_URL
// (npm run server:test:postgres); without it every test skips.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { seedFixtureGroup } from './helpers/fixture-group.mjs';
import { onPostgres } from './helpers/dialect.mjs';

const { parseConfig } = await import('../dist/config.js');
const db = await import('../dist/db.js');
const { createRealAccount, authenticateRealAccount } = await import('../dist/auth/index.js');
const { createRealGroup } = await import('../dist/groups/real.js');
const { createChatMessage, toggleChatReaction } = await import('../dist/chat/index.js');
const { openPostgres, openTestPostgres, testSchemaForPath } =
  await import('../dist/postgres/runtime.js');
const { installExportedDatabase } = await import('../dist/postgres/install.js');

const needsPostgres = onPostgres ? false : 'needs REWIND_TEST_DATABASE_URL';
const PASSWORD = 'a sufficiently long export password';
const CLI = join(process.cwd(), 'server/dist/cli.js');

async function scratch(run) {
  const dir = await mkdtemp(join(tmpdir(), 'rewind-export-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const listing = (dir) => readdirSync(dir).sort();

/** A pre-cutover SQLite database with an account, group, chat and fixtures. */
async function seedSnapshot(path) {
  const sqlite = db.openSqliteDatabaseAt(path);
  const now = new Date('2026-10-01T00:00:00.000Z');
  seedFixtureGroup(sqlite);
  const owner = await createRealAccount(sqlite, 'export.owner', 'Export Owner', PASSWORD, now);
  await authenticateRealAccount(sqlite, 'export.owner', PASSWORD, 'client-a', now);
  createRealGroup(
    sqlite,
    { id: owner.account.id, displayName: 'Export Owner' },
    { name: 'Exported group', prompt: 'What moved you?', maxMembers: 4 },
    now,
  );
  const sent = createChatMessage(sqlite, {
    groupId: 'demo-group',
    memberId: 'demo-1',
    body: 'before cutover',
    now,
  });
  assert.equal(sent.ok, true);
  sqlite.close();
}

/** Import into PostgreSQL, then write like the cut-over runtime would. */
async function cutOver(dir) {
  const snapshot = join(dir, 'snapshot', 'rewind.sqlite');
  await seedSnapshot(snapshot);
  const dataDir = join(dir, 'target');
  mkdirSync(dataDir, { recursive: true });
  const config = parseConfig({ REWIND_DATA_DIR: dataDir });
  db.importSqliteSnapshot(config, snapshot);

  const pg = db.openDatabase(config);
  const later = new Date('2026-10-05T03:04:05.678Z');
  try {
    const member = await createRealAccount(pg, 'post.member', 'Post Member', PASSWORD, later);
    const login = await authenticateRealAccount(pg, 'post.member', PASSWORD, 'client-z', later);
    assert.equal(login.status, 'authenticated');
    createRealGroup(
      pg,
      { id: member.account.id, displayName: 'Post Member' },
      { name: 'Post-cutover group', prompt: 'Anything?', maxMembers: 3 },
      later,
    );
    const sent = createChatMessage(pg, {
      groupId: 'demo-group',
      memberId: 'demo-2',
      body: "after cutover: ünïcode ✓ and 'quotes'",
      now: later,
    });
    assert.equal(sent.ok, true);
    assert.equal(
      toggleChatReaction(pg, {
        groupId: 'demo-group',
        memberId: 'demo-3',
        messageId: sent.event.message.id,
        emoji: '✨',
        now: later,
      }).ok,
      true,
    );
    // A contribution and its media job: nulls, fractions, timestamps and the
    // object-store references that point at media which is not in the file.
    pg.prepare(
      `INSERT INTO contributions
        (id, cycle_id, member_id, duration_seconds, created_at, quota_window_start_at)
       VALUES ('post-contribution', 'demo-cycle', 'demo-2', 4.25, ?, NULL)`,
    ).run(later.toISOString());
    pg.prepare(
      `INSERT INTO media_jobs
        (id, group_id, contribution_id, kind, status, output_path, source_uri, source_generation,
         trim_start_seconds, created_at, updated_at, progress)
       VALUES ('post-job', 'demo-group', 'post-contribution', 'clip', 'processing',
         NULL, 's3://rewind-dev-media/dev/clips/post.mov?versionId=3HL4kqCxf3vjVBH40Nrjfkd',
         7, 0.5, ?, ?, 42)`,
    ).run(later.toISOString(), later.toISOString());
    pg.prepare("UPDATE cycles SET seconds_used = 7.125 WHERE id = 'demo-cycle'").run();
    // A deleted newest event leaves the identity counter ahead of the table.
    const doomed = createChatMessage(pg, {
      groupId: 'demo-group',
      memberId: 'demo-1',
      body: 'deleted later',
      now: later,
    });
    assert.equal(doomed.ok, true);
    pg.prepare('DELETE FROM realtime_events WHERE message_id = ?').run(doomed.event.message.id);
  } finally {
    pg.close();
  }
  return { config, dataDir, snapshot };
}

const normalise = (rows) =>
  rows
    .map((row) =>
      JSON.stringify(
        Object.entries(row)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, value]) => [
            key,
            value instanceof Uint8Array ? `x${Buffer.from(value).toString('hex')}` : value,
          ]),
      ),
    )
    .sort();

function tablesOf(database, postgres) {
  return database
    .prepare(
      postgres
        ? `SELECT table_name AS name FROM information_schema.tables
           WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
             AND table_name <> 'rewind_database_environment'`
        : "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((row) => row.name)
    .sort();
}

/** Every table of the export equals PostgreSQL, row for row. */
function assertSameData(config, exportedPath) {
  const pg = db.openOperationalDatabase(config, { readOnly: true });
  const sqlite = new DatabaseSync(exportedPath, { readOnly: true });
  try {
    const tables = tablesOf(pg, true);
    assert.deepEqual(tablesOf(sqlite, false), tables);
    assert.ok(tables.length > 30);
    for (const table of tables) {
      const expected = normalise(pg.prepare(`SELECT * FROM "${table}"`).all());
      const actual = normalise(sqlite.prepare(`SELECT * FROM "${table}"`).all());
      assert.deepEqual(actual, expected, table);
    }
    return Object.fromEntries(
      tables.map((table) => [
        table,
        sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n,
      ]),
    );
  } finally {
    pg.close();
    sqlite.close();
  }
}

test('post-cutover writes survive the export, table for table', { skip: needsPostgres }, () =>
  scratch(async (dir) => {
    const { config, dataDir } = await cutOver(dir);
    const destination = join(dataDir, 'rewind.sqlite.export');
    const report = db.exportDatabaseToSqlite(config, destination);

    assert.equal(report.environment, 'test');
    assert.equal(report.writersQuiesced, true);
    assert.equal(report.migrationVersion, 31);
    assert.match(report.sqliteSha256, /^[0-9a-f]{64}$/);
    assert.equal(sha256(destination), report.sqliteSha256);
    const counts = assertSameData(config, destination);
    for (const table of report.tables) {
      assert.equal(table.rows, counts[table.table], table.table);
      assert.match(table.sha256, /^[0-9a-f]{64}$/);
    }
    assert.equal(
      report.totalRows,
      Object.values(counts).reduce((a, b) => a + b, 0),
    );
    assert.deepEqual(listing(dataDir), [
      'rewind.sqlite.export',
      'rewind.sqlite.export.export.json',
    ]);

    // Open it as the SQLite runtime would.
    const sqlite = db.openSqliteDatabaseAt(destination);
    try {
      assert.equal(db.schemaReadiness(sqlite).ready, true);
      const login = await authenticateRealAccount(sqlite, 'post.member', PASSWORD, 'client-y');
      assert.equal(login.status, 'authenticated', 'accounts and sessions survived');
      assert.equal(
        (await authenticateRealAccount(sqlite, 'export.owner', PASSWORD, 'client-y')).status,
        'authenticated',
      );
      assert.equal(
        sqlite.prepare("SELECT COUNT(*) AS n FROM messages WHERE body LIKE 'after cutover%'").get()
          .n,
        1,
      );
      assert.equal(
        sqlite.prepare("SELECT body FROM messages WHERE body LIKE 'after cutover%'").get().body,
        "after cutover: ünïcode ✓ and 'quotes'",
      );
      const contribution = sqlite
        .prepare("SELECT * FROM contributions WHERE id = 'post-contribution'")
        .get();
      assert.equal(contribution.duration_seconds, 4.25);
      assert.equal(contribution.quota_window_start_at, null);
      const job = sqlite.prepare("SELECT * FROM media_jobs WHERE id = 'post-job'").get();
      assert.equal(
        job.source_uri,
        's3://rewind-dev-media/dev/clips/post.mov?versionId=3HL4kqCxf3vjVBH40Nrjfkd',
      );
      assert.equal(job.source_generation, 7);
      assert.equal(job.output_path, null);
      assert.equal(
        sqlite.prepare("SELECT seconds_used AS s FROM cycles WHERE id = 'demo-cycle'").get().s,
        7.125,
      );
      // The real-profile trigger survived: a new real profile mirrors in.
      assert.ok(
        sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
          .all()
          .some((row) => row.name === 'real_profile_media_actor_insert'),
      );
      // The identity counter continues after PostgreSQL's, even though the
      // newest event row was deleted.
      const highest = sqlite.prepare('SELECT MAX(id) AS id FROM realtime_events').get().id;
      const counters = sqlite
        .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'realtime_events'")
        .all();
      assert.equal(counters.length, 1);
      const counter = counters[0].seq;
      assert.ok(counter > highest, 'a deleted event id is not reused');
      const next = createChatMessage(sqlite, {
        groupId: 'demo-group',
        memberId: 'demo-1',
        body: 'on SQLite again',
      });
      assert.equal(next.ok, true);
      assert.equal(
        sqlite.prepare('SELECT MAX(id) AS id FROM realtime_events').get().id,
        counter + 1,
      );
    } finally {
      sqlite.close();
    }
  }),
);

test('the export never writes to PostgreSQL', { skip: needsPostgres }, () =>
  scratch(async (dir) => {
    const { config, dataDir } = await cutOver(dir);
    const read = () => {
      const pg = db.openOperationalDatabase(config, { readOnly: true });
      try {
        return Object.fromEntries(
          tablesOf(pg, true).map((table) => [
            table,
            normalise(pg.prepare(`SELECT * FROM "${table}"`).all()),
          ]),
        );
      } finally {
        pg.close();
      }
    };
    const before = read();
    db.exportDatabaseToSqlite(config, join(dataDir, 'once.sqlite'));
    assert.deepEqual(read(), before);
  }),
);

test('a database bound to another environment is refused', { skip: needsPostgres }, () =>
  scratch(async (dir) => {
    const { config, dataDir } = await cutOver(dir);
    const admin = openTestPostgres(process.env.REWIND_TEST_DATABASE_URL, config.databasePath);
    try {
      admin.execNative("UPDATE rewind_database_environment SET environment = 'release'");
      assert.throws(
        () => db.exportDatabaseToSqlite(config, join(dataDir, 'wrong.sqlite')),
        /belongs to the "release" environment, not "test"/,
      );
      assert.deepEqual(listing(dataDir), []);
      admin.execNative('DELETE FROM rewind_database_environment');
      assert.throws(
        () => db.exportDatabaseToSqlite(config, join(dataDir, 'unbound.sqlite')),
        /exactly one environment/,
      );
      assert.deepEqual(listing(dataDir), []);
    } finally {
      admin.close();
    }
  }),
);

test('an incompatible PostgreSQL schema is refused', { skip: needsPostgres }, () =>
  scratch(async (dir) => {
    const { config, dataDir } = await cutOver(dir);
    const admin = openTestPostgres(process.env.REWIND_TEST_DATABASE_URL, config.databasePath);
    try {
      admin.execNative(
        "DELETE FROM schema_migration_markers WHERE migration_key = 'cognito-accounts-v1'",
      );
      assert.throws(
        () => db.exportDatabaseToSqlite(config, join(dataDir, 'old.sqlite')),
        /behind this release \(missing cognito-accounts-v1\)/,
      );
      admin.execNative(
        "INSERT INTO schema_migration_markers (migration_key, applied_at) VALUES ('cognito-accounts-v1', 'x')",
      );
      admin.execNative("INSERT INTO schema_migrations (version, applied_at) VALUES (99, 'x')");
      assert.throws(
        () => db.exportDatabaseToSqlite(config, join(dataDir, 'new.sqlite')),
        /newer than this release \(99\)/,
      );
      admin.execNative('DELETE FROM schema_migrations WHERE version = 99');
      // An extra table is a schema SQLite cannot take.
      admin.execNative('CREATE TABLE surprise (id TEXT PRIMARY KEY)');
      assert.throws(
        () => db.exportDatabaseToSqlite(config, join(dataDir, 'extra.sqlite')),
        /schemas differ. Only in PostgreSQL: surprise/,
      );
      admin.execNative('DROP TABLE surprise');
      assert.deepEqual(listing(dataDir), []);
      db.exportDatabaseToSqlite(config, join(dataDir, 'fine.sqlite'));
    } finally {
      admin.close();
    }
  }),
);

test('an existing or unsafe destination is refused untouched', { skip: needsPostgres }, () =>
  scratch(async (dir) => {
    const { config, dataDir } = await cutOver(dir);
    const existing = join(dataDir, 'existing.sqlite');
    writeFileSync(existing, 'a database somebody needs');
    assert.throws(() => db.exportDatabaseToSqlite(config, existing), /already exists/);
    assert.equal(readFileSync(existing, 'utf8'), 'a database somebody needs');

    // Leftover sidecars, a symlink and a directory all count as existing.
    writeFileSync(join(dataDir, 'wal.sqlite-wal'), 'x');
    assert.throws(
      () => db.exportDatabaseToSqlite(config, join(dataDir, 'wal.sqlite')),
      /wal\.sqlite-wal already exists/,
    );
    symlinkSync(existing, join(dataDir, 'link.sqlite'));
    assert.throws(() => db.exportDatabaseToSqlite(config, join(dataDir, 'link.sqlite')), /exists/);
    mkdirSync(join(dataDir, 'folder'));
    assert.throws(() => db.exportDatabaseToSqlite(config, join(dataDir, 'folder')), /exists/);
    assert.throws(
      () => db.exportDatabaseToSqlite(config, join(dataDir, 'missing', 'x.sqlite')),
      /directory .* does not exist/,
    );
    assert.throws(
      () => db.exportDatabaseToSqlite(config, existing.replace('existing', 'missing/../existing')),
      /already exists/,
    );
    // The live path is never an export target, even when it is absent.
    assert.throws(() => db.exportDatabaseToSqlite(config, config.databasePath), /live SQLite path/);
    assert.deepEqual(listing(dataDir), [
      'existing.sqlite',
      'folder',
      'link.sqlite',
      'wal.sqlite-wal',
    ]);
  }),
);

test('a reconciliation failure leaves no destination', { skip: needsPostgres }, () =>
  scratch(async (dir) => {
    const { config, dataDir } = await cutOver(dir);
    const destination = join(dataDir, 'tampered.sqlite');
    assert.throws(
      () =>
        db.exportDatabaseToSqlite(config, destination, {
          hooks: {
            afterLoad: (staging) => {
              const sqlite = new DatabaseSync(staging);
              sqlite.exec("UPDATE messages SET body = 'tampered' WHERE id = 'demo-message'");
              sqlite.close();
            },
          },
        }),
      /messages: the SQLite rows differ from the PostgreSQL snapshot/,
    );
    assert.deepEqual(listing(dataDir), [], 'no destination, report or staging file');

    assert.throws(
      () =>
        db.exportDatabaseToSqlite(config, destination, {
          hooks: {
            afterLoad: (staging) => {
              const sqlite = new DatabaseSync(staging);
              sqlite.exec('DELETE FROM reactions');
              sqlite.close();
            },
          },
        }),
      /reactions: the SQLite file has 0 rows, expected/,
    );
    assert.deepEqual(listing(dataDir), []);
  }),
);

test('a write that lands after the snapshot fails the export', { skip: needsPostgres }, () =>
  scratch(async (dir) => {
    const { config, dataDir } = await cutOver(dir);
    const destination = join(dataDir, 'late.sqlite');
    const writer = openTestPostgres(process.env.REWIND_TEST_DATABASE_URL, config.databasePath);
    try {
      assert.throws(
        () =>
          db.exportDatabaseToSqlite(config, destination, {
            hooks: {
              afterLoad: () =>
                writer.prepare("INSERT INTO groups (id, name) VALUES ('late', 'Late')").run(),
            },
          }),
        /PostgreSQL changed while it was being exported \(groups\)/,
      );
      assert.deepEqual(listing(dataDir), []);
      // Quiet again, the same export is exact.
      const report = db.exportDatabaseToSqlite(config, destination);
      assert.ok(report.tables.find((table) => table.table === 'groups').rows >= 2);
      assertSameData(config, destination);
    } finally {
      writer.close();
    }
  }),
);

test('connected writers block the export unless explicitly allowed', { skip: needsPostgres }, () =>
  scratch(async (dir) => {
    const { config, dataDir } = await cutOver(dir);
    const name = `rewind-writer-${randomBytes(4).toString('hex')}`;
    const writer = openPostgres(
      {
        url: process.env.REWIND_TEST_DATABASE_URL,
        host: 'test',
        tls: 'disable',
        environment: 'test',
      },
      { applicationName: name, schema: testSchemaForPath(config.databasePath) },
    );
    try {
      writer.prepare('SELECT COUNT(*) AS n FROM groups').get();
      const options = { writerApplicationNames: [name] };
      assert.throws(
        () => db.exportDatabaseToSqlite(config, join(dataDir, 'blocked.sqlite'), options),
        new RegExp(`Writers are still connected to PostgreSQL \\(${name} x1\\)`),
      );
      assert.deepEqual(listing(dataDir), []);
      const rehearsal = db.exportDatabaseToSqlite(config, join(dataDir, 'rehearsal.sqlite'), {
        ...options,
        allowLiveWriters: true,
      });
      assert.equal(rehearsal.writersQuiesced, false);
    } finally {
      writer.close();
    }
    const quiet = db.exportDatabaseToSqlite(config, join(dataDir, 'quiet.sqlite'), {
      writerApplicationNames: [name],
    });
    assert.equal(quiet.writersQuiesced, true);
  }),
);

test(
  'an interrupted export leaves no destination and the next one succeeds',
  {
    skip: needsPostgres,
  },
  () =>
    scratch(async (dir) => {
      const { dataDir } = await cutOver(dir);
      const destination = join(dataDir, 'interrupted.sqlite');
      const script = `
      const db = await import(${JSON.stringify(join(process.cwd(), 'server/dist/db.js'))});
      const { parseConfig } = await import(${JSON.stringify(join(process.cwd(), 'server/dist/config.js'))});
      db.exportDatabaseToSqlite(parseConfig(), ${JSON.stringify(destination)}, {
        hooks: { beforeExpose: () => process.kill(process.pid, 'SIGKILL') },
      });
    `;
      const killed = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, REWIND_DATA_DIR: dataDir },
        encoding: 'utf8',
      });
      assert.equal(killed.signal, 'SIGKILL');
      assert.equal(existsSync(destination), false);
      assert.equal(existsSync(`${destination}.export.json`), false);
      // Only the unfinished staging file remains, under a name no install reads.
      const leftovers = listing(dataDir);
      assert.equal(
        leftovers.length > 0 &&
          leftovers.every((name) => name.startsWith('.interrupted.sqlite.exporting-')),
        true,
      );

      const config = parseConfig({ REWIND_DATA_DIR: dataDir });
      const report = db.exportDatabaseToSqlite(config, destination);
      assert.equal(sha256(destination), report.sqliteSha256);
      assertSameData(config, destination);
      // The same failure in-process cleans up after itself.
      assert.throws(
        () =>
          db.exportDatabaseToSqlite(config, join(dataDir, 'again.sqlite'), {
            hooks: {
              beforeExpose: () => {
                throw new Error('interrupted');
              },
            },
          }),
        /interrupted/,
      );
      assert.equal(existsSync(join(dataDir, 'again.sqlite')), false);
      assert.equal(
        listing(dataDir).filter((name) => name.includes('again')).length,
        0,
        'no staging file for the failed run',
      );
    }),
);

test(
  'install swaps the database only, keeps the old file and restores on failure',
  {
    skip: needsPostgres,
  },
  () =>
    scratch(async (dir) => {
      const { config, dataDir, snapshot } = await cutOver(dir);
      const live = config.databasePath;
      // The retained pre-cutover file, with a stale WAL as a crash would leave.
      linkSync(snapshot, live);
      writeFileSync(`${live}-wal`, 'stale wal');
      const priorHash = sha256(live);
      const media = join(dataDir, 'media');
      mkdirSync(media);
      writeFileSync(join(media, 'clip.mp4'), 'current media');

      const staged = join(dataDir, 'rewind.sqlite.export');
      db.exportDatabaseToSqlite(config, staged);
      const checkReady = (database) => db.schemaReadiness(database);

      // A failed post-install check puts everything back.
      assert.throws(
        () =>
          installExportedDatabase(staged, live, {
            checkReady,
            afterSwap: () => {
              throw new Error('startup failed');
            },
          }),
        /startup failed/,
      );
      assert.equal(sha256(live), priorHash, 'the live file is the previous one');
      assert.equal(readFileSync(`${live}-wal`, 'utf8'), 'stale wal');
      assert.equal(existsSync(staged), true, 'the export stays installable');
      assert.deepEqual(
        listing(dataDir).filter((name) => name.includes('pre-export')),
        [],
      );

      // A file changed after export, or from another environment, is refused first.
      assert.throws(
        () => installExportedDatabase(staged, live, { checkReady, expectedEnvironment: 'release' }),
        /taken from the "test" environment, not "release"/,
      );
      // Tamper and restore through one descriptor: append a byte, then truncate it away.
      const stagedFd = openSync(staged, 'r+');
      try {
        const size = fstatSync(stagedFd).size;
        writeSync(stagedFd, Buffer.from('x'), 0, 1, size);
        assert.throws(() => installExportedDatabase(staged, live, { checkReady }), /changed after/);
        ftruncateSync(stagedFd, size);
      } finally {
        closeSync(stagedFd);
      }
      assert.equal(sha256(live), priorHash);

      const result = installExportedDatabase(staged, live, {
        checkReady,
        expectedEnvironment: 'test',
      });
      assert.equal(sha256(result.previousPath), priorHash, 'the previous database is kept');
      assert.equal(readFileSync(`${result.previousPath}-wal`, 'utf8'), 'stale wal');
      assert.equal(existsSync(`${live}-wal`), false, 'a stale WAL never meets the new file');
      assert.equal(existsSync(staged), false);
      assert.equal(sha256(live), result.report.sqliteSha256);
      assert.equal(readFileSync(join(media, 'clip.mp4'), 'utf8'), 'current media');
      assertSameData(config, live);

      // Starting on it works and holds the post-cutover writes.
      const sqlite = db.openSqliteDatabaseAt(live);
      try {
        assert.equal(
          sqlite
            .prepare("SELECT COUNT(*) AS n FROM contributions WHERE id = 'post-contribution'")
            .get().n,
          1,
        );
      } finally {
        sqlite.close();
      }
      // Without a report nothing installs.
      const bare = join(dataDir, 'bare.sqlite');
      writeFileSync(bare, 'not an export');
      assert.throws(
        () => installExportedDatabase(bare, live, { checkReady }),
        /missing or unreadable/,
      );
    }),
);

test('install refuses an export once PostgreSQL has moved on', { skip: needsPostgres }, () =>
  scratch(async (dir) => {
    const { config, dataDir, snapshot } = await cutOver(dir);
    const live = config.databasePath;
    linkSync(snapshot, live);
    const priorHash = sha256(live);
    const staged = join(dataDir, 'rewind.sqlite.next');
    db.exportDatabaseToSqlite(config, staged);

    // A restarted runtime (for example an automatic deploy) wrote in between.
    const writer = openTestPostgres(process.env.REWIND_TEST_DATABASE_URL, config.databasePath);
    try {
      writer.prepare("INSERT INTO groups (id, name) VALUES ('between', 'Between')").run();
      assert.throws(
        () => db.installSqliteExport(config, staged),
        /PostgreSQL changed since it was exported \(groups\)/,
      );
      assert.equal(sha256(live), priorHash, 'the live database is untouched');
      assert.equal(existsSync(staged), true);
      assert.deepEqual(
        listing(dataDir).filter((name) => name.includes('pre-export')),
        [],
      );
      writer.prepare("DELETE FROM groups WHERE id = 'between'").run();
    } finally {
      writer.close();
    }
    // Back to what was exported, the same file installs and says it checked.
    const result = db.installSqliteExport(config, staged);
    assert.equal(result.sourceVerified, true);
    assert.equal(sha256(result.previousPath), priorHash);
    assertSameData(config, live);

    // With PostgreSQL unreadable the operator may skip the check, knowingly.
    const again = join(dataDir, 'rewind.sqlite.again');
    db.exportDatabaseToSqlite(config, again);
    const skipped = db.installSqliteExport(config, again, { skipSourceCheck: true });
    assert.equal(skipped.sourceVerified, false);
  }),
);

test(
  'database-export and database-install run end to end from the CLI',
  {
    skip: needsPostgres,
  },
  () =>
    scratch(async (dir) => {
      const { config, dataDir, snapshot } = await cutOver(dir);
      const live = config.databasePath;
      linkSync(snapshot, live);
      const priorHash = sha256(live);
      const run = (...args) =>
        spawnSync(process.execPath, [CLI, ...args], {
          env: { ...process.env, REWIND_DATA_DIR: dataDir },
          encoding: 'utf8',
        });

      const missing = run('database-export');
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /database-export needs --sqlite PATH/);
      assert.match(run('database-export', '--sqlite', live).stderr, /live SQLite path/);

      const staged = join(dataDir, 'rewind.sqlite.next');
      const exported = run('database-export', '--sqlite', staged, '--json');
      assert.equal(exported.status, 0, exported.stderr);
      const report = JSON.parse(exported.stdout);
      assert.equal(report.environment, 'test');
      assert.equal(run('database-export', '--sqlite', staged).status, 1, 'never overwrites');
      assert.equal(sha256(staged), report.sqliteSha256);

      assert.match(run('database-install').stderr, /database-install needs --sqlite PATH/);
      const wrongEnvironment = run(
        'database-install',
        '--sqlite',
        staged,
        '--environment',
        'release',
      );
      assert.equal(wrongEnvironment.status, 1);
      assert.match(wrongEnvironment.stderr, /not "release"/);
      assert.equal(sha256(live), priorHash);

      const installed = run(
        'database-install',
        '--sqlite',
        staged,
        '--environment',
        'test',
        '--json',
      );
      assert.equal(installed.status, 0, installed.stderr);
      const result = JSON.parse(installed.stdout);
      assert.equal(sha256(result.previousPath), priorHash);
      assert.equal(sha256(live), report.sqliteSha256);
      assertSameData(config, live);
    }),
);

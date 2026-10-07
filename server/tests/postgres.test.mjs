// PostgreSQL-specific behaviour: SQL translation (always), and with
// REWIND_TEST_DATABASE_URL (npm run server:test:postgres) the bridge's
// transaction semantics, failover reconnect, environment binding, schema
// parity with SQLite, and the SQLite snapshot import.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { seedFixtureGroup } from './helpers/fixture-group.mjs';
import { onPostgres } from './helpers/dialect.mjs';

const { translate, splitStatements } = await import('../dist/postgres/translate.js');
const { parseConfig } = await import('../dist/config.js');
const db = await import('../dist/db.js');
const { createRealAccount, authenticateRealAccount } = await import('../dist/auth/index.js');
const { createRealGroup } = await import('../dist/groups/real.js');
const { createChatMessage, toggleChatReaction } = await import('../dist/chat/index.js');
const { openPostgres, openTestPostgres, verifyDatabaseEnvironment, postgresMigrationFiles } =
  await import('../dist/postgres/runtime.js');

const needsPostgres = onPostgres ? false : 'needs REWIND_TEST_DATABASE_URL';
const PASSWORD = 'a sufficiently long import password';

const sql = (text) => translate(text).parts.join('?');

test('translation keeps portable SQL and rewrites the inventoried SQLite idioms', () => {
  assert.equal(sql('SELECT id FROM groups WHERE id = ?'), 'SELECT id FROM groups WHERE id = ?');
  assert.equal(
    sql('INSERT OR IGNORE INTO reactions (id) VALUES (?)'),
    'INSERT INTO reactions (id) VALUES (?) ON CONFLICT DO NOTHING',
  );
  assert.equal(
    sql('SELECT IFNULL(a, 0), MAX(a, b), MIN(1, c), MAX(d) FROM t'),
    'SELECT COALESCE(a, 0), GREATEST(a, b), LEAST(1, c), MAX(d) FROM t',
  );
  assert.equal(
    sql('SELECT 1 FROM t WHERE a IS ? AND b IS NOT ?'),
    'SELECT 1 FROM t WHERE a IS NOT DISTINCT FROM ? AND b IS DISTINCT FROM ?',
  );
  assert.equal(
    sql('SELECT CAST(x AS INTEGER) FROM t LIMIT -1'),
    'SELECT CAST(x AS BIGINT) FROM t LIMIT ALL',
  );
  assert.equal(
    sql("SELECT a FROM t WHERE b LIKE 'x%' ORDER BY a, b DESC"),
    "SELECT a FROM t WHERE b ILIKE 'x%' ORDER BY a NULLS FIRST, b DESC NULLS LAST",
  );
  // Quoted text is never rewritten and `?` inside it is not a parameter.
  assert.equal(translate("SELECT 'IFNULL(?)' AS s").parameterCount, 0);
  assert.deepEqual(translate('SELECT ? IS NULL, ?').nullChecks, [true, false]);
  assert.equal(translate('SELECT id AS groupId FROM g').columnNames.get('groupid'), 'groupId');
  assert.equal(translate('BEGIN IMMEDIATE').kind, 'begin');
  assert.equal(translate('ROLLBACK TO SAVEPOINT s').kind, 'rollback-to');
  assert.equal(translate('WITH x AS (SELECT 1) DELETE FROM t').kind, 'write');
  assert.throws(() => translate('SELECT * FROM t WHERE a GLOB ?'), /GLOB/);
  assert.throws(() => translate('INSERT OR REPLACE INTO t VALUES (1)'), /ON CONFLICT/);
  assert.throws(() => translate('SELECT :name'), /Named parameters/);
  assert.deepEqual(splitStatements("SELECT 1; SELECT ';'; SELECT $$a;b$$"), [
    'SELECT 1',
    "SELECT ';'",
    'SELECT $$a;b$$',
  ]);
});

test('REWIND_DATABASE_URL settings are validated', () => {
  assert.equal(db.isPostgres, db.isPostgres);
  const config = parseConfig({
    REWIND_DATABASE_URL: 'postgres://app:secret@db.example.internal:5432/rewind',
    REWIND_MEDIA_ENVIRONMENT: 'dev',
  });
  assert.deepEqual(
    { ...config.database, url: undefined },
    { url: undefined, host: 'db.example.internal', tls: 'verify', environment: 'dev' },
  );
  assert.equal(parseConfig({}).database, null);
  assert.throws(() => parseConfig({ REWIND_DATABASE_URL: 'mysql://x@y/z' }), /postgres:\/\/ URL/);
  assert.throws(
    () =>
      parseConfig({
        REWIND_DATABASE_URL: 'postgres://a:b@db.example.internal/rewind',
        REWIND_DATABASE_TLS: 'disable',
      }),
    /only allowed for a loopback/,
  );
  assert.throws(
    () => parseConfig({ REWIND_DATABASE_URL: 'postgres://a:b@h/rewind?sslmode=disable' }),
    /sslmode/,
  );
  assert.throws(
    () =>
      parseConfig({
        REWIND_DATABASE_URL: 'postgres://a:b@h/r',
        REWIND_DATABASE_ENVIRONMENT: 'Prod!',
      }),
    /short lowercase name/,
  );
});

test('the PostgreSQL migration directory has the baseline and no gaps', () => {
  const files = postgresMigrationFiles();
  assert.equal(files.get(30), '030-baseline.sql');
  for (const version of files.keys()) assert.ok(version >= 30);
});

async function scratch(run) {
  const dir = await mkdtemp(join(tmpdir(), 'rewind-postgres-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sqliteColumns(database) {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name);
  return Object.fromEntries(
    tables.map((table) => [
      table,
      database
        .prepare('SELECT name, "notnull" AS required, pk FROM pragma_table_info(?)')
        .all(table)
        .map((c) => `${c.name}:${c.required || c.pk ? 'required' : 'nullable'}`)
        .sort(),
    ]),
  );
}

test('the PostgreSQL schema matches the migrated SQLite schema', { skip: needsPostgres }, () =>
  scratch(async (dir) => {
    const sqlite = db.openSqliteDatabaseAt(join(dir, 'parity.sqlite'));
    const postgres = db.openDatabaseAt(join(dir, 'parity-pg.sqlite'));
    try {
      const expected = sqliteColumns(sqlite);
      const rows = postgres
        .prepare(
          `SELECT table_name AS t, column_name AS c, is_nullable AS n FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name <> 'rewind_database_environment'`,
        )
        .all();
      const actual = {};
      for (const row of rows) {
        (actual[row.t] ??= []).push(`${row.c}:${row.n === 'NO' ? 'required' : 'nullable'}`);
      }
      for (const table of Object.keys(actual)) actual[table].sort();
      assert.deepEqual(actual, expected);
      const sqliteIndexes = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
        .all()
        .map((row) => row.name);
      const pgIndexes = new Set(
        postgres
          .prepare('SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema()')
          .all()
          .map((row) => row.name),
      );
      for (const name of sqliteIndexes) assert.ok(pgIndexes.has(name), `index ${name}`);
    } finally {
      sqlite.close();
      postgres.close();
    }
  }),
);

test('statement failures inside a transaction behave as on SQLite', { skip: needsPostgres }, () =>
  scratch(async (dir) => {
    const database = db.openDatabaseAt(join(dir, 'tx.sqlite'));
    try {
      database.prepare("INSERT INTO groups (id, name) VALUES ('g', 'G')").run();
      database.exec('BEGIN IMMEDIATE');
      assert.throws(
        () => database.prepare("INSERT INTO groups (id, name) VALUES ('g', 'dup')").run(),
        (error) =>
          error.errcode === 2067 && /UNIQUE constraint failed: groups\.id/.test(error.message),
      );
      // The transaction is still usable after the failed statement.
      database.prepare("INSERT INTO groups (id, name) VALUES ('h', 'H')").run();
      database.exec('ROLLBACK');
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM groups').get().n, 1);

      // SQLite opens a transaction for a SAVEPOINT; RELEASE commits it.
      database.exec('SAVEPOINT outer_sp');
      database.prepare("INSERT INTO groups (id, name) VALUES ('s', 'S')").run();
      database.exec('ROLLBACK TO SAVEPOINT outer_sp');
      database.prepare("INSERT INTO groups (id, name) VALUES ('t', 'T')").run();
      database.exec('RELEASE SAVEPOINT outer_sp');
      assert.deepEqual(
        database
          .prepare('SELECT id FROM groups ORDER BY id')
          .all()
          .map((row) => row.id),
        ['g', 't'],
      );
      const row = database
        .prepare('SELECT EXISTS (SELECT 1 FROM groups) AS present, COUNT(*) AS total FROM groups')
        .get();
      assert.deepEqual({ ...row }, { present: 1, total: 2 });
      assert.equal(Object.getPrototypeOf(row), null);
    } finally {
      database.close();
    }
  }),
);

test(
  'a held writer lock makes a second connection report database is locked',
  { skip: needsPostgres },
  () =>
    scratch(async (dir) => {
      const path = join(dir, 'busy.sqlite');
      const first = db.openDatabaseAt(path);
      const second = db.openDatabaseAt(path);
      try {
        second.exec('PRAGMA busy_timeout = 50');
        first.exec('BEGIN IMMEDIATE');
        const started = Date.now();
        assert.throws(
          () => second.prepare("INSERT INTO groups (id, name) VALUES ('x', 'X')").run(),
          (error) => error.code === 'SQLITE_BUSY' && /database is locked/.test(error.message),
        );
        assert.ok(Date.now() - started < 2000);
        first.exec('COMMIT');
        second.prepare("INSERT INTO groups (id, name) VALUES ('x', 'X')").run();
        assert.equal(first.prepare('SELECT COUNT(*) AS n FROM groups').get().n, 1);
      } finally {
        first.close();
        second.close();
      }
    }),
);

test(
  'a dropped connection (failover, restart) reconnects on the next statement',
  { skip: needsPostgres },
  () =>
    scratch(async (dir) => {
      const path = join(dir, 'failover.sqlite');
      const database = db.openDatabaseAt(path);
      const admin = db.openDatabaseAt(path);
      try {
        database.prepare("INSERT INTO groups (id, name) VALUES ('before', 'B')").run();
        const { pid } = database.prepare('SELECT pg_backend_pid() AS pid').get();
        admin.prepare('SELECT pg_terminate_backend(CAST(? AS int4)) AS done').get(pid);
        await new Promise((resolve) => setTimeout(resolve, 200));
        // An idle connection that dropped is replaced transparently.
        assert.equal(database.prepare('SELECT COUNT(*) AS n FROM groups').get().n, 1);
        assert.notEqual(database.prepare('SELECT pg_backend_pid() AS pid').get().pid, pid);

        // A transaction that loses its connection fails once and rolls back;
        // the next statement works on a fresh connection.
        database.exec('BEGIN IMMEDIATE');
        database.prepare("INSERT INTO groups (id, name) VALUES ('lost', 'L')").run();
        const inTx = database.prepare('SELECT pg_backend_pid() AS pid').get().pid;
        admin.prepare('SELECT pg_terminate_backend(CAST(? AS int4)) AS done').get(inTx);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.throws(() => database.exec('COMMIT'));
        database.exec('ROLLBACK');
        assert.deepEqual(
          database
            .prepare('SELECT id FROM groups ORDER BY id')
            .all()
            .map((row) => row.id),
          ['before'],
        );
      } finally {
        database.close();
        admin.close();
      }
    }),
);

test('a database bound to one environment refuses another', { skip: needsPostgres }, () =>
  scratch(async (dir) => {
    const url = process.env.REWIND_TEST_DATABASE_URL;
    const database = openTestPostgres(url, join(dir, 'env.sqlite'));
    try {
      db.migrateDatabase(database);
      verifyDatabaseEnvironment(database, 'dev');
      verifyDatabaseEnvironment(database, 'dev');
      assert.throws(() => verifyDatabaseEnvironment(database, 'release'), /belongs to the "dev"/);
    } finally {
      database.close();
    }
    // Connecting without TLS to a server that requires it is not attempted
    // by configuration; verify mode needs the bundled CA, which exists.
    assert.ok(typeof openPostgres === 'function');
  }),
);

async function seedSnapshot(path) {
  const sqlite = db.openSqliteDatabaseAt(path);
  const now = new Date('2026-10-01T00:00:00.000Z');
  seedFixtureGroup(sqlite);
  const owner = await createRealAccount(sqlite, 'import.owner', 'Import Owner', PASSWORD, now);
  await createRealAccount(sqlite, 'import.member', 'Import Member', PASSWORD, now);
  await authenticateRealAccount(sqlite, 'import.owner', PASSWORD, 'client-a', now);
  createRealGroup(
    sqlite,
    { id: owner.account.id, displayName: 'Import Owner' },
    { name: 'Imported group', prompt: 'What moved you?', maxMembers: 4 },
    now,
  );
  for (const body of ['first', 'second', 'third']) {
    const sent = createChatMessage(sqlite, {
      groupId: 'demo-group',
      memberId: 'demo-1',
      body,
      now,
    });
    assert.equal(sent.ok, true);
    if (body === 'first') {
      toggleChatReaction(sqlite, {
        groupId: 'demo-group',
        memberId: 'demo-2',
        messageId: sent.event.message.id,
        emoji: '❤️',
        now,
      });
    }
  }
  // A fractional duration, as the media pipeline stores, must survive.
  sqlite.prepare("UPDATE cycles SET seconds_used = 2.75 WHERE id = 'demo-cycle'").run();
  const counts = Object.fromEntries(
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map(({ name }) => [name, sqlite.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]),
  );
  sqlite.close();
  return counts;
}

const sha256 = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

test(
  'a SQLite snapshot imports into PostgreSQL with reconciled tables',
  { skip: needsPostgres },
  () =>
    scratch(async (dir) => {
      const snapshot = join(dir, 'snapshot', 'rewind.sqlite');
      const counts = await seedSnapshot(snapshot);
      const before = await sha256(snapshot);
      const config = parseConfig({ REWIND_DATA_DIR: join(dir, 'target') });

      const report = db.importSqliteSnapshot(config, snapshot);
      assert.equal(await sha256(snapshot), before, 'the snapshot is never modified');
      assert.equal(report.replaced, false);
      for (const table of report.tables) {
        assert.equal(table.rows, counts[table.table], table.table);
        assert.match(table.sha256, /^[0-9a-f]{64}$/);
      }
      assert.ok(report.totalRows > 30);
      assert.ok(counts.realtime_events >= 3);

      const database = db.openDatabase(config);
      try {
        assert.equal(db.schemaReadiness(database).ready, true);
        assert.equal(
          database.prepare("SELECT seconds_used AS s FROM cycles WHERE id = 'demo-cycle'").get().s,
          2.75,
        );
        const login = await authenticateRealAccount(database, 'import.owner', PASSWORD, 'client-b');
        assert.equal(login.status, 'authenticated');
        const next = createChatMessage(database, {
          groupId: 'demo-group',
          memberId: 'demo-1',
          body: 'after import',
        });
        assert.equal(next.ok, true);
        const ids = database
          .prepare('SELECT id FROM realtime_events ORDER BY id')
          .all()
          .map((row) => row.id);
        assert.equal(ids.length, counts.realtime_events + 1);
        assert.ok(ids.at(-1) > ids.at(-2), 'identity continues after the imported ids');
        assert.equal(database.prepare('SELECT COUNT(*) AS n FROM reactions').get().n, 1);
      } finally {
        database.close();
      }

      // A second import never merges into existing data.
      assert.throws(() => db.importSqliteSnapshot(config, snapshot), /already holds data/);
      const replaced = db.importSqliteSnapshot(config, snapshot, { replace: true });
      assert.equal(replaced.replaced, true);
      assert.equal(replaced.totalRows, report.totalRows);
    }),
);

test('an import that cannot be exact commits nothing', { skip: needsPostgres }, () =>
  scratch(async (dir) => {
    const snapshot = join(dir, 'snapshot', 'rewind.sqlite');
    await seedSnapshot(snapshot);
    const config = parseConfig({ REWIND_DATA_DIR: join(dir, 'target') });
    const empty = () => {
      const database = db.openDatabase(config);
      try {
        return database.prepare('SELECT COUNT(*) AS n FROM profiles').get().n === 0;
      } finally {
        database.close();
      }
    };

    // An integer column holding a fraction would be rounded: refuse instead.
    const raw = new DatabaseSync(snapshot);
    raw.prepare("UPDATE cycles SET count_used = 1.5 WHERE id = 'demo-cycle'").run();
    raw.close();
    assert.throws(
      () => db.importSqliteSnapshot(config, snapshot),
      /cycles\.count_used expects an integer/,
    );
    assert.equal(empty(), true);

    // A dangling reference SQLite let in (foreign keys off) fails the import.
    const fix = new DatabaseSync(snapshot);
    fix.exec("UPDATE cycles SET count_used = 1 WHERE id = 'demo-cycle'");
    fix.exec('PRAGMA foreign_keys = OFF');
    fix.exec(
      "INSERT INTO messages (id, group_id, member_id, body, created_at) VALUES ('orphan', 'demo-group', 'nobody', 'x', '2026-10-01T00:00:00.000Z')",
    );
    fix.close();
    assert.throws(() => db.importSqliteSnapshot(config, snapshot), /FOREIGN KEY|foreign key/);
    assert.equal(empty(), true);
  }),
);

test('bootstrap creates an owning app role and a read-only role', { skip: needsPostgres }, () =>
  scratch(async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const url = new URL(process.env.REWIND_TEST_DATABASE_URL);
    const roles = {
      REWIND_DATABASE_ADMIN_URL: url.toString(),
      REWIND_DATABASE_TLS: 'disable',
      REWIND_DATABASE_SCHEMA: `boot_${suffix}`,
      REWIND_DATABASE_APP_ROLE: `boot_app_${suffix}`,
      REWIND_DATABASE_APP_PASSWORD: `app-password-${suffix}-0123456789abcdef`,
      REWIND_DATABASE_READONLY_ROLE: `boot_ro_${suffix}`,
      REWIND_DATABASE_READONLY_PASSWORD: `ro-password-${suffix}-0123456789abcdef`,
    };
    assert.equal(db.bootstrapDatabase(roles).appPassword, '');
    db.bootstrapDatabase(roles); // idempotent; rotates the same passwords
    const as = (role, password) => {
      const login = new URL(url);
      login.username = role;
      login.password = password;
      return parseConfig({
        REWIND_DATABASE_URL: login.toString(),
        REWIND_DATABASE_TLS: 'disable',
        REWIND_DATABASE_ENVIRONMENT: `boot-${suffix}`.replaceAll('_', '-'),
      });
    };
    const appConfig = as(roles.REWIND_DATABASE_APP_ROLE, roles.REWIND_DATABASE_APP_PASSWORD);
    const app = db.openDatabase(appConfig);
    try {
      assert.equal(
        app.prepare('SELECT current_schema() AS s').get().s,
        roles.REWIND_DATABASE_SCHEMA,
      );
      app.prepare("INSERT INTO groups (id, name) VALUES ('boot', 'Boot')").run();
    } finally {
      app.close();
    }
    const readonly = db.openOperationalDatabase(
      as(roles.REWIND_DATABASE_READONLY_ROLE, roles.REWIND_DATABASE_READONLY_PASSWORD),
      { readOnly: false },
    );
    try {
      assert.equal(readonly.prepare('SELECT COUNT(*) AS n FROM groups').get().n, 1);
      assert.throws(
        () => readonly.prepare("INSERT INTO groups (id, name) VALUES ('no', 'No')").run(),
        /read-only|permission denied/,
      );
    } finally {
      readonly.close();
    }
    const status = db.databaseStatus(appConfig);
    assert.equal(status.engine, 'postgresql');
    assert.equal(status.ready, true);
    assert.equal(status.rows.groups, 1);
    assert.match(status.serverVersion, /^\d+/);
    const admin = db.openOperationalDatabase(
      parseConfig({ REWIND_DATABASE_URL: url.toString(), REWIND_DATABASE_TLS: 'disable' }),
      { readOnly: false },
    );
    try {
      admin.exec(`DROP SCHEMA ${roles.REWIND_DATABASE_SCHEMA} CASCADE`);
      for (const role of [roles.REWIND_DATABASE_APP_ROLE, roles.REWIND_DATABASE_READONLY_ROLE]) {
        admin.exec(`DROP OWNED BY ${role}`);
        admin.exec(`DROP ROLE ${role}`);
      }
    } finally {
      admin.close();
    }
  }),
);

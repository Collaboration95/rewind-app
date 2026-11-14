// The SQLite migrations 1-31 were squashed into server/migrations/sqlite-baseline.sql.
// fixtures/sqlite-schema-v31.json is the schema the retired chain built for a
// fresh database (generated once from commit d38a559, tag pre-migration-squash).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { sqliteOnly } from './helpers/dialect.mjs';
import { schemaSnapshot } from './helpers/schema-snapshot.mjs';

const { migrateDatabase, schemaReadiness } = await import('../dist/db.js');

const expected = JSON.parse(
  readFileSync(new URL('./fixtures/sqlite-schema-v31.json', import.meta.url), 'utf8'),
);

async function withDatabase(run) {
  const dir = await mkdtemp(`${tmpdir()}/rewind-baseline-`);
  const path = `${dir}/rewind.sqlite`;
  const open = () => {
    const database = new DatabaseSync(path);
    database.exec(
      'PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;',
    );
    return database;
  };
  try {
    await run(open);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const receipts = (database) => ({
  versions: database.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
  markers: database.prepare('SELECT * FROM schema_migration_markers ORDER BY migration_key').all(),
});

test('a fresh database gets exactly the schema of the retired chain', { skip: sqliteOnly }, () =>
  withDatabase((open) => {
    const database = open();
    try {
      migrateDatabase(database);
      assert.deepEqual(schemaSnapshot(database), expected);
      assert.equal(schemaReadiness(database).ready, true);
      assert.equal(schemaReadiness(database).expectedMigrationVersion, 31);
      const { versions, markers } = receipts(database);
      assert.deepEqual(
        versions.map((row) => row.version),
        Array.from({ length: 31 }, (_, index) => index + 1),
      );
      assert.equal(markers.length, 31);
    } finally {
      database.close();
    }
  }),
);

test('a database already at version 31 opens without any change', { skip: sqliteOnly }, () =>
  withDatabase((open) => {
    let database = open();
    migrateDatabase(database);
    const before = {
      cookie: database.prepare('PRAGMA schema_version').get().schema_version,
      receipts: receipts(database),
      snapshot: schemaSnapshot(database),
    };
    database.close();
    database = open();
    try {
      migrateDatabase(database);
      migrateDatabase(database);
      assert.equal(database.prepare('PRAGMA schema_version').get().schema_version, before.cookie);
      assert.deepEqual(receipts(database), before.receipts);
      assert.deepEqual(schemaSnapshot(database), before.snapshot);
      assert.equal(schemaReadiness(database).ready, true);
    } finally {
      database.close();
    }
  }),
);

test(
  'a database below version 31 is refused with an upgrade instruction',
  { skip: sqliteOnly },
  () =>
    withDatabase((open) => {
      const database = open();
      try {
        migrateDatabase(database);
        database.exec(
          "DELETE FROM schema_migrations WHERE version >= 30; DELETE FROM schema_migration_markers WHERE migration_key IN ('moderation-records-v1', 'cognito-accounts-v1');",
        );
        assert.deepEqual(schemaReadiness(database).missingMigrationKeys, [
          'moderation-records-v1',
          'cognito-accounts-v1',
        ]);
        const cookie = database.prepare('PRAGMA schema_version').get().schema_version;
        assert.throws(() => migrateDatabase(database), /schema version 29.*pre-migration-squash/s);
        assert.equal(database.prepare('PRAGMA schema_version').get().schema_version, cookie);
        assert.equal(schemaReadiness(database).ready, false);
      } finally {
        database.close();
      }
    }),
);

test(
  'a database with tables but no migration receipts is refused, not overwritten',
  { skip: sqliteOnly },
  () =>
    withDatabase((open) => {
      const database = open();
      try {
        database.exec('CREATE TABLE groups (id TEXT PRIMARY KEY)');
        assert.throws(() => migrateDatabase(database), /pre-migration-squash/);
        assert.equal(
          database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n,
          1 + 2, // groups plus the two receipt tables
        );
      } finally {
        database.close();
      }
    }),
);

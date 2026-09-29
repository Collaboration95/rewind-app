import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { migrateDatabase, openDatabase, schemaReadiness } = await import('../dist/db.js');

test('real invite and media migrations 020–023 apply once and participate in schema readiness', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-migration-chain-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  try {
    const expectedReceipts = [
      [20, 'real-group-invites-v1'],
      [21, 'real-group-invite-acceptance-v1'],
      [22, 'real-media-profile-bridge-v1'],
      [23, 'photo-media-v1'],
    ];
    const assertChainReceipts = () => {
      for (const [version, key] of expectedReceipts) {
        assert.equal(
          database
            .prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?')
            .get(version).count,
          1,
        );
        assert.equal(
          database
            .prepare(
              'SELECT COUNT(*) AS count FROM schema_migration_markers WHERE migration_key = ?',
            )
            .get(key).count,
          1,
        );
      }
    };
    const assertInviteSchema = () => {
      const columns = new Set(
        database
          .prepare('PRAGMA table_info(real_group_invites)')
          .all()
          .map((column) => column.name),
      );
      for (const column of ['code', 'status', 'accepted_by_account_id', 'accepted_at']) {
        assert.equal(columns.has(column), true, `real_group_invites includes ${column}`);
      }
    };

    assertChainReceipts();
    assertInviteSchema();
    assert.equal(schemaReadiness(database).expectedMigrationVersion, 23);
    assert.deepEqual(schemaReadiness(database).missingMigrationKeys, []);
    assert.ok(
      database
        .prepare('PRAGMA table_info(media_jobs)')
        .all()
        .some((column) => column.name === 'media_type'),
    );
    assert.ok(
      database
        .prepare('PRAGMA table_info(media_metadata)')
        .all()
        .some((column) => column.name === 'media_type'),
    );

    migrateDatabase(database);
    assertChainReceipts();
    assertInviteSchema();
    assert.equal(schemaReadiness(database).ready, true);

    database.exec('DROP TRIGGER real_profile_media_actor_update;');
    assert.deepEqual(schemaReadiness(database).missingMigrationKeys, [
      'real-media-profile-bridge-v1',
    ]);
    migrateDatabase(database);

    assert.equal(schemaReadiness(database).ready, true);
    assertChainReceipts();
    assertInviteSchema();
    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'trigger'
             AND name IN ('real_profile_media_actor_insert', 'real_profile_media_actor_delete', 'real_profile_media_actor_update')`,
        )
        .get().count,
      3,
    );
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

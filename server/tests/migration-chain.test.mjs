import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';
import { sqliteOnly } from './helpers/dialect.mjs';

const { parseConfig } = await import('../dist/config.js');
const { migrateDatabase, schemaReadiness } = await import('../dist/db.js');

test(
  'real invite and media migrations 020–024 apply once and participate in schema readiness',
  { skip: sqliteOnly },
  async () => {
    const dataDir = await mkdtemp(`${tmpdir()}/rewind-migration-chain-`);
    const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
    const database = openFixtureDatabase(config);
    try {
      const expectedReceipts = [
        [20, 'real-group-invites-v1'],
        [21, 'real-group-invite-acceptance-v1'],
        [22, 'real-media-profile-bridge-v1'],
        [23, 'photo-media-v1'],
        [24, 'real-invite-guess-throttles-v1'],
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
        assert.ok(
          database
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'real_invite_guess_throttles'",
            )
            .get(),
        );
      };

      assertChainReceipts();
      assertInviteSchema();
      assert.equal(schemaReadiness(database).expectedMigrationVersion, 31);
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

      database.exec('DROP TABLE real_invite_guess_throttles;');
      assert.deepEqual(schemaReadiness(database).missingMigrationKeys, [
        'real-invite-guess-throttles-v1',
      ]);
      migrateDatabase(database);
      assert.equal(schemaReadiness(database).ready, true);
      assertInviteSchema();
    } finally {
      database.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  'moderation migration upgrades existing reports once and indexes every deletion lookup',
  { skip: sqliteOnly },
  async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { readFileSync } = await import('node:fs');
    const database = new DatabaseSync(':memory:');
    try {
      migrateDatabase(database);
      // Recreate exactly the pre-030 safety tables and receipts to exercise upgrade.
      database.exec(
        'DROP INDEX contributions_removed_by_account_idx; DROP TABLE content_reports; DROP TABLE member_reports; DROP TABLE account_blocks; DROP TABLE film_segments;',
      );
      database.exec(readFileSync('server/migrations/028-content-safety.sql', 'utf8'));
      const oldMembers = readFileSync('server/migrations/029-member-reports.sql', 'utf8');
      database.exec(oldMembers.slice(0, oldMembers.indexOf('ALTER TABLE contributions')));
      database.exec(
        oldMembers.slice(oldMembers.indexOf('CREATE TABLE IF NOT EXISTS film_segments')),
      );
      database.exec(
        "DELETE FROM schema_migrations WHERE version = 30; DELETE FROM schema_migration_markers WHERE migration_key = 'moderation-records-v1';",
      );
      const { createRealAccount } = await import('../dist/auth/index.js');
      const reporter = await createRealAccount(
        database,
        'migration-reporter',
        'Reporter',
        'a sufficiently long password',
      );
      const target = await createRealAccount(
        database,
        'migration-target',
        'Target',
        'a sufficiently long password',
      );
      assert.equal(reporter.ok, true);
      assert.equal(target.ok, true);
      // Real parent rows make the legacy copy pass the runner's FK check.
      database.exec(
        "INSERT INTO profiles VALUES ('migration-profile', 'Fixture', 'F', 1); INSERT INTO groups (id, name) VALUES ('migration-group', 'Fixture');",
      );
      database
        .prepare('INSERT INTO member_reports VALUES (?, ?, ?, ?, ?, ?)')
        .run('legacy', reporter.account.id, 'migration-group', target.account.id, 'reason', 'time');
      database.exec('PRAGMA foreign_keys = ON;');
      migrateDatabase(database);
      assert.equal(
        database.prepare('SELECT reason FROM member_reports WHERE id = ?').get('legacy').reason,
        'reason',
      );
      database.prepare('DELETE FROM real_accounts WHERE id = ?').run(target.account.id);
      assert.equal(
        database.prepare('SELECT reported_account_id FROM member_reports').get()
          .reported_account_id,
        null,
      );
      migrateDatabase(database);
      assert.equal(
        database.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 30').get().n,
        1,
      );
      for (const [table, column, index] of [
        ['content_reports', 'message_id', 'content_reports_message_idx'],
        ['content_reports', 'contribution_id', 'content_reports_contribution_idx'],
        ['content_reports', 'group_id', 'content_reports_group_idx'],
        ['member_reports', 'reported_account_id', 'member_reports_reported_account_idx'],
        ['member_reports', 'group_id', 'member_reports_group_idx'],
        ['account_blocks', 'blocked_account_id', 'account_blocks_blocked_account_idx'],
        ['film_segments', 'contribution_id', 'film_segments_contribution_idx'],
        ['contributions', 'removed_by_account_id', 'contributions_removed_by_account_idx'],
      ]) {
        const plan = database
          .prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE ${column} = ?`)
          .all('target');
        assert.ok(
          plan.some((row) => row.detail.includes(index)),
          `${table}.${column} uses ${index}`,
        );
      }
      for (const table of ['member_reports', 'content_reports']) {
        const targets = database
          .prepare(`PRAGMA foreign_key_list(${table})`)
          .all()
          .filter((fk) => fk.from !== 'reporter_account_id');
        assert.ok(targets.every((fk) => fk.on_delete === 'SET NULL'));
      }
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
    }
  },
);

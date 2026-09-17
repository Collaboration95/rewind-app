import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import type { RuntimeConfig } from './config';
import { DEMO_SESSION_LIFETIME_MS } from './session/contract';

const MIGRATIONS = [
  // `key` is the durable identity. Version 6 is reserved here for quota;
  // #54's cycle-lifecycle migration must use its own key and the next free
  // version during integration rather than claiming this slot again.
  { version: 1, key: 'initial-v1', fileName: '001-initial.sql' },
  { version: 2, key: 'session-audit-v1', fileName: '002-session-audit.sql' },
  { version: 3, key: 'cycle-controls-v1', fileName: '003-cycle-controls.sql' },
  { version: 4, key: 'invites-v1', fileName: '004-invites.sql' },
  { version: 5, key: 'media-idempotency-v1', fileName: '005-media-idempotency.sql' },
  { version: 6, key: 'contribution-quota-v1', fileName: '006-contribution-quota.sql' },
  { version: 7, key: 'media-processing-v1', fileName: '007-media-processing.sql' },
  { version: 8, key: 'media-source-binding-v1', fileName: '008-media-source-binding.sql' },
  // #54 originally claimed version 006.  Keep lifecycle's durable identity
  // at a distinct version so both upgrade orders remain unambiguous.
  { version: 9, key: 'cycle-lifecycle-v1', fileName: '009-cycle-lifecycle.sql' },
  { version: 10, key: 'contribution-deletion-v1', fileName: '010-contribution-deletion.sql' },
  // Realtime transport originally shipped with a second 006 filename. Keep
  // its durable identity distinct from quota/lifecycle while preserving the
  // migration SQL for fresh installs and upgrades.
  { version: 11, key: 'realtime-messages-v1', fileName: '006-realtime-messages.sql' },
  { version: 12, key: 'chat-replies-reactions-v1', fileName: '007-chat-replies-reactions.sql' },
  { version: 13, key: 'compilation-retry-v1', fileName: '013-compilation-retry.sql' },
].map((migration) => ({
  ...migration,
  sql: readFileSync(resolve(process.cwd(), 'server/migrations', migration.fileName), 'utf8'),
}));
const FIXTURE = JSON.parse(
  readFileSync(resolve(process.cwd(), 'server/fixtures/demo-fixture.json'), 'utf8'),
) as DemoFixture;

export interface DemoFixture {
  seedVersion: number;
  profiles: { id: string; displayName: string; avatarLabel: string }[];
  group: { id: string; name: string; currentCycleId: string };
  cycle: {
    id: string;
    prompt: string;
    startsAt: string;
    endsAt: string;
    status: string;
    lockState: string;
    maxCount: number;
    maxSeconds: number;
    countUsed: number;
    secondsUsed: number;
  };
  acceptedAt: string;
  message: { id: string; body: string };
  contribution: { id: string; durationSeconds: number };
  mediaJobs: { id: string; kind: 'clip' | 'film' | 'download' }[];
}

export type RewindDatabase = DatabaseSync;

export interface SchemaReadiness {
  ready: boolean;
  expectedMigrationVersion: number;
  missingMigrationKeys: string[];
}

/**
 * The durable migration marker and version receipts are the hosted Demo's
 * schema contract. Startup applies this contract before accepting traffic;
 * health checks repeat it so an interrupted or manually damaged migration is
 * never reported as ready.
 */
export function schemaReadiness(database: RewindDatabase): SchemaReadiness {
  const missingMigrationKeys = MIGRATIONS.filter((migration) => {
    const marked = database
      .prepare('SELECT 1 AS applied FROM schema_migration_markers WHERE migration_key = ?')
      .get(migration.key) as { applied?: number } | undefined;
    const versioned = database
      .prepare('SELECT 1 AS applied FROM schema_migrations WHERE version = ?')
      .get(migration.version) as { applied?: number } | undefined;
    return !marked?.applied || !versioned?.applied || migrationNeedsRepair(database, migration.key);
  }).map((migration) => migration.key);
  return {
    ready: missingMigrationKeys.length === 0,
    expectedMigrationVersion: Math.max(...MIGRATIONS.map((migration) => migration.version)),
    missingMigrationKeys,
  };
}

export function openDatabase(config: RuntimeConfig): RewindDatabase {
  mkdirSync(config.dataDir, { recursive: true });
  const database = new DatabaseSync(config.databasePath);
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  migrateDatabase(database);
  seedDatabase(database);
  return database;
}

export function openDatabaseAt(databasePath: string): RewindDatabase {
  const dataDir = resolve(databasePath, '..');
  mkdirSync(dataDir, { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  migrateDatabase(database);
  seedDatabase(database);
  return database;
}

export function migrateDatabase(database: RewindDatabase): void {
  database.exec('PRAGMA busy_timeout = 5000;');
  database.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);',
  );
  database.exec(
    'CREATE TABLE IF NOT EXISTS schema_migration_markers (migration_key TEXT PRIMARY KEY, applied_at TEXT NOT NULL);',
  );
  for (const migration of MIGRATIONS) {
    const marked = database
      .prepare('SELECT 1 AS applied FROM schema_migration_markers WHERE migration_key = ?')
      .get(migration.key) as { applied?: number } | undefined;
    const applied = database
      .prepare('SELECT 1 AS applied FROM schema_migrations WHERE version = ?')
      .get(migration.version) as { applied?: number } | undefined;
    const needsRepair = migrationNeedsRepair(database, migration.key);
    if (marked?.applied && applied?.applied && !needsRepair) continue;

    beginMigrationTransaction(database);
    try {
      // Re-read after acquiring the writer lock: a concurrent starter may
      // have completed this migration while this connection was waiting.
      const appliedInside = database
        .prepare('SELECT 1 AS applied FROM schema_migrations WHERE version = ?')
        .get(migration.version) as { applied?: number } | undefined;
      if (migration.key === 'contribution-quota-v1') {
        applyContributionQuotaMigration(database);
      } else if (migration.key === 'media-processing-v1') {
        applyMediaProcessingMigration(database);
      } else if (migration.key === 'media-source-binding-v1') {
        applyMediaSourceBindingMigration(database);
      } else if (migration.key === 'cycle-lifecycle-v1') {
        applyCycleLifecycleMigration(database);
      } else if (migration.key === 'contribution-deletion-v1') {
        applyContributionDeletionMigration(database);
      } else if (migration.key === 'chat-replies-reactions-v1') {
        applyChatRepliesReactionsMigration(database);
      } else if (migration.key === 'compilation-retry-v1') {
        applyCompilationRetryMigration(database);
      } else if (!appliedInside?.applied) {
        database.exec(migration.sql);
      }
      // Version 006 is occupied by the old #54 lifecycle migration in some
      // databases. Its row is retained; stable markers distinguish the
      // canonical #44 quota identity from that historical shape.
      if (!appliedInside?.applied) {
        database
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString());
      }
      markMigration(database, migration.key);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

function beginMigrationTransaction(database: RewindDatabase): void {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      database.exec('BEGIN IMMEDIATE');
      return;
    } catch (error) {
      const candidate = error as { code?: string; message?: string };
      const busy =
        candidate.code === 'SQLITE_BUSY' ||
        /database is locked|SQLITE_BUSY/i.test(candidate.message ?? '');
      if (!busy || attempt === 7) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2 ** attempt);
    }
  }
}

function migrationNeedsRepair(database: RewindDatabase, key: string): boolean {
  if (key === 'contribution-quota-v1')
    return !quotaSchemaReady(database) || Boolean(hasTable(database, 'staged_media_sources'));
  if (key === 'media-processing-v1') {
    return ![
      'source_path',
      'trim_start_seconds',
      'trim_end_seconds',
      'mode',
      'error_code',
      'processing_started_at',
    ].every((column) => tableColumns(database, 'media_jobs').has(column));
  }
  if (key === 'media-source-binding-v1') return !sourceBindingSchemaReady(database);
  if (key === 'cycle-lifecycle-v1') return cycleLifecycleMigrationNeedsRepair(database);
  if (key === 'contribution-deletion-v1') return !contributionDeletionSchemaReady(database);
  if (key === 'chat-replies-reactions-v1') return !chatRepliesReactionsSchemaReady(database);
  if (key === 'compilation-retry-v1') return !compilationRetrySchemaReady(database);
  return false;
}

function chatRepliesReactionsSchemaReady(database: RewindDatabase): boolean {
  return (
    hasColumns(database, 'messages', ['reply_to_message_id']) &&
    indexMatches(
      database,
      'messages_reply_to_idx',
      false,
      ['reply_to_message_id'],
      'none',
      'messages',
    )
  );
}

/** Apply the chat reply schema defensively when an upgrade was interrupted
 * after the ALTER but before its migration receipt was written. */
function applyChatRepliesReactionsMigration(database: RewindDatabase): void {
  if (!hasColumns(database, 'messages', ['reply_to_message_id'])) {
    database.exec(
      'ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;',
    );
  }
  database.exec(
    'CREATE INDEX IF NOT EXISTS messages_reply_to_idx ON messages (reply_to_message_id);',
  );
}

function compilationJobsSchemaReady(database: RewindDatabase): boolean {
  return (
    hasColumns(database, 'media_jobs', [
      'cycle_id',
      'progress',
      'input_count',
      'completed_count',
      'claim_generation',
    ]) &&
    compilationJobInputsTableIsValid(database) &&
    indexMatches(
      database,
      'media_jobs_cycle_idx',
      false,
      ['cycle_id', 'kind', 'created_at'],
      'none',
      'media_jobs',
    ) &&
    indexMatches(
      database,
      'media_jobs_one_film_per_cycle_idx',
      true,
      ['cycle_id'],
      'film-cycle',
      'media_jobs',
    ) &&
    indexMatches(
      database,
      'compilation_job_inputs_order_idx',
      false,
      ['job_id', 'position'],
      'none',
      'compilation_job_inputs',
    )
  );
}

function compilationRetrySchemaReady(database: RewindDatabase): boolean {
  return hasColumns(database, 'media_jobs', ['attempt_count']);
}

interface CompilationInputForeignKey {
  table?: string;
  from?: string;
  to?: string;
  on_delete?: string;
}

/** Validate the complete durable shape, not merely the existence of names.
 * Migration receipts can outlive an interrupted or hand-edited DDL change. */
function compilationJobInputsTableIsValid(database: RewindDatabase): boolean {
  if (!hasTable(database, 'compilation_job_inputs')) return false;
  const columns = database.prepare('PRAGMA table_info(compilation_job_inputs)').all() as {
    name?: string;
    type?: string;
    notnull?: number;
    pk?: number;
  }[];
  const expected = [
    ['job_id', 'TEXT', 1, 1],
    ['clip_job_id', 'TEXT', 1, 2],
    ['contribution_id', 'TEXT', 1, 0],
    ['position', 'INTEGER', 1, 0],
  ] as const;
  if (
    columns.length !== expected.length ||
    !expected.every(([name, type, notnull, pk], index) => {
      const column = columns[index];
      return (
        column?.name === name &&
        String(column.type ?? '').toUpperCase() === type &&
        Number(column.notnull) === notnull &&
        Number(column.pk) === pk
      );
    })
  ) {
    return false;
  }
  const table = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'compilation_job_inputs'",
    )
    .get() as { sql?: string } | undefined;
  if (!table?.sql) return false;
  const sql = table.sql.replace(/["`]/g, '').replace(/\s+/g, ' ').toLowerCase();
  if (
    !/primary\s+key\s*\(\s*job_id\s*,\s*clip_job_id\s*\)/.test(sql) ||
    !/unique\s*\(\s*job_id\s*,\s*contribution_id\s*\)/.test(sql) ||
    !/check\s*\(\s*position\s*>=\s*0\s*\)/.test(sql)
  ) {
    return false;
  }
  const foreignKeys = database
    .prepare('PRAGMA foreign_key_list(compilation_job_inputs)')
    .all() as CompilationInputForeignKey[];
  if (foreignKeys.length !== 3) return false;
  const requiredForeignKeys = [
    ['job_id', 'media_jobs'],
    ['clip_job_id', 'media_jobs'],
    ['contribution_id', 'contributions'],
  ] as const;
  return requiredForeignKeys.every(([from, tableName]) =>
    foreignKeys.some(
      (foreignKey) =>
        foreignKey.from === from &&
        foreignKey.table === tableName &&
        foreignKey.to === 'id' &&
        String(foreignKey.on_delete ?? '').toUpperCase() === 'CASCADE',
    ),
  );
}

function contributionDeletionSchemaReady(database: RewindDatabase): boolean {
  return (
    hasColumns(database, 'contributions', ['deleted_at']) &&
    hasColumns(database, 'media_jobs', ['deleted_at']) &&
    hasColumns(database, 'contribution_quota_windows', ['deletions_used']) &&
    indexMatches(
      database,
      'contributions_active_cycle_idx',
      false,
      ['cycle_id', 'member_id', 'deleted_at', 'created_at'],
      'none',
      'contributions',
    )
  );
}

function applyContributionDeletionMigration(database: RewindDatabase): void {
  if (!tableColumns(database, 'contributions').has('deleted_at')) {
    database.exec('ALTER TABLE contributions ADD COLUMN deleted_at TEXT');
  }
  if (!tableColumns(database, 'media_jobs').has('deleted_at')) {
    database.exec('ALTER TABLE media_jobs ADD COLUMN deleted_at TEXT');
  }
  if (!tableColumns(database, 'contribution_quota_windows').has('deletions_used')) {
    database.exec(
      'ALTER TABLE contribution_quota_windows ADD COLUMN deletions_used INTEGER NOT NULL DEFAULT 0 CHECK (deletions_used >= 0 AND deletions_used <= 1)',
    );
  }
  if (
    !indexMatches(
      database,
      'contributions_active_cycle_idx',
      false,
      ['cycle_id', 'member_id', 'deleted_at', 'created_at'],
      'none',
      'contributions',
    )
  ) {
    database.exec('DROP INDEX IF EXISTS contributions_active_cycle_idx');
    database.exec(
      'CREATE INDEX contributions_active_cycle_idx ON contributions (cycle_id, member_id, deleted_at, created_at)',
    );
  }
}

function quotaSchemaReady(database: RewindDatabase): boolean {
  return (
    tableColumns(database, 'contributions').has('quota_window_start_at') &&
    hasColumns(database, 'media_metadata', [
      'source_uri',
      'mime_type',
      'byte_length',
      'duration_seconds',
      'width',
      'height',
      'has_audio',
      'verified_at',
    ]) &&
    hasColumns(database, 'staged_sources', [
      'source_id',
      'source_uri',
      'idempotency_key_hash',
      'group_id',
      'member_id',
      'source_path',
      'byte_length',
      'status',
      'created_at',
      'claim_generation',
      'claim_expires_at',
    ]) &&
    hasColumns(database, 'contribution_quota_windows', [
      'id',
      'cycle_id',
      'member_id',
      'window_start_at',
      'window_end_at',
      'max_count',
      'max_seconds',
      'count_used',
      'seconds_used',
    ]) &&
    ['source_path', 'claim_generation', 'claim_expires_at'].every((column) =>
      tableColumns(database, 'staged_sources').has(column),
    ) &&
    hasIndex(database, 'staged_sources_owner_idx') &&
    hasIndex(database, 'contribution_quota_windows_member_idx')
  );
}

function applyContributionQuotaMigration(database: RewindDatabase): void {
  if (!tableColumns(database, 'contributions').has('quota_window_start_at')) {
    database.exec('ALTER TABLE contributions ADD COLUMN quota_window_start_at TEXT');
  }
  database.exec(
    `CREATE TABLE IF NOT EXISTS media_metadata (
      source_uri TEXT PRIMARY KEY,
      mime_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length > 0),
      duration_seconds REAL NOT NULL CHECK (duration_seconds > 0 AND duration_seconds <= 15),
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      has_audio INTEGER NOT NULL CHECK (has_audio = 1),
      verified_at TEXT NOT NULL
    )`,
  );
  database.exec(
    `CREATE TABLE IF NOT EXISTS staged_sources (
      source_id TEXT PRIMARY KEY,
      source_uri TEXT NOT NULL UNIQUE,
      idempotency_key_hash TEXT NOT NULL UNIQUE,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      source_path TEXT,
      byte_length INTEGER CHECK (byte_length IS NULL OR byte_length > 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'staged')),
      created_at TEXT NOT NULL,
      claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
      claim_expires_at TEXT
    )`,
  );
  const stagedColumns = tableColumns(database, 'staged_sources');
  if (!stagedColumns.has('source_path'))
    database.exec('ALTER TABLE staged_sources ADD COLUMN source_path TEXT');
  if (!stagedColumns.has('claim_generation'))
    database.exec(
      'ALTER TABLE staged_sources ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0',
    );
  if (!stagedColumns.has('claim_expires_at'))
    database.exec('ALTER TABLE staged_sources ADD COLUMN claim_expires_at TEXT');
  database.exec(
    `CREATE INDEX IF NOT EXISTS staged_sources_owner_idx
       ON staged_sources (group_id, member_id, created_at DESC)`,
  );
  database.exec(
    `CREATE TABLE IF NOT EXISTS contribution_quota_windows (
      id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      window_start_at TEXT NOT NULL,
      window_end_at TEXT NOT NULL,
      max_count INTEGER NOT NULL CHECK (max_count > 0 AND max_count <= 5),
      max_seconds INTEGER NOT NULL CHECK (max_seconds > 0 AND max_seconds <= 30),
      count_used INTEGER NOT NULL DEFAULT 0 CHECK (count_used >= 0),
      seconds_used INTEGER NOT NULL DEFAULT 0 CHECK (seconds_used >= 0),
      UNIQUE (cycle_id, member_id, window_start_at)
    )`,
  );
  database.exec(
    `CREATE INDEX IF NOT EXISTS contribution_quota_windows_member_idx
       ON contribution_quota_windows (cycle_id, member_id, window_start_at)`,
  );
  // Backfill and promotion are idempotent and stay inside the same migration
  // transaction as the DDL and receipt.
  database.exec(
    `INSERT OR IGNORE INTO contribution_quota_windows
      (id, cycle_id, member_id, window_start_at, window_end_at,
       max_count, max_seconds, count_used, seconds_used)
     SELECT
       'contribution-quota-legacy-' || c.cycle_id || '-' || c.member_id || '-' ||
         CAST(MAX(0, (julianday(c.created_at) - julianday(cy.starts_at)) / 7) AS INTEGER),
       c.cycle_id,
       c.member_id,
       strftime(
         '%Y-%m-%dT%H:%M:%fZ', cy.starts_at,
         printf('+%d days', 7 * CAST(MAX(0, (julianday(c.created_at) - julianday(cy.starts_at)) / 7) AS INTEGER))
       ),
       strftime(
         '%Y-%m-%dT%H:%M:%fZ', cy.starts_at,
         printf('+%d days', 7 * (CAST(MAX(0, (julianday(c.created_at) - julianday(cy.starts_at)) / 7) AS INTEGER) + 1))
       ),
       MIN(5, MAX(1, cy.max_count)),
       MIN(30, MAX(1, cy.max_seconds)),
       COUNT(*),
       SUM(c.duration_seconds)
     FROM contributions c
     JOIN cycles cy ON cy.id = c.cycle_id
     GROUP BY c.cycle_id, c.member_id,
       CAST(MAX(0, (julianday(c.created_at) - julianday(cy.starts_at)) / 7) AS INTEGER)`,
  );
  database.exec(
    `UPDATE contributions
     SET quota_window_start_at = (
       SELECT strftime(
         '%Y-%m-%dT%H:%M:%fZ', cy.starts_at,
         printf('+%d days', 7 * CAST(MAX(0, (julianday(contributions.created_at) - julianday(cy.starts_at)) / 7) AS INTEGER))
       )
       FROM cycles cy WHERE cy.id = contributions.cycle_id
     )
     WHERE quota_window_start_at IS NULL`,
  );
  migrateLegacyStagedSources(database);
}

function applyMediaProcessingMigration(database: RewindDatabase): void {
  const columns = tableColumns(database, 'media_jobs');
  for (const [name, type] of [
    ['source_path', 'TEXT'],
    ['trim_start_seconds', 'REAL'],
    ['trim_end_seconds', 'REAL'],
    ['mode', 'TEXT'],
    ['error_code', 'TEXT'],
    ['processing_started_at', 'TEXT'],
  ] as const) {
    if (!columns.has(name)) database.exec(`ALTER TABLE media_jobs ADD COLUMN ${name} ${type}`);
  }
}

function sourceBindingSchemaReady(database: RewindDatabase): boolean {
  return (
    hasTable(database, 'media_jobs') &&
    ['source_uri', 'source_generation'].every((column) =>
      tableColumns(database, 'media_jobs').has(column),
    ) &&
    Boolean(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'media_jobs_source_binding_idx'",
        )
        .get(),
    )
  );
}

function applyMediaSourceBindingMigration(database: RewindDatabase): void {
  const columns = tableColumns(database, 'media_jobs');
  if (!columns.has('source_uri'))
    database.exec('ALTER TABLE media_jobs ADD COLUMN source_uri TEXT');
  if (!columns.has('source_generation'))
    database.exec('ALTER TABLE media_jobs ADD COLUMN source_generation INTEGER');
  if (tableColumns(database, 'media_jobs').has('source_path')) {
    database.exec(
      `CREATE INDEX IF NOT EXISTS media_jobs_source_binding_idx
         ON media_jobs (source_uri, source_generation, source_path)`,
    );
    if (hasTable(database, 'staged_sources')) {
      database.exec(
        `UPDATE media_jobs
         SET source_uri = (
               SELECT source_uri FROM staged_sources
               WHERE staged_sources.source_path = media_jobs.source_path LIMIT 1
             ),
             source_generation = (
               SELECT claim_generation FROM staged_sources
               WHERE staged_sources.source_path = media_jobs.source_path LIMIT 1
             )
         WHERE source_path IS NOT NULL AND source_uri IS NULL`,
      );
    }
  }
}

function cycleLifecycleMigrationNeedsRepair(database: RewindDatabase): boolean {
  const cycleColumns = tableColumns(database, 'cycles');
  if (
    !cycleColumns.has('release_status') ||
    !cycleColumns.has('release_published_at') ||
    !cycleColumns.has('previous_cycle_id')
  ) {
    return true;
  }
  if (!hasTable(database, 'cycle_lifecycle_events') || !lifecycleTableIsValid(database)) {
    return true;
  }
  return (
    !indexMatches(database, 'cycles_previous_cycle_idx', true, ['previous_cycle_id']) ||
    !indexMatches(database, 'cycle_lifecycle_events_group_idx', false, [
      'group_id',
      'occurred_at',
      'id',
    ]) ||
    !indexMatches(database, 'cycle_lifecycle_events_receipt_idx', true, [
      'cycle_id',
      'transition',
    ]) ||
    !compilationJobsSchemaReady(database)
  );
}

type IndexWhereExpectation = 'ignore' | 'none' | 'film-cycle';

function indexMatches(
  database: RewindDatabase,
  name: string,
  unique: boolean,
  columns: string[],
  where: IndexWhereExpectation = 'ignore',
  table?: string,
): boolean {
  const index = (table ? [table] : ['cycles', 'cycle_lifecycle_events'])
    .flatMap((table) => database.prepare(`PRAGMA index_list(${table})`).all())
    .find((row) => String((row as { name?: unknown }).name) === name) as
    { name?: string; unique?: number } | undefined;
  if (!index || Number(index.unique) !== (unique ? 1 : 0)) return false;
  if (where !== 'ignore') {
    const definition = database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(name) as { sql?: string } | undefined;
    const sql = String(definition?.sql ?? '')
      .replace(/["`]/g, '')
      .replace(/\s+/g, ' ')
      .toLowerCase();
    if (where === 'none' && /\bwhere\b/.test(sql)) return false;
    if (
      where === 'film-cycle' &&
      !/where\s+kind\s*=\s*'film'\s+and\s+cycle_id\s+is\s+not\s+null/.test(sql)
    ) {
      return false;
    }
  }
  const indexColumns = database
    .prepare(`PRAGMA index_info(${name})`)
    .all()
    .sort(
      (left, right) =>
        Number((left as { seqno?: number }).seqno) - Number((right as { seqno?: number }).seqno),
    )
    .map((row) => String((row as { name?: unknown }).name));
  return (
    indexColumns.length === columns.length &&
    indexColumns.every((column, indexPosition) => column === columns[indexPosition])
  );
}

function lifecycleTableIsValid(database: RewindDatabase): boolean {
  const table = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cycle_lifecycle_events'",
    )
    .get() as { sql?: string } | undefined;
  if (!table?.sql) return false;
  const columnRows = database.prepare('PRAGMA table_info(cycle_lifecycle_events)').all() as {
    name?: string;
    notnull?: number;
    pk?: number;
  }[];
  const columns = new Set(columnRows.map((column) => String(column.name)));
  const primaryKey = columnRows.find((column) => column.name === 'id');
  const foreignKeys = database.prepare('PRAGMA foreign_key_list(cycle_lifecycle_events)').all() as {
    table?: string;
    from?: string;
    on_delete?: string;
  }[];
  const sql = table.sql.replace(/\s+/g, ' ').toLowerCase();
  return (
    columns.has('id') &&
    primaryKey?.pk === 1 &&
    ['cycle_id', 'group_id', 'transition', 'occurred_at'].every(
      (column) =>
        columns.has(column) && columnRows.find((row) => row.name === column)?.notnull === 1,
    ) &&
    foreignKeys.some(
      (foreignKey) =>
        foreignKey.table === 'cycles' &&
        foreignKey.from === 'cycle_id' &&
        foreignKey.on_delete?.toUpperCase() === 'CASCADE',
    ) &&
    foreignKeys.some(
      (foreignKey) =>
        foreignKey.table === 'groups' &&
        foreignKey.from === 'group_id' &&
        foreignKey.on_delete?.toUpperCase() === 'CASCADE',
    ) &&
    /unique\s*\(\s*cycle_id\s*,\s*transition\s*\)/.test(sql) &&
    /check\s*\(\s*transition\s+in\s*\(/.test(sql)
  );
}

function rebuildLifecycleTable(database: RewindDatabase): void {
  const legacyTable = 'cycle_lifecycle_events_recovery';
  database.exec(`DROP TABLE IF EXISTS ${legacyTable}`);
  database.exec(`ALTER TABLE cycle_lifecycle_events RENAME TO ${legacyTable}`);
  database.exec(
    `CREATE TABLE cycle_lifecycle_events (
      id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      transition TEXT NOT NULL CHECK (
        transition IN ('collecting_to_revealing', 'revealing_to_archived', 'next_cycle_created')
      ),
      occurred_at TEXT NOT NULL,
      UNIQUE (cycle_id, transition)
    )`,
  );
  const columns = tableColumns(database, legacyTable);
  if (
    ['id', 'cycle_id', 'group_id', 'transition', 'occurred_at'].every((column) =>
      columns.has(column),
    )
  ) {
    database.exec(
      `INSERT OR IGNORE INTO cycle_lifecycle_events
         (id, cycle_id, group_id, transition, occurred_at)
       SELECT legacy.id, legacy.cycle_id, legacy.group_id, legacy.transition, legacy.occurred_at
       FROM ${legacyTable} legacy
       WHERE legacy.transition IN ('collecting_to_revealing', 'revealing_to_archived', 'next_cycle_created')
         AND legacy.occurred_at IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM cycles
           WHERE cycles.id = legacy.cycle_id AND cycles.group_id = legacy.group_id
         )`,
    );
  }
  database.exec(`DROP TABLE ${legacyTable}`);
}

/** Repair the old #54 version-006 shape and any interrupted DDL atomically. */
function applyCycleLifecycleMigration(database: RewindDatabase): void {
  const cycleColumns = tableColumns(database, 'cycles');
  if (!cycleColumns.has('release_status')) {
    database.exec(
      "ALTER TABLE cycles ADD COLUMN release_status TEXT NOT NULL DEFAULT 'unpublished' CHECK (release_status IN ('unpublished', 'published'))",
    );
  }
  if (!cycleColumns.has('release_published_at')) {
    database.exec('ALTER TABLE cycles ADD COLUMN release_published_at TEXT');
  }
  if (!cycleColumns.has('previous_cycle_id')) {
    database.exec(
      'ALTER TABLE cycles ADD COLUMN previous_cycle_id TEXT REFERENCES cycles(id) ON DELETE SET NULL',
    );
  }
  if (!hasTable(database, 'cycle_lifecycle_events')) {
    database.exec(
      `CREATE TABLE cycle_lifecycle_events (
        id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        transition TEXT NOT NULL CHECK (
          transition IN ('collecting_to_revealing', 'revealing_to_archived', 'next_cycle_created')
        ),
        occurred_at TEXT NOT NULL,
        UNIQUE (cycle_id, transition)
      )`,
    );
  } else if (!lifecycleTableIsValid(database)) {
    rebuildLifecycleTable(database);
  }
  for (const [name, isUnique, columns, where, table] of [
    [
      'cycles_previous_cycle_idx',
      true,
      ['previous_cycle_id'],
      ' WHERE previous_cycle_id IS NOT NULL',
      'cycles',
    ],
    [
      'cycle_lifecycle_events_group_idx',
      false,
      ['group_id', 'occurred_at', 'id'],
      '',
      'cycle_lifecycle_events',
    ],
    [
      'cycle_lifecycle_events_receipt_idx',
      true,
      ['cycle_id', 'transition'],
      '',
      'cycle_lifecycle_events',
    ],
  ] as const) {
    if (!indexMatches(database, name, isUnique, [...columns])) {
      database.exec(`DROP INDEX IF EXISTS ${name}`);
      database.exec(
        `CREATE ${isUnique ? 'UNIQUE ' : ''}INDEX ${name} ON ${table} (${columns.join(', ')})${where}`,
      );
    }
  }
  // The cycle lifecycle and its cycle-scoped compilation receipt are applied
  // under the same durable migration lock. Keeping this repairable here also
  // preserves the historical version-9 migration identity used by installs
  // that briefly carried #54 at version 006.
  applyCompilationJobsMigration(database);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function createCompilationJobInputsTable(database: RewindDatabase): void {
  database.exec(
    `CREATE TABLE compilation_job_inputs (
       job_id TEXT NOT NULL REFERENCES media_jobs(id) ON DELETE CASCADE,
       clip_job_id TEXT NOT NULL REFERENCES media_jobs(id) ON DELETE CASCADE,
       contribution_id TEXT NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
       position INTEGER NOT NULL CHECK (position >= 0),
       PRIMARY KEY (job_id, clip_job_id),
       UNIQUE (job_id, contribution_id)
     )`,
  );
}

/** Rebuild a malformed recorded table and retain rows that satisfy the
 * canonical constraints. OR IGNORE also deterministically deduplicates rows
 * that were admitted by the malformed table (rowid order keeps the first). */
function rebuildCompilationJobInputsTable(database: RewindDatabase): void {
  const legacyTable = 'compilation_job_inputs_recovery';
  database.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(legacyTable)}`);
  if (hasTable(database, 'compilation_job_inputs')) {
    const indexes = database.prepare('PRAGMA index_list(compilation_job_inputs)').all() as {
      name?: string;
    }[];
    for (const index of indexes) {
      const name = String(index.name ?? '');
      // SQLite's implicit PRIMARY KEY/UNIQUE indexes disappear with their
      // table. Explicit names must be removed before the replacement table is
      // created so a malformed index cannot shadow the canonical one.
      if (name && !name.startsWith('sqlite_autoindex_')) {
        database.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(name)}`);
      }
    }
    database.exec(`ALTER TABLE compilation_job_inputs RENAME TO ${quoteIdentifier(legacyTable)}`);
  }
  createCompilationJobInputsTable(database);

  if (
    !hasTable(database, legacyTable) ||
    !['job_id', 'clip_job_id', 'contribution_id', 'position'].every((column) =>
      tableColumns(database, legacyTable).has(column),
    )
  ) {
    if (hasTable(database, legacyTable))
      database.exec(`DROP TABLE ${quoteIdentifier(legacyTable)}`);
    return;
  }
  // Filter parent references before insertion: SQLite foreign-key violations
  // are not suppressible by INSERT OR IGNORE. Numeric strings are accepted as
  // positions when they are losslessly non-negative integers.
  database.exec(
    `INSERT OR IGNORE INTO compilation_job_inputs
       (job_id, clip_job_id, contribution_id, position)
     SELECT legacy.job_id, legacy.clip_job_id, legacy.contribution_id,
            CAST(legacy.position AS INTEGER)
     FROM ${quoteIdentifier(legacyTable)} AS legacy
     WHERE typeof(legacy.job_id) = 'text'
       AND typeof(legacy.clip_job_id) = 'text'
       AND typeof(legacy.contribution_id) = 'text'
       AND CAST(legacy.position AS TEXT) <> ''
       AND CAST(legacy.position AS TEXT) NOT GLOB '*[^0-9]*'
       AND CAST(legacy.position AS INTEGER) >= 0
       AND EXISTS (SELECT 1 FROM media_jobs WHERE id = legacy.job_id)
       AND EXISTS (SELECT 1 FROM media_jobs WHERE id = legacy.clip_job_id)
       AND EXISTS (SELECT 1 FROM contributions WHERE id = legacy.contribution_id)
     ORDER BY legacy.rowid`,
  );
  database.exec(`DROP TABLE ${quoteIdentifier(legacyTable)}`);
}

/** Apply the cycle-scoped compilation schema in a repairable form. The
 * migration can be resumed after an interrupted DDL sequence. */
function applyCompilationJobsMigration(database: RewindDatabase): void {
  const columns = tableColumns(database, 'media_jobs');
  if (!columns.has('cycle_id')) {
    database.exec(
      'ALTER TABLE media_jobs ADD COLUMN cycle_id TEXT REFERENCES cycles(id) ON DELETE CASCADE',
    );
  }
  if (!columns.has('progress')) {
    database.exec(
      'ALTER TABLE media_jobs ADD COLUMN progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100)',
    );
  }
  if (!columns.has('input_count')) {
    database.exec(
      'ALTER TABLE media_jobs ADD COLUMN input_count INTEGER NOT NULL DEFAULT 0 CHECK (input_count >= 0)',
    );
  }
  if (!columns.has('completed_count')) {
    database.exec(
      'ALTER TABLE media_jobs ADD COLUMN completed_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0)',
    );
  }
  if (!columns.has('claim_generation')) {
    database.exec(
      'ALTER TABLE media_jobs ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0)',
    );
  }
  if (!compilationJobInputsTableIsValid(database)) {
    rebuildCompilationJobInputsTable(database);
  }
  const indexes = [
    [
      'media_jobs_cycle_idx',
      false,
      ['cycle_id', 'kind', 'created_at'],
      'none' as const,
      'media_jobs',
    ],
    ['media_jobs_one_film_per_cycle_idx', true, ['cycle_id'], 'film-cycle' as const, 'media_jobs'],
    [
      'compilation_job_inputs_order_idx',
      false,
      ['job_id', 'position'],
      'none' as const,
      'compilation_job_inputs',
    ],
  ] as const;
  for (const [name, unique, indexColumns, where, table] of indexes) {
    if (!indexMatches(database, name, unique, [...indexColumns], where, table)) {
      database.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(name)}`);
      database.exec(
        `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${quoteIdentifier(name)}
           ON ${quoteIdentifier(table)} (${indexColumns.join(', ')})${
             where === 'film-cycle' ? " WHERE kind = 'film' AND cycle_id IS NOT NULL" : ''
           }`,
      );
    }
  }
}

/** Repairable receipt for the bounded, explicit film retry policy. */
function applyCompilationRetryMigration(database: RewindDatabase): void {
  if (!tableColumns(database, 'media_jobs').has('attempt_count')) {
    database.exec(
      'ALTER TABLE media_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)',
    );
  }
}

function markMigration(database: RewindDatabase, key: string): void {
  database
    .prepare(
      'INSERT OR IGNORE INTO schema_migration_markers (migration_key, applied_at) VALUES (?, ?)',
    )
    .run(key, new Date().toISOString());
}

function hasColumns(database: RewindDatabase, table: string, columns: string[]): boolean {
  return (
    hasTable(database, table) &&
    columns.every((column) => tableColumns(database, table).has(column))
  );
}

function hasIndex(database: RewindDatabase, name: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name),
  );
}

function hasTable(database: RewindDatabase, name: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function tableColumns(database: RewindDatabase, table: string): Set<string> {
  return new Set(
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String((row as { name?: unknown }).name)),
  );
}

/** Promote early #45's random-token table into the canonical #44 capability table. */
function migrateLegacyStagedSources(database: RewindDatabase): void {
  if (!hasTable(database, 'staged_sources')) return;
  if (!tableColumns(database, 'staged_sources').has('source_path')) {
    database.exec('ALTER TABLE staged_sources ADD COLUMN source_path TEXT');
  }
  if (!hasTable(database, 'staged_media_sources')) return;
  const rows = database
    .prepare(
      `SELECT source_uri AS sourceUri, group_id AS groupId, member_id AS memberId,
              source_path AS sourcePath, created_at AS createdAt
       FROM staged_media_sources`,
    )
    .all() as {
    sourceUri: string;
    groupId: string;
    memberId: string;
    sourcePath: string;
    createdAt: string;
  }[];
  const mediaJobsHaveSourcePath =
    hasTable(database, 'media_jobs') && tableColumns(database, 'media_jobs').has('source_path');
  const insert = database.prepare(
    `INSERT OR IGNORE INTO staged_sources
      (source_id, source_uri, idempotency_key_hash, group_id, member_id, source_path,
       byte_length, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?,
       (SELECT byte_length FROM media_metadata WHERE source_uri = ?),
       CASE WHEN EXISTS (SELECT 1 FROM media_metadata WHERE source_uri = ?) THEN 'staged' ELSE 'pending' END,
       ?)`,
  );
  for (const row of rows) {
    const sourceId = createHash('sha256').update(row.sourceUri).digest('hex').slice(0, 24);
    const linkedJob = mediaJobsHaveSourcePath
      ? (database
          .prepare(
            'SELECT idempotency_key AS idempotencyKey FROM media_jobs WHERE source_path = ? LIMIT 1',
          )
          .get(row.sourcePath) as { idempotencyKey?: string } | undefined)
      : undefined;
    // `media_jobs.idempotency_key` was already persisted as the 32-character
    // SHA-256 key hash by the legacy #45 implementation. Preserve it exactly;
    // hashing it again would make a retry with the original client key fail
    // the staged capability binding after migration.
    const idempotencyKeyHash = linkedJob?.idempotencyKey
      ? linkedJob.idempotencyKey
      : createHash('sha256').update(row.sourceUri).digest('hex').slice(0, 32);
    insert.run(
      sourceId,
      row.sourceUri,
      idempotencyKeyHash,
      row.groupId,
      row.memberId,
      row.sourcePath,
      row.sourceUri,
      row.sourceUri,
      row.createdAt,
    );
  }
  database.exec('DROP TABLE staged_media_sources');
}

export function seedDatabase(database: RewindDatabase): void {
  const existing = database.prepare('SELECT COUNT(*) AS count FROM profiles').get() as {
    count: number;
  };
  if (Number(existing.count) > 0) return;

  const now = FIXTURE.acceptedAt;
  database.exec('BEGIN');
  try {
    const profileInsert = database.prepare(
      'INSERT INTO profiles (id, display_name, avatar_label, is_synthetic) VALUES (?, ?, ?, 1)',
    );
    for (const profile of FIXTURE.profiles) {
      profileInsert.run(profile.id, profile.displayName, profile.avatarLabel);
    }

    database
      .prepare('INSERT INTO groups (id, name, current_cycle_id) VALUES (?, ?, ?)')
      .run(FIXTURE.group.id, FIXTURE.group.name, FIXTURE.group.currentCycleId);
    database
      .prepare(
        `INSERT INTO cycles
          (id, group_id, prompt, starts_at, ends_at, status, lock_state, max_count, max_seconds, count_used, seconds_used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        FIXTURE.cycle.id,
        FIXTURE.group.id,
        FIXTURE.cycle.prompt,
        FIXTURE.cycle.startsAt,
        FIXTURE.cycle.endsAt,
        FIXTURE.cycle.status,
        FIXTURE.cycle.lockState,
        FIXTURE.cycle.maxCount,
        FIXTURE.cycle.maxSeconds,
        FIXTURE.cycle.countUsed,
        FIXTURE.cycle.secondsUsed,
      );

    const membershipInsert = database.prepare(
      'INSERT INTO memberships (group_id, member_id, role, accepted_at) VALUES (?, ?, ?, ?)',
    );
    for (const [index, profile] of FIXTURE.profiles.entries()) {
      membershipInsert.run(FIXTURE.group.id, profile.id, index === 0 ? 'owner' : 'member', now);
    }

    database
      .prepare(
        `INSERT INTO sessions
          (id, member_id, group_id, started_at, last_seen_at, access_kind, expires_at)
         VALUES (?, ?, ?, ?, ?, 'demo', ?)`,
      )
      .run(
        'demo-session',
        FIXTURE.profiles[0].id,
        FIXTURE.group.id,
        now,
        now,
        new Date(Date.parse(now) + DEMO_SESSION_LIFETIME_MS).toISOString(),
      );
    database
      .prepare(
        'INSERT INTO invites (id, group_id, invitee_member_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('demo-invite', FIXTURE.group.id, FIXTURE.profiles[0].id, 'accepted', now);
    database
      .prepare(
        'INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        FIXTURE.contribution.id,
        FIXTURE.cycle.id,
        FIXTURE.profiles[0].id,
        FIXTURE.contribution.durationSeconds,
        now,
      );
    const mediaInsert = database.prepare(
      'INSERT INTO media_jobs (id, group_id, contribution_id, kind, status, output_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const job of FIXTURE.mediaJobs) {
      mediaInsert.run(
        job.id,
        FIXTURE.group.id,
        job.kind === 'clip' ? FIXTURE.contribution.id : null,
        job.kind,
        'ready',
        null,
        now,
      );
    }
    database
      .prepare(
        'INSERT INTO messages (id, group_id, member_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(FIXTURE.message.id, FIXTURE.group.id, FIXTURE.profiles[0].id, FIXTURE.message.body, now);
    if (hasTable(database, 'realtime_events')) {
      database
        .prepare(
          `INSERT INTO realtime_events (group_id, message_id, event_type, occurred_at)
           VALUES (?, ?, 'message', ?)`,
        )
        .run(FIXTURE.group.id, FIXTURE.message.id, now);
    }
    database
      .prepare(
        'INSERT INTO reactions (id, message_id, member_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('demo-reaction', FIXTURE.message.id, FIXTURE.profiles[1].id, '✨', now);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function resetDatabase(config: RuntimeConfig): void {
  // The path is resolved from the validated data directory. Reset removes
  // Demo database and media data only; source code and migrations are never
  // in this directory.
  const mediaDir = resolve(config.dataDir, 'media');
  clearMediaDirectory(mediaDir);
  for (const path of [
    config.databasePath,
    `${config.databasePath}-wal`,
    `${config.databasePath}-shm`,
  ]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

/** Clear Demo artifacts without removing the media directory itself, which is
 * a bind-mount target in the hosted container. */
export function clearMediaDirectory(mediaDir: string): void {
  if (!existsSync(mediaDir)) return;
  for (const entry of readdirSync(mediaDir)) {
    rmSync(resolve(mediaDir, entry), { recursive: true, force: true });
  }
}

/** Restore only the SQLite-backed local fixture. Source files and migrations
 * are never touched. This form is used by the in-process reset endpoint. */
export function restoreFixture(database: RewindDatabase): void {
  database.exec('BEGIN');
  try {
    for (const table of [
      'reactions',
      'realtime_events',
      'messages',
      'media_metadata',
      'staged_sources',
      'contribution_quota_windows',
      'media_jobs',
      'contributions',
      'sessions',
      'audit_events',
      'invites',
      'cycles',
      'memberships',
      'groups',
      'profiles',
    ]) {
      database.exec(`DELETE FROM ${table}`);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  seedDatabase(database);
}

export function fixtureSummary(database: RewindDatabase): Record<string, number> {
  const tables = [
    'profiles',
    'groups',
    'memberships',
    'invites',
    'cycles',
    'sessions',
    'contributions',
    'media_jobs',
    'messages',
    'reactions',
  ];
  return Object.fromEntries(
    tables.map((table) => {
      const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      };
      return [table, Number(row.count)];
    }),
  );
}

export function listProfiles(database: RewindDatabase) {
  return database
    .prepare(
      'SELECT id, display_name AS displayName, avatar_label AS avatarLabel, is_synthetic AS isSynthetic FROM profiles ORDER BY id',
    )
    .all()
    .map((row) => {
      const profile = row as Record<string, unknown>;
      return {
        id: String(profile.id),
        displayName: String(profile.displayName),
        avatarLabel: String(profile.avatarLabel),
        isSynthetic: Number(profile.isSynthetic) === 1,
      };
    });
}

export function getGroup(database: RewindDatabase, groupId: string, actingMemberId?: string) {
  const group = database
    .prepare('SELECT id, name, current_cycle_id AS currentCycleId FROM groups WHERE id = ?')
    .get(groupId) as Record<string, unknown> | undefined;
  if (!group) return null;
  const members = database
    .prepare('SELECT member_id AS memberId FROM memberships WHERE group_id = ? ORDER BY member_id')
    .all(groupId)
    .map((row) => String((row as { memberId: string }).memberId));
  const actingMemberRole = actingMemberId
    ? (
        database
          .prepare('SELECT role FROM memberships WHERE group_id = ? AND member_id = ?')
          .get(groupId, actingMemberId) as { role?: string } | undefined
      )?.role
    : undefined;
  return {
    id: String(group.id),
    name: String(group.name),
    currentCycleId: String(group.currentCycleId),
    memberIds: members,
    ...(actingMemberRole === 'owner' || actingMemberRole === 'member' ? { actingMemberRole } : {}),
  };
}

export function getCurrentCycle(
  database: RewindDatabase,
  groupId: string,
  memberId?: string,
  now: Date | string = new Date(),
) {
  const cycle = database
    .prepare(
      `SELECT id, group_id AS groupId, prompt, starts_at AS startsAt, ends_at AS endsAt,
        status, lock_state AS lockState, max_count AS maxCount, max_seconds AS maxSeconds,
        count_used AS countUsed, seconds_used AS secondsUsed,
        release_status AS releaseStatus, release_published_at AS releasePublishedAt,
        previous_cycle_id AS previousCycleId
       FROM cycles
       WHERE group_id = ? AND (
             id = (SELECT current_cycle_id FROM groups WHERE id = ?)
          OR NOT EXISTS (
            SELECT 1 FROM cycles selected
            WHERE selected.id = (SELECT current_cycle_id FROM groups WHERE id = ?)
              AND selected.group_id = ?
          ))
       ORDER BY CASE WHEN id = (SELECT current_cycle_id FROM groups WHERE id = ?) THEN 0 ELSE 1 END,
                starts_at DESC
       LIMIT 1`,
    )
    .get(groupId, groupId, groupId, groupId, groupId) as Record<string, unknown> | undefined;
  if (!cycle) return null;
  const contributionUsage = memberId
    ? (database
        .prepare(
          `SELECT COALESCE(SUM(count_used), 0) AS countUsed,
                  COALESCE(SUM(seconds_used), 0) AS secondsUsed
           FROM contribution_quota_windows
           WHERE cycle_id = ? AND member_id = ?
             AND window_start_at <= ? AND window_end_at > ?`,
        )
        .get(
          String(cycle.id),
          memberId,
          now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
          now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
        ) as { countUsed?: number; secondsUsed?: number })
    : undefined;
  return {
    id: String(cycle.id),
    groupId: String(cycle.groupId),
    prompt: String(cycle.prompt),
    startsAt: String(cycle.startsAt),
    endsAt: String(cycle.endsAt),
    status: String(cycle.status),
    lockState: String(cycle.lockState),
    quota: {
      maxCount: Math.max(1, Math.min(5, Number(cycle.maxCount))),
      maxSeconds: Math.max(1, Math.min(30, Number(cycle.maxSeconds))),
    },
    contributionUsage: contributionUsage
      ? {
          countUsed: Number(contributionUsage.countUsed ?? 0),
          secondsUsed: Number(contributionUsage.secondsUsed ?? 0),
        }
      : {
          countUsed: Number(cycle.countUsed),
          secondsUsed: Number(cycle.secondsUsed),
        },
    releaseStatus: String(cycle.releaseStatus ?? 'unpublished'),
    releasePublishedAt: cycle.releasePublishedAt ? String(cycle.releasePublishedAt) : null,
    previousCycleId: cycle.previousCycleId ? String(cycle.previousCycleId) : null,
  };
}

export function isMember(database: RewindDatabase, groupId: string, memberId: string): boolean {
  const row = database
    .prepare('SELECT 1 AS member FROM memberships WHERE group_id = ? AND member_id = ?')
    .get(groupId, memberId) as { member?: number } | undefined;
  return row?.member === 1;
}

export function isOwner(database: RewindDatabase, groupId: string, memberId: string): boolean {
  const row = database
    .prepare(
      `SELECT 1 AS owner FROM memberships
       WHERE group_id = ? AND member_id = ? AND role = 'owner' LIMIT 1`,
    )
    .get(groupId, memberId) as { owner?: number } | undefined;
  return row?.owner === 1;
}

export function getMessage(database: RewindDatabase, groupId: string, messageId: string) {
  const row = database
    .prepare(
      `SELECT m.id, m.group_id AS groupId, m.member_id AS memberId,
        m.body, m.created_at AS createdAt,
        parent.id AS replyToId, parent.member_id AS replyToMemberId,
        parent.body AS replyToBody, parent.created_at AS replyToCreatedAt
       FROM messages m
       LEFT JOIN messages parent ON parent.id = m.reply_to_message_id
       WHERE m.id = ? AND m.group_id = ?`,
    )
    .get(messageId, groupId);
  if (!row) return null;
  const message = row as Record<string, unknown>;
  const counts = database
    .prepare('SELECT emoji, COUNT(*) AS count FROM reactions WHERE message_id = ? GROUP BY emoji')
    .all(messageId) as { emoji?: unknown; count?: unknown }[];
  const reactionCounts = Object.fromEntries(
    counts.map((count) => [String(count.emoji), Number(count.count)]),
  );
  return {
    id: String(message.id),
    groupId: String(message.groupId),
    memberId: String(message.memberId),
    body: String(message.body),
    createdAt: String(message.createdAt),
    replyTo: message.replyToId
      ? {
          id: String(message.replyToId),
          memberId: String(message.replyToMemberId),
          body: String(message.replyToBody),
          createdAt: String(message.replyToCreatedAt),
        }
      : null,
    reactionCounts,
  };
}

export function getContribution(database: RewindDatabase, groupId: string, contributionId: string) {
  return database
    .prepare(
      `SELECT c.id, c.cycle_id AS cycleId, c.member_id AS memberId, c.duration_seconds AS durationSeconds,
        c.created_at AS createdAt FROM contributions c JOIN cycles cy ON cy.id = c.cycle_id
       WHERE c.id = ? AND cy.group_id = ?`,
    )
    .get(contributionId, groupId);
}

export function getMediaJob(
  database: RewindDatabase,
  groupId: string,
  jobId: string,
  kind: 'clip' | 'film' | 'download',
) {
  const row = database
    .prepare(
      `SELECT id, group_id AS groupId, kind, status, created_at AS createdAt,
              cycle_id AS cycleId, progress, input_count AS inputCount,
              completed_count AS completedCount, processing_started_at AS processingStartedAt
       FROM media_jobs WHERE id = ? AND group_id = ? AND kind = ?`,
    )
    .get(jobId, groupId, kind);
  if (!row || kind === 'film') return row;
  const base = row as {
    id: string;
    groupId: string;
    kind: string;
    status: string;
    createdAt: string;
  };
  return {
    id: base.id,
    groupId: base.groupId,
    kind: base.kind,
    status: base.status,
    createdAt: base.createdAt,
  };
}

export interface PremiereFilmRecord {
  cycleId: string;
  cycleStatus: string;
  releaseStatus: 'unpublished' | 'published';
  filmId: string | null;
  filmStatus: string | null;
  outputPath: string | null;
  attemptCount: number;
}

export interface ReleasedArchiveRecord {
  films: { id: string; cycleId: string; publishedAt: string }[];
  clips: { id: string; contributionId: string; cycleId: string; createdAt: string }[];
}

/** List only ready, released media. Filesystem paths stay server-side. */
export function listReleasedArchive(
  database: RewindDatabase,
  groupId: string,
  memberId: string,
): ReleasedArchiveRecord {
  const films = database
    .prepare(
      `SELECT f.id, c.id AS cycleId, c.release_published_at AS publishedAt
       FROM media_jobs f
       JOIN cycles c ON c.id = f.cycle_id AND c.group_id = f.group_id
       WHERE f.group_id = ? AND f.kind = 'film' AND f.status = 'ready'
         AND f.output_path IS NOT NULL AND c.release_status = 'published'
       ORDER BY c.release_published_at DESC, f.created_at DESC, f.id DESC`,
    )
    .all(groupId) as Record<string, unknown>[];
  const clips = database
    .prepare(
      `SELECT clip.id, contribution.id AS contributionId, cycle.id AS cycleId,
              contribution.created_at AS createdAt
       FROM media_jobs clip
       JOIN contributions contribution ON contribution.id = clip.contribution_id
       JOIN cycles cycle ON cycle.id = contribution.cycle_id
       WHERE clip.group_id = ? AND clip.kind = 'clip' AND clip.status = 'ready'
         AND clip.output_path IS NOT NULL AND contribution.member_id = ?
         AND cycle.group_id = ? AND cycle.release_status = 'published'
         AND clip.deleted_at IS NULL
       ORDER BY contribution.created_at DESC, clip.id DESC`,
    )
    .all(groupId, memberId, groupId) as Record<string, unknown>[];
  return {
    films: films.map((film) => ({
      id: String(film.id),
      cycleId: String(film.cycleId),
      publishedAt: String(film.publishedAt),
    })),
    clips: clips.map((clip) => ({
      id: String(clip.id),
      contributionId: String(clip.contributionId),
      cycleId: String(clip.cycleId),
      createdAt: String(clip.createdAt),
    })),
  };
}

export function getReleasedFilmDownload(
  database: RewindDatabase,
  groupId: string,
  filmId: string,
): { outputPath: string } | null {
  const row = database
    .prepare(
      `SELECT f.output_path AS outputPath
       FROM media_jobs f
       JOIN cycles c ON c.id = f.cycle_id AND c.group_id = f.group_id
       WHERE f.id = ? AND f.group_id = ? AND f.kind = 'film' AND f.status = 'ready'
         AND f.output_path IS NOT NULL AND c.release_status = 'published'
       LIMIT 1`,
    )
    .get(filmId, groupId) as Record<string, unknown> | undefined;
  return row?.outputPath ? { outputPath: String(row.outputPath) } : null;
}

export function getReleasedOwnClipDownload(
  database: RewindDatabase,
  groupId: string,
  memberId: string,
  clipId: string,
): { outputPath: string } | null {
  const row = database
    .prepare(
      `SELECT clip.output_path AS outputPath
       FROM media_jobs clip
       JOIN contributions contribution ON contribution.id = clip.contribution_id
       JOIN cycles cycle ON cycle.id = contribution.cycle_id
       WHERE clip.id = ? AND clip.group_id = ? AND clip.kind = 'clip' AND clip.status = 'ready'
         AND clip.output_path IS NOT NULL AND contribution.member_id = ?
         AND cycle.group_id = ? AND cycle.release_status = 'published'
         AND clip.deleted_at IS NULL
       LIMIT 1`,
    )
    .get(clipId, groupId, memberId, groupId) as Record<string, unknown> | undefined;
  return row?.outputPath ? { outputPath: String(row.outputPath) } : null;
}

/** The HTTP layer decides which safe premiere state to expose. This query
 * deliberately retains the output path only for its server-side stream gate. */
export function getPremiereFilm(
  database: RewindDatabase,
  groupId: string,
  cycleId: string,
): PremiereFilmRecord | null {
  const row = database
    .prepare(
      `SELECT c.id AS cycleId, c.status AS cycleStatus, c.release_status AS releaseStatus,
              f.id AS filmId, f.status AS filmStatus, f.output_path AS outputPath,
              f.attempt_count AS attemptCount
       FROM cycles c
       LEFT JOIN media_jobs f
         ON f.cycle_id = c.id AND f.group_id = c.group_id AND f.kind = 'film'
       WHERE c.id = ? AND c.group_id = ?
       ORDER BY f.created_at DESC, f.id DESC LIMIT 1`,
    )
    .get(cycleId, groupId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    cycleId: String(row.cycleId),
    cycleStatus: String(row.cycleStatus),
    releaseStatus: row.releaseStatus === 'published' ? 'published' : 'unpublished',
    filmId: row.filmId ? String(row.filmId) : null,
    filmStatus: row.filmStatus ? String(row.filmStatus) : null,
    outputPath: row.outputPath ? String(row.outputPath) : null,
    attemptCount: Math.max(0, Number(row.attemptCount ?? 0)),
  };
}

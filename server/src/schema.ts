// SQLite schema: one squashed baseline plus the migration receipts it stands
// for. db.ts opens and migrates databases with it.
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { RewindDatabase } from './db';
import {
  filePathMatchesIdentity,
  hashFileWithIdentity,
  type HashedFileIntegrity,
} from './media/integrity';
import { isPostgres, migratePostgres, postgresMissingMigrationKeys } from './postgres/runtime';

/**
 * The durable schema receipts. SQLite migrations 1-31 were squashed into
 * server/migrations/sqlite-baseline.sql on 21 Oct 2026 (tag
 * pre-migration-squash marks the last release with the step-by-step chain).
 * Each database still records every version and key below, so databases
 * built before and after the squash, and PostgreSQL (baseline 30 plus later
 * files), carry identical receipts. A new schema change appends an entry here
 * and applies its own step after the baseline.
 */
export const MIGRATIONS: { version: number; key: string }[] = [
  { version: 1, key: 'initial-v1' },
  { version: 2, key: 'session-audit-v1' },
  { version: 3, key: 'cycle-controls-v1' },
  { version: 4, key: 'invites-v1' },
  { version: 5, key: 'media-idempotency-v1' },
  { version: 6, key: 'contribution-quota-v1' },
  { version: 7, key: 'media-processing-v1' },
  { version: 8, key: 'media-source-binding-v1' },
  { version: 9, key: 'cycle-lifecycle-v1' },
  { version: 10, key: 'contribution-deletion-v1' },
  { version: 11, key: 'realtime-messages-v1' },
  { version: 12, key: 'chat-replies-reactions-v1' },
  { version: 13, key: 'compilation-retry-v1' },
  { version: 14, key: 'queue-observability-v1' },
  { version: 15, key: 'media-integrity-v1' },
  { version: 16, key: 'contribution-ledger-v1' },
  { version: 17, key: 'consistency-repair-audit-v1' },
  { version: 18, key: 'real-account-auth-v1' },
  { version: 19, key: 'real-groups-v1' },
  { version: 20, key: 'real-group-invites-v1' },
  { version: 21, key: 'real-group-invite-acceptance-v1' },
  { version: 22, key: 'real-media-profile-bridge-v1' },
  { version: 23, key: 'photo-media-v1' },
  { version: 24, key: 'real-invite-guess-throttles-v1' },
  { version: 25, key: 'real-group-reminders-v1' },
  { version: 26, key: 'upload-intents-v1' },
  { version: 27, key: 'reminder-outbox-v1' },
  { version: 28, key: 'content-safety-v1' },
  { version: 29, key: 'member-reports-v1' },
  { version: 30, key: 'moderation-records-v1' },
  { version: 31, key: 'cognito-accounts-v1' },
];

const LATEST_VERSION = Math.max(...MIGRATIONS.map((migration) => migration.version));
const RECEIPT_TABLES = ['schema_migrations', 'schema_migration_markers'];

let baseline: { sql: string; objects: string[] } | undefined;
function sqliteBaseline(): { sql: string; objects: string[] } {
  if (!baseline) {
    const sql = readFileSync(
      resolve(process.cwd(), 'server/migrations/sqlite-baseline.sql'),
      'utf8',
    );
    const objects = [
      ...sql.matchAll(/^CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER|VIEW) "?(\w+)"?/gm),
    ].map((match) => match[1]);
    baseline = { sql, objects };
  }
  return baseline;
}

export interface SchemaReadiness {
  ready: boolean;
  expectedMigrationVersion: number;
  missingMigrationKeys: string[];
}

/**
 * The migration receipts are the hosted runtime's schema contract. Startup
 * applies this contract before accepting traffic; health checks repeat it so
 * an interrupted or manually damaged migration is never reported as ready.
 */
export function schemaReadiness(database: RewindDatabase): SchemaReadiness {
  const missingMigrationKeys = isPostgres(database)
    ? postgresMissingMigrationKeys(database, MIGRATIONS)
    : sqliteMissing(database);
  return {
    ready: missingMigrationKeys.length === 0,
    expectedMigrationVersion: LATEST_VERSION,
    missingMigrationKeys,
  };
}

/** Missing migration keys, then any baseline table, index or trigger that
 * was dropped after the receipts were written. */
function sqliteMissing(database: RewindDatabase): string[] {
  const names = (sql: string) =>
    new Set((database.prepare(sql).all() as { value: unknown }[]).map((row) => String(row.value)));
  const present = names("SELECT name AS value FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'");
  if (!RECEIPT_TABLES.every((table) => present.has(table))) {
    return MIGRATIONS.map((migration) => migration.key);
  }
  const versions = names('SELECT version AS value FROM schema_migrations');
  const markers = names('SELECT migration_key AS value FROM schema_migration_markers');
  return [
    ...MIGRATIONS.filter(
      (migration) => !versions.has(String(migration.version)) || !markers.has(migration.key),
    ).map((migration) => migration.key),
    ...sqliteBaseline()
      .objects.filter((name) => !present.has(name))
      .map((name) => `baseline:${name}`),
  ];
}

/**
 * Bring a database to the current schema. A fresh SQLite database runs the
 * baseline once; one already at the latest version is left untouched; any
 * other state (an older, partly migrated or damaged database) is refused,
 * because the step-by-step upgrade and repair chain was retired with the squash.
 */
export function migrateDatabase(database: RewindDatabase): void {
  if (isPostgres(database)) {
    migratePostgres(database, MIGRATIONS);
    return;
  }
  database.exec('PRAGMA busy_timeout = 5000;');
  database.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);',
  );
  database.exec(
    'CREATE TABLE IF NOT EXISTS schema_migration_markers (migration_key TEXT PRIMARY KEY, applied_at TEXT NOT NULL);',
  );
  if (sqliteMissing(database).length === 0) return;
  beginMigrationTransaction(database);
  try {
    // Re-check under the writer lock: a concurrent starter may have finished.
    const missing = sqliteMissing(database);
    if (missing.length > 0) {
      assertFreshSqliteDatabase(database, missing);
      database.exec(sqliteBaseline().sql);
      const appliedAt = new Date().toISOString();
      for (const { version, key } of MIGRATIONS) {
        database
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(version, appliedAt);
        database
          .prepare('INSERT INTO schema_migration_markers (migration_key, applied_at) VALUES (?, ?)')
          .run(key, appliedAt);
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function assertFreshSqliteDatabase(database: RewindDatabase, missing: string[]): void {
  const { version } = database
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number };
  const { tables } = database
    .prepare(
      `SELECT COUNT(*) AS tables FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations', 'schema_migration_markers')`,
    )
    .get() as { tables: number };
  if (Number(version) === 0 && Number(tables) === 0) return;
  throw new Error(
    `This SQLite database is at schema version ${version} and lacks ${missing.join(', ')}. ` +
      `This release only opens fresh databases or complete version-${LATEST_VERSION} databases. ` +
      'Upgrade it first by starting a release from before the migration squash ' +
      '(git tag pre-migration-squash) against it, or restore it from a backup.',
  );
}

export interface MediaIntegrityBackfillOptions {
  /** Injectable to prove lock behavior and interrupted-upgrade recovery. */
  hashOutput?: (path: string) => Promise<HashedFileIntegrity | null>;
}

/** Backfill legacy receipts with hashing outside SQLite writer transactions.
 * Each small receipt update is independently committed, so a restart resumes
 * at the first remaining row and competing writers are not held behind media
 * sized work. Unreadable or out-of-tree outputs remain unverifiable. */
export async function backfillMediaIntegrity(
  database: RewindDatabase,
  mediaRoot: string,
  options: MediaIntegrityBackfillOptions = {},
): Promise<void> {
  const hashOutput = options.hashOutput ?? hashFileWithIdentity;
  let afterId = '';
  for (;;) {
    const row = database
      .prepare(
        `SELECT id, output_path AS outputPath FROM media_jobs
         WHERE id > ? AND kind IN ('clip', 'film') AND status = 'ready'
           AND output_path IS NOT NULL AND output_sha256 IS NULL
         ORDER BY id ASC LIMIT 1`,
      )
      .get(afterId) as { id: string; outputPath: string } | undefined;
    if (!row) return;
    afterId = row.id;
    if (!isServerOwnedMediaPath(row.outputPath, mediaRoot)) continue;

    // This potentially large read deliberately occurs before BEGIN IMMEDIATE.
    const integrity = await hashOutput(row.outputPath);
    if (!integrity) continue;

    beginMigrationTransaction(database);
    try {
      const current = database
        .prepare(
          `SELECT output_path AS outputPath FROM media_jobs
           WHERE id = ? AND kind IN ('clip', 'film') AND status = 'ready'
             AND output_sha256 IS NULL`,
        )
        .get(row.id) as { outputPath: string } | undefined;
      if (
        current?.outputPath === row.outputPath &&
        filePathMatchesIdentity(row.outputPath, integrity.identity)
      ) {
        database
          .prepare(
            `UPDATE media_jobs
             SET output_sha256 = ?, output_bytes = ?, output_verified_at = ?
             WHERE id = ? AND output_path = ? AND status = 'ready'
               AND kind IN ('clip', 'film') AND output_sha256 IS NULL`,
          )
          .run(
            integrity.sha256,
            integrity.byteLength,
            new Date().toISOString(),
            row.id,
            row.outputPath,
          );
      }
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

/** The migration may only hash files inside the server-owned processed media
 * tree. The path policy is intentionally textual here because the backfill
 * runs before the HTTP layer's realpath boundary exists. */
function isServerOwnedMediaPath(path: string, mediaRoot: string): boolean {
  const processedRoot = resolve(mediaRoot, 'media', 'processed');
  const remainder = relative(processedRoot, resolve(path));
  return Boolean(remainder) && !remainder.startsWith('..') && !isAbsolute(remainder);
}

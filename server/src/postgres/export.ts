// Reverse of transfer.ts: copy a consistent PostgreSQL snapshot into a fresh
// SQLite file, reconcile every table by row count and canonical content hash,
// and only then expose the file at its destination. A failure at any point
// leaves no destination file; the live database and PostgreSQL are never
// modified. install.ts swaps a validated export into place.
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { PostgresDatabase } from './database';
import {
  TransferError,
  checkValue,
  digestTable,
  primaryKey,
  quote,
  type Row,
  type TargetColumn,
} from './transfer';

/** PostgreSQL-only table; it is validated, not copied. */
const ENVIRONMENT_TABLE = 'rewind_database_environment';
const BATCH_ROWS = 200;

/** Sessions the runtime opens (HTTP server, scheduler, reminders, worker). */
export const WRITER_APPLICATION_NAMES = ['rewind-runtime'];

/** Written next to an export; the install step trusts nothing without it. */
export const EXPORT_REPORT_SUFFIX = '.export.json';

export class ExportError extends TransferError {}

export interface ExportedTable {
  table: string;
  rows: number;
  sha256: string;
  /** Columns that order the rows for hashing (the primary key). */
  key: string[];
}

export interface ExportReport {
  format: 1;
  createdAt: string;
  /** The environment the PostgreSQL database is bound to. */
  environment: string;
  boundAt: string;
  migrationVersion: number;
  tables: ExportedTable[];
  totalRows: number;
  /** SHA-256 of the SQLite file as installed. */
  sqliteSha256: string;
  /** False when --allow-live-writers skipped the runtime-session check. */
  writersQuiesced: boolean;
  /** Final value of each AUTOINCREMENT counter. */
  sequences: Record<string, number>;
}

export interface ExportOptions {
  destination: string;
  expectedEnvironment: string;
  migrations: { version: number; key: string }[];
  /** Create a fresh SQLite file at the current schema (migrated, no data). */
  createSchema: (path: string) => void;
  /** Schema readiness of an open SQLite file. */
  checkReady: (database: DatabaseSync) => { ready: boolean; missingMigrationKeys: string[] };
  /** Refuse when another session with one of these names is connected. */
  writerApplicationNames?: string[];
  allowLiveWriters?: boolean;
  /** Test hooks: after the copy (before verification) and after verification. */
  afterLoad?: (stagingPath: string) => void;
  beforeExpose?: (stagingPath: string) => void;
  now?: () => Date;
}

interface TableSnapshot {
  columns: TargetColumn[];
  key: string[];
  rows: Row[];
  sha256: string;
}

interface Snapshot {
  environment: string;
  boundAt: string;
  tables: Map<string, TableSnapshot>;
  /** Identity column and last issued value, by table. */
  sequences: Map<string, { column: string; last: number }>;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The destination must be a new file in an existing, writable directory. */
function validateDestination(destination: string): void {
  const parent = dirname(destination);
  let parentStat;
  try {
    parentStat = statSync(parent);
  } catch {
    throw new ExportError(`The destination directory ${parent} does not exist.`);
  }
  if (!parentStat.isDirectory()) throw new ExportError(`${parent} is not a directory.`);
  try {
    accessSync(parent, constants.W_OK);
  } catch {
    throw new ExportError(`The destination directory ${parent} is not writable.`);
  }
  for (const path of [
    destination,
    `${destination}-wal`,
    `${destination}-shm`,
    `${destination}-journal`,
    `${destination}${EXPORT_REPORT_SUFFIX}`,
  ]) {
    if (exists(path)) {
      throw new ExportError(
        `${path} already exists. database-export never overwrites a file; choose a new path, ` +
          'or remove a leftover only after checking it is not the database you need.',
      );
    }
  }
}

/** Identifies the snapshot transaction; changes if the connection is replaced. */
function anchor(source: PostgresDatabase): string {
  const row = source.queryNative(
    `SELECT pg_backend_pid() AS pid, pg_current_snapshot()::text AS snapshot,
            current_setting('transaction_isolation') AS isolation,
            current_setting('transaction_read_only') AS read_only`,
  )[0];
  if (row.isolation !== 'repeatable read' || row.read_only !== 'on') {
    throw new ExportError('The export did not get a repeatable-read, read-only snapshot.');
  }
  return `${String(row.pid)}:${String(row.snapshot)}`;
}

function assertNoLiveWriters(source: PostgresDatabase, names: string[]): void {
  if (!names.length) return;
  const sessions = source.queryNative(
    `SELECT application_name AS name, count(*) AS sessions FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> pg_backend_pid()
       AND application_name = ANY($1::text[])
     GROUP BY application_name`,
    [names],
  );
  if (sessions.length) {
    const detail = sessions.map((row) => `${String(row.name)} x${Number(row.sessions)}`).join(', ');
    throw new ExportError(
      `Writers are still connected to PostgreSQL (${detail}). Stop the runtime, scheduler, ` +
        'reminder loop and workers first, or pass --allow-live-writers for a rehearsal that ' +
        'must not be installed.',
    );
  }
}

function postgresTables(source: PostgresDatabase): Map<string, TargetColumn[]> {
  const rows = source.queryNative(
    `SELECT c.table_name AS table, c.column_name AS name, c.data_type AS type
     FROM information_schema.columns c
     JOIN information_schema.tables t
       ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name, c.ordinal_position`,
  );
  const tables = new Map<string, TargetColumn[]>();
  for (const row of rows) {
    const table = String(row.table);
    if (table === ENVIRONMENT_TABLE) continue;
    const columns = tables.get(table) ?? [];
    columns.push({ name: String(row.name), type: String(row.type) });
    tables.set(table, columns);
  }
  return tables;
}

function readEnvironment(source: PostgresDatabase, expected: string) {
  const present = source.queryNative(`SELECT to_regclass('${ENVIRONMENT_TABLE}') AS name`)[0];
  if (present.name === null) {
    throw new ExportError('This PostgreSQL database has no Rewind environment binding.');
  }
  const rows = source.queryNative(`SELECT environment, bound_at FROM ${ENVIRONMENT_TABLE}`);
  if (rows.length !== 1) {
    throw new ExportError('The PostgreSQL database is not bound to exactly one environment.');
  }
  const environment = String(rows[0].environment);
  if (environment !== expected) {
    throw new ExportError(
      `This database belongs to the "${environment}" environment, not "${expected}". ` +
        'Check REWIND_DATABASE_URL and REWIND_DATABASE_ENVIRONMENT.',
    );
  }
  return { environment, boundAt: String(rows[0].bound_at) };
}

/** The recorded migrations must be exactly the ones this build ships. */
function validateMigrationMetadata(
  migrations: { version: number; key: string }[],
  rows: { versions: Row[]; markers: Row[] },
): void {
  const versions = new Set(rows.versions.map((row) => Number(row.version)));
  const markers = new Set(rows.markers.map((row) => String(row.migration_key)));
  const missing = migrations
    .filter((migration) => !versions.has(migration.version) || !markers.has(migration.key))
    .map((migration) => migration.key);
  if (missing.length) {
    throw new ExportError(
      `The PostgreSQL schema is behind this release (missing ${missing.join(', ')}). ` +
        'Start this release against PostgreSQL once so it migrates, then export.',
    );
  }
  const knownVersions = new Set(migrations.map((migration) => migration.version));
  const knownKeys = new Set(migrations.map((migration) => migration.key));
  const unknown = [
    ...[...versions].filter((version) => !knownVersions.has(version)).map(String),
    ...[...markers].filter((key) => !knownKeys.has(key)),
  ];
  if (unknown.length) {
    throw new ExportError(
      `The PostgreSQL schema is newer than this release (${unknown.join(', ')}). ` +
        'Export with the release that migrated it; SQLite cannot represent that schema.',
    );
  }
}

function readTables(
  source: PostgresDatabase,
  tables: Map<string, TargetColumn[]>,
  expectedAnchor: string,
): Map<string, TableSnapshot> {
  const snapshot = new Map<string, TableSnapshot>();
  for (const [table, columns] of [...tables.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const names = columns.map((column) => column.name);
    const keyColumns = primaryKey(source, table);
    const key = keyColumns.length ? keyColumns : names;
    const rows = source.queryNative(`SELECT * FROM ${quote(table)}`);
    // A reconnect mid-export would silently read a different snapshot.
    if (anchor(source) !== expectedAnchor) {
      throw new ExportError('The PostgreSQL connection changed during the export; run it again.');
    }
    for (const row of rows)
      for (const column of columns) checkValue(table, column, row[column.name]);
    snapshot.set(table, { columns, key, rows, sha256: digestTable(rows, names, key) });
  }
  return snapshot;
}

/** Read everything in one repeatable-read, read-only transaction. */
function takeSnapshot(
  source: PostgresDatabase,
  expectedEnvironment: string,
  migrations: { version: number; key: string }[],
): Snapshot {
  source.execNative('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const expectedAnchor = anchor(source);
    const { environment, boundAt } = readEnvironment(source, expectedEnvironment);
    const tables = readTables(source, postgresTables(source), expectedAnchor);
    const part = (name: string) => tables.get(name)?.rows;
    const versions = part('schema_migrations');
    const markers = part('schema_migration_markers');
    if (!versions || !markers) {
      throw new ExportError('The PostgreSQL database has no migration metadata.');
    }
    validateMigrationMetadata(migrations, { versions, markers });

    const sequences = new Map<string, { column: string; last: number }>();
    for (const row of source.queryNative(
      `SELECT table_name AS table, column_name AS column FROM information_schema.columns
       WHERE table_schema = current_schema() AND is_identity = 'YES'`,
    )) {
      const last = source.queryNative(
        'SELECT pg_sequence_last_value(pg_get_serial_sequence($1, $2)::regclass) AS last',
        [quote(String(row.table)), String(row.column)],
      )[0]?.last;
      sequences.set(String(row.table), {
        column: String(row.column),
        last: last === null || last === undefined ? 0 : Number(last),
      });
    }
    if (anchor(source) !== expectedAnchor) {
      throw new ExportError('The PostgreSQL connection changed during the export; run it again.');
    }
    source.execNative('COMMIT');
    return { environment, boundAt, tables, sequences };
  } catch (error) {
    try {
      source.execNative('ROLLBACK');
    } catch {
      // The connection is already gone; nothing to roll back.
    }
    throw error;
  }
}

/**
 * Fingerprint PostgreSQL again and compare it with `expected` (rows and
 * content hash per table). Any difference is a write the file would lose.
 * Used right after the copy, and again before the file is installed.
 */
export function assertSourceMatches(
  source: PostgresDatabase,
  expected: { table: string; rows: number; sha256: string }[],
  settings: { expectedEnvironment: string; writerApplicationNames: string[]; when: string },
): void {
  assertNoLiveWriters(source, settings.writerApplicationNames);
  source.execNative('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const expectedAnchor = anchor(source);
    readEnvironment(source, settings.expectedEnvironment);
    const again = readTables(source, postgresTables(source), expectedAnchor);
    const before = new Map(expected.map((entry) => [entry.table, entry]));
    const changed = [...new Set([...before.keys(), ...again.keys()])].filter(
      (table) =>
        before.get(table)?.sha256 !== again.get(table)?.sha256 ||
        before.get(table)?.rows !== again.get(table)?.rows.length,
    );
    if (changed.length) {
      throw new ExportError(
        `PostgreSQL changed ${settings.when} (${changed.join(', ')}). ` +
          'Writes landed after the snapshot, so the file would lose them. Stop every writer and export again.',
      );
    }
  } finally {
    try {
      source.execNative('ROLLBACK');
    } catch {
      // Read-only transaction on a dropped connection: nothing to undo.
    }
  }
}

function sqliteTables(sqlite: DatabaseSync): Map<string, string[]> {
  const names = (
    sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  return new Map(
    names.map((name) => [
      name,
      (sqlite.prepare('SELECT name FROM pragma_table_info(?)').all(name) as { name: string }[]).map(
        (column) => column.name,
      ),
    ]),
  );
}

function assertSameSchema(sqlite: DatabaseSync, snapshot: Snapshot): void {
  const lite = sqliteTables(sqlite);
  const missing = [...snapshot.tables.keys()].filter((name) => !lite.has(name));
  const extra = [...lite.keys()].filter((name) => !snapshot.tables.has(name));
  if (missing.length || extra.length) {
    throw new ExportError(
      `The schemas differ. Only in PostgreSQL: ${missing.join(', ') || 'none'}; ` +
        `only in SQLite: ${extra.join(', ') || 'none'}.`,
    );
  }
  for (const [table, data] of snapshot.tables) {
    const names = data.columns.map((column) => column.name);
    const liteNames = lite.get(table) ?? [];
    if (names.length !== liteNames.length || names.some((name) => !liteNames.includes(name))) {
      throw new ExportError(`The columns of ${table} differ between PostgreSQL and SQLite.`);
    }
  }
}

function loadSqlite(
  path: string,
  snapshot: Snapshot,
): { sequences: Record<string, number>; triggers: string[] } {
  const sqlite = new DatabaseSync(path);
  const sequences: Record<string, number> = {};
  let triggerNames: string[] = [];
  try {
    sqlite.exec('PRAGMA foreign_keys = OFF');
    assertSameSchema(sqlite, snapshot);
    const triggers = sqlite
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
      .all() as { name: string; sql: string }[];
    triggerNames = triggers.map((trigger) => trigger.name);
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      // Triggers mirror rows between tables; the copy carries both sides.
      for (const trigger of triggers) sqlite.exec(`DROP TRIGGER ${quote(trigger.name)}`);
      for (const table of snapshot.tables.keys()) sqlite.exec(`DELETE FROM ${quote(table)}`);
      const hasSequences = sqlite
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'sqlite_sequence'")
        .get();
      if (hasSequences) sqlite.exec('DELETE FROM sqlite_sequence');
      for (const [table, data] of snapshot.tables) {
        const names = data.columns.map((column) => column.name);
        const insert = sqlite.prepare(
          `INSERT INTO ${quote(table)} (${names.map(quote).join(', ')}) ` +
            `VALUES (${names.map(() => '?').join(', ')})`,
        );
        for (let start = 0; start < data.rows.length; start += BATCH_ROWS) {
          for (const row of data.rows.slice(start, start + BATCH_ROWS)) {
            insert.run(...names.map((name) => (row[name] ?? null) as never));
          }
        }
      }
      // AUTOINCREMENT counters continue after PostgreSQL's, not after the
      // highest surviving id, so a deleted id is never handed out again.
      for (const [table, { column, last }] of snapshot.sequences) {
        const create = sqlite
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table) as { sql: string } | undefined;
        if (!create || !/AUTOINCREMENT/i.test(create.sql)) continue;
        const highest = Number(
          (
            sqlite
              .prepare(`SELECT COALESCE(MAX(${quote(column)}), 0) AS id FROM ${quote(table)}`)
              .get() as { id: number }
          ).id,
        );
        const value = Math.max(last, highest);
        if (value > 0) {
          // Inserting explicit ids already created the row; raise it.
          const raised = sqlite
            .prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?')
            .run(value, table);
          if (!raised.changes) {
            sqlite
              .prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)')
              .run(table, value);
          }
          sequences[table] = value;
        }
      }
      for (const trigger of triggers) sqlite.exec(trigger.sql);
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
    // One self-contained file: no WAL left behind to travel with it.
    sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    sqlite.exec('PRAGMA journal_mode = DELETE');
  } finally {
    sqlite.close();
  }
  return { sequences, triggers: triggerNames };
}

/**
 * Open a finished SQLite file read-only and prove it: integrity, foreign
 * keys, schema readiness, and every table's rows and content hash against the
 * expected reconciliation.
 */
export function verifySqliteFile(
  path: string,
  expected: ExportedTable[],
  checkReady: ExportOptions['checkReady'],
  { triggers }: { triggers?: string[] } = {},
): void {
  const sqlite = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = sqlite.prepare('PRAGMA integrity_check').all() as {
      integrity_check: string;
    }[];
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new ExportError('The SQLite file failed its integrity check.');
    }
    if ((sqlite.prepare('PRAGMA foreign_key_check').all() as unknown[]).length) {
      throw new ExportError('The SQLite file has rows that break a foreign key.');
    }
    const readiness = checkReady(sqlite);
    if (!readiness.ready) {
      throw new ExportError(
        `The SQLite file is not at the current schema (${readiness.missingMigrationKeys.join(', ')}).`,
      );
    }
    const lite = sqliteTables(sqlite);
    const wanted = new Set(expected.map((entry) => entry.table));
    const missing = expected.filter((entry) => !lite.has(entry.table)).map((entry) => entry.table);
    const extra = [...lite.keys()].filter((name) => !wanted.has(name));
    if (missing.length || extra.length) {
      throw new ExportError(
        `The SQLite tables differ from the export (missing: ${missing.join(', ') || 'none'}; ` +
          `unexpected: ${extra.join(', ') || 'none'}).`,
      );
    }
    for (const entry of expected) {
      const names = lite.get(entry.table) ?? [];
      const rows = sqlite.prepare(`SELECT * FROM ${quote(entry.table)}`).all() as Row[];
      if (rows.length !== entry.rows) {
        throw new ExportError(
          `${entry.table}: the SQLite file has ${rows.length} rows, expected ${entry.rows}.`,
        );
      }
      if (digestTable(rows, names, entry.key) !== entry.sha256) {
        throw new ExportError(
          `${entry.table}: the SQLite rows differ from the PostgreSQL snapshot.`,
        );
      }
    }
    if (triggers) {
      const present = (
        sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
          .all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      if (present.join(',') !== [...triggers].sort().join(',')) {
        throw new ExportError('The SQLite triggers differ from the current schema.');
      }
    }
  } finally {
    sqlite.close();
  }
}

export function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function syncFile(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function syncDirectory(path: string): void {
  try {
    syncFile(path);
  } catch {
    // Not every platform can fsync a directory; the file itself is synced.
  }
}

function removeStaging(staging: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal', '.report']) {
    rmSync(`${staging}${suffix}`, { force: true });
  }
}

/**
 * Export `source` to a new SQLite file at `options.destination`.
 * The file is built and verified under a staging name in the same directory
 * and linked into place without overwriting, so the destination either holds
 * a complete, reconciled export or does not exist.
 */
export function exportPostgresToSqlite(
  source: PostgresDatabase,
  options: ExportOptions,
): ExportReport {
  const destination = options.destination;
  validateDestination(destination);
  assertNoLiveWriters(
    source,
    options.allowLiveWriters ? [] : (options.writerApplicationNames ?? []),
  );
  const snapshot = takeSnapshot(source, options.expectedEnvironment, options.migrations);

  const staging = join(
    dirname(destination),
    `.${basename(destination)}.exporting-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  const reportPath = `${destination}${EXPORT_REPORT_SUFFIX}`;
  let reportLinked = false;
  try {
    options.createSchema(staging);
    const { sequences, triggers } = loadSqlite(staging, snapshot);
    options.afterLoad?.(staging);
    const tables: ExportedTable[] = [...snapshot.tables.entries()].map(([table, data]) => ({
      table,
      rows: data.rows.length,
      sha256: data.sha256,
      key: data.key,
    }));
    verifySqliteFile(staging, tables, options.checkReady, { triggers });
    syncFile(staging);

    assertSourceMatches(source, tables, {
      expectedEnvironment: options.expectedEnvironment,
      writerApplicationNames: options.allowLiveWriters
        ? []
        : (options.writerApplicationNames ?? []),
      when: 'while it was being exported',
    });

    const report: ExportReport = {
      format: 1,
      createdAt: (options.now?.() ?? new Date()).toISOString(),
      environment: snapshot.environment,
      boundAt: snapshot.boundAt,
      migrationVersion: Math.max(...options.migrations.map((migration) => migration.version)),
      tables,
      totalRows: tables.reduce((sum, table) => sum + table.rows, 0),
      sqliteSha256: fileSha256(staging),
      writersQuiesced: !options.allowLiveWriters,
      sequences,
    };
    options.beforeExpose?.(staging);

    writeFileSync(`${staging}.report`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    syncFile(`${staging}.report`);
    // link() fails if the name appeared meanwhile; rename() would replace it.
    // The report goes first: a file without a report is never installable.
    linkSync(`${staging}.report`, reportPath);
    reportLinked = true;
    linkSync(staging, destination);
    syncDirectory(dirname(destination));
    return report;
  } catch (error) {
    if (reportLinked) rmSync(reportPath, { force: true });
    if ((error as { code?: string }).code === 'EEXIST') {
      throw new ExportError(`${destination} appeared during the export; nothing was replaced.`);
    }
    throw error;
  } finally {
    removeStaging(staging);
  }
}

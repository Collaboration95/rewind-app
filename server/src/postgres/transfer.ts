// One-off copy of a SQLite snapshot (for example a restored S3 backup) into
// the PostgreSQL database, with per-table reconciliation before commit.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { PostgresDatabase } from './database';

/** Tables that describe the database itself rather than application data. */
const META_TABLES = new Set([
  'schema_migrations',
  'schema_migration_markers',
  'rewind_database_environment',
]);

const BATCH_ROWS = 200;

export interface TableReconciliation {
  table: string;
  rows: number;
  sha256: string;
}

export interface TransferReport {
  sourceMigrationVersion: number;
  tables: TableReconciliation[];
  totalRows: number;
  replaced: boolean;
}

export class TransferError extends Error {}

type Row = Record<string, unknown>;

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Stable text for one value, identical for SQLite and PostgreSQL reads. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Uint8Array) return `x${Buffer.from(value).toString('hex')}`;
  if (typeof value === 'number' || typeof value === 'bigint') return `n${Number(value)}`;
  return `s${JSON.stringify(String(value))}`;
}

function digestTable(rows: Row[], columns: string[], keyColumns: string[]): string {
  const keyOf = (row: Row) => keyColumns.map((column) => canonical(row[column])).join('\u0000');
  const sorted = rows
    .map((row) => ({ key: keyOf(row), row }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const hash = createHash('sha256');
  for (const { row } of sorted) {
    hash.update(columns.map((column) => canonical(row[column])).join('\u0001'));
    hash.update('\n');
  }
  return hash.digest('hex');
}

interface TargetColumn {
  name: string;
  type: string;
}

function targetTables(target: PostgresDatabase): Map<string, TargetColumn[]> {
  const rows = target.queryNative(
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
    if (META_TABLES.has(table)) continue;
    const columns = tables.get(table) ?? [];
    columns.push({ name: String(row.name), type: String(row.type) });
    tables.set(table, columns);
  }
  return tables;
}

function primaryKey(target: PostgresDatabase, table: string): string[] {
  return target
    .queryNative(
      `SELECT a.attname AS name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = to_regclass($1) AND i.indisprimary
       ORDER BY array_position(i.indkey, a.attnum)`,
      [quote(table)],
    )
    .map((row) => String(row.name));
}

function checkValue(table: string, column: TargetColumn, value: unknown): void {
  if (value === null) return;
  const where = `${table}.${column.name}`;
  switch (column.type) {
    case 'bigint':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new TransferError(
          `${where} expects an integer but the snapshot holds ${JSON.stringify(value)}.`,
        );
      }
      return;
    case 'double precision':
      if (typeof value !== 'number') {
        throw new TransferError(
          `${where} expects a number but the snapshot holds ${JSON.stringify(value)}.`,
        );
      }
      return;
    case 'text':
      if (typeof value !== 'string') {
        throw new TransferError(`${where} expects text but the snapshot holds a ${typeof value}.`);
      }
      return;
    case 'boolean':
      if (value !== 0 && value !== 1) {
        throw new TransferError(`${where} expects 0 or 1 but the snapshot holds ${String(value)}.`);
      }
      return;
    case 'bytea':
      if (!(value instanceof Uint8Array)) {
        throw new TransferError(`${where} expects bytes.`);
      }
      return;
    default:
      throw new TransferError(`${where} has an unsupported type ${column.type}.`);
  }
}

function parameterCast(column: TargetColumn): string {
  return column.type === 'boolean' ? '::integer::boolean' : `::${column.type}`;
}

/**
 * Copy every application table from `sqlitePath` into `target` in a single
 * transaction. The target must be empty unless `replace` is set; nothing is
 * committed unless every table's row count and content hash match.
 * `migrateSnapshot` brings a copy of an older snapshot to the current SQLite
 * schema first; the source file itself is never modified.
 */
export function transferSqliteToPostgres(
  sqlitePath: string,
  target: PostgresDatabase,
  {
    replace = false,
    migrateSnapshot,
  }: { replace?: boolean; migrateSnapshot: (copyPath: string) => number },
): TransferReport {
  const workDir = mkdtempSync(join(tmpdir(), 'rewind-import-'));
  const copyPath = join(workDir, 'snapshot.sqlite');
  try {
    copyFileSync(sqlitePath, copyPath);
    const sourceMigrationVersion = migrateSnapshot(copyPath);
    const source = new DatabaseSync(copyPath, { readOnly: true });
    try {
      return copyTables(source, target, replace, sourceMigrationVersion);
    } finally {
      source.close();
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function copyTables(
  source: DatabaseSync,
  target: PostgresDatabase,
  replace: boolean,
  sourceMigrationVersion: number,
): TransferReport {
  const tables = targetTables(target);
  const sourceTables = new Set(
    (
      source
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    )
      .map((row) => row.name)
      .filter((name) => !META_TABLES.has(name)),
  );
  const missing = [...sourceTables].filter((name) => !tables.has(name));
  const extra = [...tables.keys()].filter((name) => !sourceTables.has(name));
  if (missing.length || extra.length) {
    throw new TransferError(
      `The schemas differ. Only in SQLite: ${missing.join(', ') || 'none'}; ` +
        `only in PostgreSQL: ${extra.join(', ') || 'none'}.`,
    );
  }

  target.exec('BEGIN IMMEDIATE');
  try {
    // Foreign keys are checked once, at the end, so tables load in any order.
    target.execNative('SET CONSTRAINTS ALL DEFERRED');
    const occupied = [...tables.keys()].filter(
      (table) => target.queryNative(`SELECT 1 FROM ${quote(table)} LIMIT 1`).length > 0,
    );
    if (occupied.length && !replace) {
      throw new TransferError(
        `The PostgreSQL database already holds data (${occupied.join(', ')}). ` +
          'Import only into an empty database, or pass --replace to overwrite it.',
      );
    }
    if (occupied.length) {
      target.execNative(`TRUNCATE ${[...tables.keys()].map(quote).join(', ')} RESTART IDENTITY`);
    }

    const report: TableReconciliation[] = [];
    for (const [table, columns] of [...tables.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const sourceColumns = new Set(
        (
          source.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]
        ).map((row) => row.name),
      );
      const names = columns.map((column) => column.name);
      if (names.length !== sourceColumns.size || names.some((name) => !sourceColumns.has(name))) {
        throw new TransferError(`The columns of ${table} differ between SQLite and PostgreSQL.`);
      }
      const rows = source.prepare(`SELECT * FROM ${quote(table)}`).all() as Row[];
      for (let start = 0; start < rows.length; start += BATCH_ROWS) {
        const batch = rows.slice(start, start + BATCH_ROWS);
        const values: unknown[] = [];
        const tuples = batch.map((row) => {
          const placeholders = columns.map((column) => {
            const value = row[column.name] ?? null;
            checkValue(table, column, value);
            values.push(value);
            return `$${values.length}${parameterCast(column)}`;
          });
          return `(${placeholders.join(', ')})`;
        });
        target.queryNative(
          `INSERT INTO ${quote(table)} (${names.map(quote).join(', ')}) VALUES ${tuples.join(', ')}`,
          values,
        );
      }
      const keyColumns = primaryKey(target, table);
      const key = keyColumns.length ? keyColumns : names;
      const copied = target.queryNative(`SELECT * FROM ${quote(table)}`);
      if (copied.length !== rows.length) {
        throw new TransferError(
          `${table}: copied ${copied.length} rows but the snapshot has ${rows.length}.`,
        );
      }
      const expected = digestTable(rows, names, key);
      const actual = digestTable(copied, names, key);
      if (expected !== actual) {
        throw new TransferError(`${table}: the copied rows differ from the snapshot.`);
      }
      report.push({ table, rows: rows.length, sha256: actual });
    }

    // Identity columns continue after the highest imported value.
    for (const row of target.queryNative(
      `SELECT table_name AS table, column_name AS column FROM information_schema.columns
       WHERE table_schema = current_schema() AND is_identity = 'YES'`,
    )) {
      const table = quote(String(row.table));
      const column = quote(String(row.column));
      target.queryNative(
        `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE(MAX(${column}), 0) + 1, false)
         FROM ${table}`,
        [table, String(row.column)],
      );
    }

    // Surface any foreign-key problem with its constraint before COMMIT.
    target.execNative('SET CONSTRAINTS ALL IMMEDIATE');
    target.exec('COMMIT');
    return {
      sourceMigrationVersion,
      tables: report,
      totalRows: report.reduce((sum, table) => sum + table.rows, 0),
      replaced: occupied.length > 0,
    };
  } catch (error) {
    target.exec('ROLLBACK');
    throw error;
  }
}

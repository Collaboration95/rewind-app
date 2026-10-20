import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseConfig, type RuntimeConfig } from './config';
import { type PostgresDatabase } from './postgres/database';
import {
  WRITER_APPLICATION_NAMES,
  anchor as databaseSnapshotAnchor,
  assertNoLiveWriters,
  assertSourceMatches,
  exportPostgresToSqlite,
  readEnvironment,
  type ExportOptions,
  type ExportReport,
} from './postgres/export';
import { installExportedDatabase, type InstallResult } from './postgres/install';
import {
  bootstrapDatabaseRoles,
  dropTestSchema,
  isPostgres,
  migratePostgres,
  openPostgres,
  openTestPostgres,
  testDatabaseUrl,
  type DatabaseRoles,
  verifyDatabaseEnvironment,
} from './postgres/runtime';
import {
  TransferError,
  digestTable,
  primaryKey,
  quote,
  transferSqliteToPostgres,
  type Row,
  type TableReconciliation,
  type TransferReport,
} from './postgres/transfer';
import { MIGRATIONS, migrateDatabase, schemaReadiness } from './schema';

export { backfillMediaIntegrity, migrateDatabase, schemaReadiness } from './schema';
export type { MediaIntegrityBackfillOptions, SchemaReadiness } from './schema';

/**
 * Local runs use node:sqlite. Hosted runs set REWIND_DATABASE_URL and get a
 * PostgresDatabase, which offers the same synchronous prepare/run/get/all/exec
 * surface (server/src/postgres), so persistence code is shared by both.
 */
export type RewindDatabase = DatabaseSync;

export { isPostgres };

function asRewindDatabase(database: unknown): RewindDatabase {
  return database as RewindDatabase;
}

function openMigratedPostgres(open: () => ReturnType<typeof openPostgres>, environment: string) {
  const database = open();
  try {
    migratePostgres(database, MIGRATIONS);
    verifyDatabaseEnvironment(database, environment);
  } catch (error) {
    database.close();
    throw error;
  }
  return asRewindDatabase(database);
}

export function openDatabase(config: RuntimeConfig): RewindDatabase {
  if (config.database) {
    const settings = config.database;
    return openMigratedPostgres(() => openPostgres(settings), settings.environment);
  }
  const testUrl = testDatabaseUrl();
  if (testUrl) {
    return openMigratedPostgres(() => openTestPostgres(testUrl, config.databasePath), 'test');
  }
  mkdirSync(config.dataDir, { recursive: true });
  const database = new DatabaseSync(config.databasePath);
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  migrateDatabase(database);
  return database;
}

/**
 * Operator commands (retention, consistency) open the existing database
 * without migrating or seeding; reports open it read-only.
 */
export function openOperationalDatabase(
  config: RuntimeConfig,
  { readOnly }: { readOnly: boolean },
): RewindDatabase {
  if (config.database) {
    return asRewindDatabase(
      openPostgres(config.database, { applicationName: 'rewind-operator', readOnly }),
    );
  }
  const testUrl = testDatabaseUrl();
  if (testUrl) {
    return asRewindDatabase(openTestPostgres(testUrl, config.databasePath, { readOnly }));
  }
  return new DatabaseSync(config.databasePath, readOnly ? { readOnly: true } : undefined);
}

export function openDatabaseAt(databasePath: string): RewindDatabase {
  const testUrl = testDatabaseUrl();
  if (testUrl) {
    return openMigratedPostgres(() => openTestPostgres(testUrl, databasePath), 'test');
  }
  return openSqliteDatabaseAt(databasePath);
}

/** Always SQLite, whatever the environment (snapshot import, local tools). */
export function openSqliteDatabaseAt(databasePath: string): RewindDatabase {
  const dataDir = resolve(databasePath, '..');
  mkdirSync(dataDir, { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  migrateDatabase(database);
  return database;
}

function postgresTarget(config: RuntimeConfig) {
  if (config.database) {
    const settings = config.database;
    return { open: () => openPostgres(settings), environment: settings.environment };
  }
  const testUrl = testDatabaseUrl();
  if (testUrl) {
    return { open: () => openTestPostgres(testUrl, config.databasePath), environment: 'test' };
  }
  return null;
}

/**
 * Copy a SQLite snapshot (for example a restored S3 backup) into the
 * configured PostgreSQL database. A copy of the snapshot is migrated to the
 * current SQLite schema first; the snapshot file itself is not changed.
 */
export function importSqliteSnapshot(
  config: RuntimeConfig,
  sqlitePath: string,
  { replace = false }: { replace?: boolean } = {},
): TransferReport {
  const target = postgresTarget(config);
  if (!target) {
    throw new TransferError('Set REWIND_DATABASE_URL to the PostgreSQL database to import into.');
  }
  if (!existsSync(sqlitePath)) throw new TransferError(`No SQLite snapshot at ${sqlitePath}.`);
  const database = openMigratedPostgres(target.open, target.environment);
  try {
    return transferSqliteToPostgres(sqlitePath, database as unknown as PostgresDatabase, {
      replace,
      migrateSnapshot: (copyPath) => {
        const snapshot = openSqliteDatabaseAt(copyPath);
        try {
          const readiness = schemaReadiness(snapshot);
          if (!readiness.ready) {
            throw new TransferError(
              `The snapshot could not be migrated: ${readiness.missingMigrationKeys.join(', ')}.`,
            );
          }
          return readiness.expectedMigrationVersion;
        } finally {
          snapshot.close();
        }
      },
    });
  } finally {
    database.close();
  }
}

function exportSource(config: RuntimeConfig) {
  if (config.database) {
    const settings = config.database;
    return {
      open: () => openPostgres(settings, { applicationName: 'rewind-export', readOnly: true }),
      environment: settings.environment,
      testRun: false,
    };
  }
  const testUrl = testDatabaseUrl();
  if (!testUrl) return null;
  return {
    open: () => openTestPostgres(testUrl, config.databasePath, { readOnly: true }),
    environment: 'test',
    testRun: true,
  };
}

/**
 * Copy the configured PostgreSQL database into a new SQLite file at
 * `sqlitePath` from one consistent snapshot, reconciled table by table.
 * The runtime, scheduler, reminder loop and workers must be stopped first;
 * the file is only exposed at `sqlitePath` once it is verified. Use
 * installSqliteExport to put it in service.
 */
export function exportDatabaseToSqlite(
  config: RuntimeConfig,
  sqlitePath: string,
  {
    allowLiveWriters = false,
    writerApplicationNames,
    hooks,
  }: {
    allowLiveWriters?: boolean;
    /** Tests: which session names count as writers. */
    writerApplicationNames?: string[];
    /** Tests: fault injection while the file is being built. */
    hooks?: Pick<ExportOptions, 'afterLoad' | 'beforeExpose'>;
  } = {},
): ExportReport {
  const destination = resolve(sqlitePath);
  const target = exportSource(config);
  if (!target) {
    throw new TransferError('Set REWIND_DATABASE_URL to the PostgreSQL database to export.');
  }
  if (destination === resolve(config.databasePath)) {
    throw new TransferError(
      `${destination} is the live SQLite path. Export to a new file, then install it with database-install.`,
    );
  }
  const source = target.open();
  try {
    return exportPostgresToSqlite(source, {
      destination,
      expectedEnvironment: target.environment,
      migrations: MIGRATIONS,
      createSchema: (path) => openSqliteDatabaseAt(path).close(),
      checkReady: (database) => schemaReadiness(database),
      // Test runs share one server, so their sessions cannot be attributed.
      writerApplicationNames:
        writerApplicationNames ?? (target.testRun ? [] : WRITER_APPLICATION_NAMES),
      allowLiveWriters,
      ...hooks,
    });
  } finally {
    source.close();
  }
}

/**
 * Swap a validated export into the live SQLite path (config.databasePath),
 * keeping the previous file beside it. Database only: media is not touched.
 * While PostgreSQL is still configured, it is read once more first and the
 * install is refused if anything changed (or a writer is connected) since the
 * export. `skipSourceCheck` accepts that risk when PostgreSQL is unreadable.
 */
export function installSqliteExport(
  config: RuntimeConfig,
  stagedPath: string,
  {
    environment,
    skipSourceCheck = false,
    writerApplicationNames,
  }: { environment?: string; skipSourceCheck?: boolean; writerApplicationNames?: string[] } = {},
): InstallResult & { sourceVerified: boolean } {
  const target = skipSourceCheck ? null : exportSource(config);
  let sourceVerified = false;
  const result = installExportedDatabase(stagedPath, config.databasePath, {
    expectedEnvironment:
      environment ??
      (process.env.REWIND_DATABASE_ENVIRONMENT?.trim() ||
        process.env.REWIND_MEDIA_ENVIRONMENT?.trim() ||
        undefined),
    checkReady: (database) => schemaReadiness(database),
    checkSource: target
      ? (report) => {
          const source = target.open();
          try {
            assertSourceMatches(source, report.tables, {
              expectedEnvironment: report.environment,
              writerApplicationNames:
                writerApplicationNames ?? (target.testRun ? [] : WRITER_APPLICATION_NAMES),
              when: 'since it was exported',
            });
            sourceVerified = true;
          } finally {
            source.close();
          }
        }
      : undefined,
  });
  return { ...result, sourceVerified };
}

/**
 * Create the application and read-only roles with the managed database's
 * admin login (REWIND_DATABASE_ADMIN_URL), streamed in for this one command.
 */
export function bootstrapDatabase(env: NodeJS.ProcessEnv = process.env): DatabaseRoles {
  const admin = parseConfig({
    ...env,
    REWIND_DATABASE_URL: env.REWIND_DATABASE_ADMIN_URL,
  }).database;
  if (!admin) throw new TransferError('Set REWIND_DATABASE_ADMIN_URL for database-bootstrap.');
  const roles: DatabaseRoles = {
    schema: env.REWIND_DATABASE_SCHEMA?.trim() || 'rewind',
    appRole: env.REWIND_DATABASE_APP_ROLE?.trim() || 'rewind_app',
    appPassword: env.REWIND_DATABASE_APP_PASSWORD ?? '',
    readonlyRole: env.REWIND_DATABASE_READONLY_ROLE?.trim() || 'rewind_readonly',
    readonlyPassword: env.REWIND_DATABASE_READONLY_PASSWORD ?? '',
  };
  const database = openPostgres(admin, { applicationName: 'rewind-bootstrap' });
  try {
    bootstrapDatabaseRoles(database, roles);
  } finally {
    database.close();
  }
  return { ...roles, appPassword: '', readonlyPassword: '' };
}

export interface DatabaseStatus {
  engine: 'sqlite' | 'postgresql';
  location: string;
  ready: boolean;
  /** The schema version this release expects. */
  migrationVersion: number;
  /** The highest version recorded in the database (0 when empty). */
  appliedMigrationVersion: number;
  environment: string | null;
  serverVersion: string | null;
  rows: Record<string, number>;
  tables: TableReconciliation[];
  capturedAt: string;
  snapshot?: string;
}

/** Operator summary: engine, schema readiness and per-table row counts. */
export function databaseStatus(
  config: RuntimeConfig,
  requireStoppedWriters = false,
): DatabaseStatus {
  const snapshot = openDatabaseStatusSnapshot(config, { requireStoppedWriters });
  try {
    return snapshot.status;
  } finally {
    snapshot.close();
  }
}

/** Hold a read-only snapshot until pg_dump has imported its exported ID. */
export function openDatabaseStatusSnapshot(
  config: RuntimeConfig,
  {
    exportSnapshot = false,
    requireStoppedWriters = false,
  }: { exportSnapshot?: boolean; requireStoppedWriters?: boolean } = {},
) {
  const database = openOperationalDatabase(config, { readOnly: true });
  const postgres = isPostgres(database);
  const close = () => {
    try {
      database.exec('ROLLBACK');
    } finally {
      database.close();
    }
  };
  try {
    if (postgres) database.execNative('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    else database.exec('BEGIN');
    const anchor = postgres ? databaseSnapshotAnchor(database) : null;
    if (postgres && requireStoppedWriters) assertNoLiveWriters(database, WRITER_APPLICATION_NAMES);
    const readiness = schemaReadiness(database);
    const tables = (
      database
        .prepare(
          postgres
            ? `SELECT table_name AS name FROM information_schema.tables
               WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY name`
            : "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    const rows: Record<string, number> = {};
    const fingerprints: TableReconciliation[] = [];
    for (const table of tables) {
      const columns = postgres
        ? database
            .queryNative(
              'SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position',
              [table],
            )
            .map((row) => String(row.name))
        : (
            database.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all(table) as {
              name: string;
            }[]
          ).map((row) => row.name);
      const keys = postgres
        ? primaryKey(database, table)
        : (
            database
              .prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk')
              .all(table) as { name: string }[]
          ).map((row) => row.name);
      const values = database.prepare(`SELECT * FROM ${quote(table)}`).all() as Row[];
      rows[table] = values.length;
      fingerprints.push({
        table,
        rows: values.length,
        sha256: digestTable(values, columns, keys.length ? keys : columns),
      });
    }
    const status: DatabaseStatus = {
      engine: postgres ? 'postgresql' : 'sqlite',
      location: postgres ? (config.database?.host ?? 'test') : config.databasePath,
      ready: readiness.ready,
      migrationVersion: readiness.expectedMigrationVersion,
      appliedMigrationVersion: tables.includes('schema_migrations')
        ? Number(
            (
              database
                .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
                .get() as {
                version: number;
              }
            ).version,
          )
        : 0,
      environment: postgres
        ? readEnvironment(database, config.database?.environment ?? 'test').environment
        : null,
      serverVersion: postgres
        ? String(
            (database.prepare('SHOW server_version').get() as { server_version: string })
              .server_version,
          )
        : null,
      rows,
      tables: fingerprints,
      capturedAt: postgres
        ? String(
            database.queryNative(
              'SELECT to_char(clock_timestamp() AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS stamp',
            )[0].stamp,
          )
        : new Date().toISOString(),
    };
    if (exportSnapshot) {
      if (!postgres) throw new TransferError('Exported snapshots require PostgreSQL.');
      status.snapshot = String(
        database.queryNative('SELECT pg_export_snapshot() AS snapshot')[0].snapshot,
      );
    }
    if (postgres && databaseSnapshotAnchor(database) !== anchor) {
      throw new TransferError('The database snapshot connection changed during inspection.');
    }
    return { status, close };
  } catch (error) {
    close();
    throw error;
  }
}

export function resetDatabase(config: RuntimeConfig): void {
  // The path is resolved from the validated data directory. Reset removes
  // database and media data only; source code and migrations are never in
  // this directory.
  if (config.database) {
    // Hosted PostgreSQL is recovered from backups, never reset by the app.
    throw new Error('Reset only clears local SQLite data; REWIND_DATABASE_URL is set.');
  }
  const mediaDir = resolve(config.dataDir, 'media');
  clearMediaDirectory(mediaDir);
  const testUrl = testDatabaseUrl();
  if (testUrl) dropTestSchema(testUrl, config.databasePath);
  for (const path of [
    config.databasePath,
    `${config.databasePath}-wal`,
    `${config.databasePath}-shm`,
  ]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

/** Clear media without removing the media directory itself, which is a
 * bind-mount target in the hosted container. */
export function clearMediaDirectory(mediaDir: string): void {
  if (!existsSync(mediaDir)) return;
  for (const entry of readdirSync(mediaDir)) {
    rmSync(resolve(mediaDir, entry), { recursive: true, force: true });
  }
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
    .prepare(
      `SELECT 1 AS member FROM memberships WHERE group_id = ? AND member_id = ?
       UNION ALL
       SELECT 1 AS member FROM real_group_memberships
        WHERE group_id = ? AND profile_id = ? AND accepted_at IS NOT NULL
       LIMIT 1`,
    )
    .get(groupId, memberId, groupId, memberId) as { member?: number } | undefined;
  return row?.member === 1;
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
  films: { id: string; cycleId: string; publishedAt: string; outputPath: string }[];
  clips: {
    id: string;
    contributionId: string;
    cycleId: string;
    createdAt: string;
    outputPath: string;
  }[];
  nextFilmCursor: [string, string, string] | null;
  nextClipCursor: [string, string] | null;
  hasMoreFilms: boolean;
  hasMoreClips: boolean;
}

export interface ReleasedArchivePageOptions {
  limit?: number;
  includeFilms?: boolean;
  includeClips?: boolean;
  filmCursor?: [publishedAt: string, createdAt: string, id: string] | null;
  clipCursor?: [createdAt: string, id: string] | null;
}

/** List only ready, released media. Filesystem paths stay server-side. */
export function listReleasedArchive(
  database: RewindDatabase,
  groupId: string,
  memberId: string,
  options: ReleasedArchivePageOptions = {},
): ReleasedArchiveRecord {
  const limit =
    Number.isInteger(options.limit) && options.limit! > 0 ? Math.min(options.limit!, 50) : 50;
  const filmCursorWhere = options.filmCursor
    ? `AND (c.release_published_at < ? OR (c.release_published_at = ? AND
         (f.created_at < ? OR (f.created_at = ? AND f.id < ?))))`
    : '';
  const filmParams: (string | number)[] = [groupId];
  if (options.filmCursor) {
    const [publishedAt, createdAt, id] = options.filmCursor;
    filmParams.push(publishedAt, publishedAt, createdAt, createdAt, id);
  }
  filmParams.push(limit + 1);
  const filmRows =
    options.includeFilms === false
      ? []
      : (database
          .prepare(
            `SELECT f.id, c.id AS cycleId, c.release_published_at AS publishedAt,
              f.created_at AS createdAt, f.output_path AS outputPath
       FROM media_jobs f
       JOIN cycles c ON c.id = f.cycle_id AND c.group_id = f.group_id
       WHERE f.group_id = ? AND f.kind = 'film' AND f.status = 'ready'
         AND f.output_path IS NOT NULL AND c.release_status = 'published'
         ${filmCursorWhere}
       ORDER BY c.release_published_at DESC, f.created_at DESC, f.id DESC LIMIT ?`,
          )
          .all(...filmParams) as Record<string, unknown>[]);
  const hasMoreFilms = options.includeFilms !== false && filmRows.length > limit;
  const films = filmRows.slice(0, limit);

  const clipCursorWhere = options.clipCursor
    ? `AND (contribution.created_at < ? OR (contribution.created_at = ? AND clip.id < ?))`
    : '';
  const clipParams: (string | number)[] = [groupId, memberId, groupId];
  if (options.clipCursor) {
    const [createdAt, id] = options.clipCursor;
    clipParams.push(createdAt, createdAt, id);
  }
  clipParams.push(limit + 1);
  const clipRows =
    options.includeClips === false
      ? []
      : (database
          .prepare(
            `SELECT clip.id, contribution.id AS contributionId, cycle.id AS cycleId,
              contribution.created_at AS createdAt, clip.output_path AS outputPath
       FROM media_jobs clip
       JOIN contributions contribution ON contribution.id = clip.contribution_id
       JOIN cycles cycle ON cycle.id = contribution.cycle_id
       WHERE clip.group_id = ? AND clip.kind = 'clip' AND clip.status = 'ready'
         AND clip.output_path IS NOT NULL AND contribution.member_id = ?
         AND cycle.group_id = ? AND cycle.release_status = 'published'
         AND clip.deleted_at IS NULL
         ${clipCursorWhere}
       ORDER BY contribution.created_at DESC, clip.id DESC LIMIT ?`,
          )
          .all(...clipParams) as Record<string, unknown>[]);
  const hasMoreClips = options.includeClips !== false && clipRows.length > limit;
  const clips = clipRows.slice(0, limit);
  return {
    films: films.map((film) => ({
      id: String(film.id),
      cycleId: String(film.cycleId),
      publishedAt: String(film.publishedAt),
      outputPath: String(film.outputPath),
    })),
    clips: clips.map((clip) => ({
      id: String(clip.id),
      contributionId: String(clip.contributionId),
      cycleId: String(clip.cycleId),
      createdAt: String(clip.createdAt),
      outputPath: String(clip.outputPath),
    })),
    nextFilmCursor:
      hasMoreFilms && films.length > 0
        ? [
            String(films[films.length - 1].publishedAt),
            String(films[films.length - 1].createdAt),
            String(films[films.length - 1].id),
          ]
        : null,
    nextClipCursor:
      hasMoreClips && clips.length > 0
        ? [String(clips[clips.length - 1].createdAt), String(clips[clips.length - 1].id)]
        : null,
    hasMoreFilms,
    hasMoreClips,
  };
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

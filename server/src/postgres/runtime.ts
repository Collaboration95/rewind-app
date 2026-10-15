// Opening, migrating and checking a PostgreSQL database for the runtime.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { PostgresRuntimeConfig } from '../config';
import { PostgresDatabase } from './database';

/** The PostgreSQL baseline stands in for SQLite migrations 1-30. */
export const POSTGRES_BASELINE_VERSION = 30;

const MIGRATION_DIR = () => resolve(process.cwd(), 'server/migrations/postgres');
const CA_BUNDLE = () => resolve(__dirname, '..', '..', 'certs', 'rds-global-bundle.pem');

export function isPostgres(database: unknown): database is PostgresDatabase {
  return database instanceof PostgresDatabase;
}

export function postgresMigrationFiles(): Map<number, string> {
  const files = new Map<number, string>();
  for (const name of readdirSync(MIGRATION_DIR())) {
    const match = /^(\d{3})-[a-z0-9-]+\.sql$/.exec(name);
    if (!match) continue;
    const version = Number(match[1]);
    if (files.has(version)) throw new Error(`Two PostgreSQL migrations claim version ${version}.`);
    files.set(version, name);
  }
  if (!files.has(POSTGRES_BASELINE_VERSION)) {
    throw new Error('The PostgreSQL baseline migration is missing.');
  }
  return files;
}

export function openPostgres(
  config: PostgresRuntimeConfig,
  options: {
    applicationName?: string;
    schema?: string | null;
    createSchema?: boolean;
    readOnly?: boolean;
    testDatabasePath?: string;
  } = {},
): PostgresDatabase {
  return new PostgresDatabase({
    testDatabasePath: options.testDatabasePath,
    readOnly: options.readOnly ?? false,
    connectionString: config.url,
    schema: options.schema ?? null,
    createSchema: options.createSchema ?? false,
    applicationName: options.applicationName ?? 'rewind-runtime',
    ssl:
      config.tls === 'verify'
        ? { rejectUnauthorized: true, ca: readFileSync(CA_BUNDLE(), 'utf8') }
        : null,
  });
}

/**
 * Test runs set REWIND_TEST_DATABASE_URL to exercise the whole server suite
 * on PostgreSQL. Each SQLite file path then maps to its own schema, so
 * reopening "the same file" reaches the same data, as it does on SQLite.
 */
export function testDatabaseUrl(): string | null {
  const url = process.env.REWIND_TEST_DATABASE_URL?.trim();
  if (!url) return null;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('REWIND_TEST_DATABASE_URL is for test runs and is refused in production.');
  }
  return url;
}

export function testSchemaForPath(databasePath: string): string {
  return `test_${createHash('sha256').update(resolve(databasePath)).digest('hex').slice(0, 24)}`;
}

export function openTestPostgres(
  url: string,
  databasePath: string,
  options: { readOnly?: boolean } = {},
): PostgresDatabase {
  return openPostgres(
    { url, host: new URL(url).hostname, tls: 'disable', environment: 'test' },
    {
      readOnly: options.readOnly ?? false,
      schema: testSchemaForPath(databasePath),
      createSchema: true,
      applicationName: 'rewind-test',
      testDatabasePath: resolve(databasePath),
    },
  );
}

export function dropTestSchema(url: string, databasePath: string): void {
  const admin = openPostgres({
    url,
    host: new URL(url).hostname,
    tls: 'disable',
    environment: 'test',
  });
  try {
    admin.execNative(`DROP SCHEMA IF EXISTS "${testSchemaForPath(databasePath)}" CASCADE`);
  } finally {
    admin.close();
  }
}

function utcNow(): string {
  return new Date().toISOString();
}

/**
 * Apply the baseline and every later PostgreSQL migration under the shared
 * writer lock, so concurrent starters (server, worker) migrate exactly once.
 * `versions` maps each SQLite migration version above the baseline to its
 * durable key; each needs a PostgreSQL file with the same version.
 */
export function migratePostgres(
  database: PostgresDatabase,
  versions: { version: number; key: string }[],
): void {
  const files = postgresMigrationFiles();
  for (const { version } of versions) {
    if (version > POSTGRES_BASELINE_VERSION && !files.has(version)) {
      throw new Error(
        `SQLite migration ${version} has no PostgreSQL counterpart in server/migrations/postgres.`,
      );
    }
  }
  // Like SQLite, a fully migrated database needs no writer lock to open.
  if (postgresMissingMigrationKeys(database, versions).length === 0) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    const present = database.queryNative("SELECT to_regclass('schema_migrations') AS name")[0];
    if (present.name === null) {
      database.execNative(
        readFileSync(resolve(MIGRATION_DIR(), files.get(POSTGRES_BASELINE_VERSION)!), 'utf8'),
      );
    }
    const applied = new Set(
      database
        .queryNative('SELECT version FROM schema_migrations')
        .map((row) => Number(row.version)),
    );
    for (const { version, key } of versions) {
      if (version <= POSTGRES_BASELINE_VERSION || applied.has(version)) continue;
      database.execNative(readFileSync(resolve(MIGRATION_DIR(), files.get(version)!), 'utf8'));
      database.queryNative('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [
        version,
        utcNow(),
      ]);
      database.queryNative(
        `INSERT INTO schema_migration_markers (migration_key, applied_at) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [key, utcNow()],
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Bind a database to one environment on first use. A dev runtime pointed at
 * the release database (or the reverse) refuses to start instead of writing.
 */
export function verifyDatabaseEnvironment(database: PostgresDatabase, environment: string): void {
  database.queryNative(
    `INSERT INTO rewind_database_environment (singleton, environment, bound_at)
     VALUES (true, $1, $2) ON CONFLICT (singleton) DO NOTHING`,
    [environment, utcNow()],
  );
  const bound = database.queryNative('SELECT environment FROM rewind_database_environment')[0];
  if (bound?.environment !== environment) {
    throw new Error(
      `This database belongs to the "${String(bound?.environment)}" environment, not "${environment}". ` +
        'Check REWIND_DATABASE_URL and REWIND_DATABASE_ENVIRONMENT.',
    );
  }
}

export function postgresMissingMigrationKeys(
  database: PostgresDatabase,
  migrations: { version: number; key: string }[],
): string[] {
  const present = database.queryNative("SELECT to_regclass('schema_migrations') AS name")[0];
  if (present.name === null) return migrations.map((migration) => migration.key);
  const versions = new Set(
    database.queryNative('SELECT version FROM schema_migrations').map((row) => Number(row.version)),
  );
  const markers = new Set(
    database
      .queryNative('SELECT migration_key FROM schema_migration_markers')
      .map((row) => String(row.migration_key)),
  );
  return migrations
    .filter((migration) => !versions.has(migration.version) || !markers.has(migration.key))
    .map((migration) => migration.key);
}

export interface DatabaseRoles {
  schema: string;
  appRole: string;
  appPassword: string;
  readonlyRole: string;
  readonlyPassword: string;
}

/**
 * One-time setup run with the managed database's admin login: an application
 * role that owns the Rewind schema (it runs migrations) and a read-only role
 * for backups and operator inspection. Safe to rerun; it rotates passwords.
 */
export function bootstrapDatabaseRoles(admin: PostgresDatabase, roles: DatabaseRoles): void {
  for (const name of [roles.schema, roles.appRole, roles.readonlyRole]) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name))
      throw new Error(`Invalid role or schema name: ${name}`);
  }
  for (const password of [roles.appPassword, roles.readonlyPassword]) {
    if (password.length < 24)
      throw new Error('Database role passwords must be at least 24 characters.');
  }
  const run = (template: string, ...values: string[]) => {
    const [{ sql }] = admin.queryNative(
      `SELECT format($1::text, ${values.map((_, i) => `$${i + 2}::text`).join(', ')}) AS sql`,
      [template, ...values],
    );
    admin.execNative(String(sql));
  };
  const roleExists = (name: string) =>
    admin.queryNative('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]).length > 0;
  for (const [role, password] of [
    [roles.appRole, roles.appPassword],
    [roles.readonlyRole, roles.readonlyPassword],
  ]) {
    run(
      roleExists(role) ? 'ALTER ROLE %I LOGIN PASSWORD %L' : 'CREATE ROLE %I LOGIN PASSWORD %L',
      role,
      password,
    );
  }
  const [{ database }] = admin.queryNative('SELECT current_database() AS database');
  // The admin must be able to hand the schema to the app role.
  run('GRANT %I TO current_user', roles.appRole);
  run(
    'GRANT CONNECT ON DATABASE %I TO %I, %I',
    String(database),
    roles.appRole,
    roles.readonlyRole,
  );
  run('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', roles.schema, roles.appRole);
  run('ALTER SCHEMA %I OWNER TO %I', roles.schema, roles.appRole);
  run('REVOKE ALL ON SCHEMA %I FROM PUBLIC', roles.schema);
  run('ALTER ROLE %I SET search_path = %I', roles.appRole, roles.schema);
  run('ALTER ROLE %I SET search_path = %I', roles.readonlyRole, roles.schema);
  run('ALTER ROLE %I SET default_transaction_read_only = on', roles.readonlyRole);
  run('GRANT USAGE ON SCHEMA %I TO %I', roles.schema, roles.readonlyRole);
  run('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', roles.schema, roles.readonlyRole);
  run('GRANT SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', roles.schema, roles.readonlyRole);
  run(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT ON TABLES TO %I',
    roles.appRole,
    roles.schema,
    roles.readonlyRole,
  );
  run(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT ON SEQUENCES TO %I',
    roles.appRole,
    roles.schema,
    roles.readonlyRole,
  );
}

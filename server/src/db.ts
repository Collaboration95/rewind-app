import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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

export function openDatabase(config: RuntimeConfig): RewindDatabase {
  mkdirSync(config.dataDir, { recursive: true });
  const database = new DatabaseSync(config.databasePath);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  migrateDatabase(database);
  seedDatabase(database);
  return database;
}

export function openDatabaseAt(databasePath: string): RewindDatabase {
  const dataDir = resolve(databasePath, '..');
  mkdirSync(dataDir, { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  migrateDatabase(database);
  seedDatabase(database);
  return database;
}

export function migrateDatabase(database: RewindDatabase): void {
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
    if (marked?.applied && applied?.applied) {
      if (
        migration.key === 'media-processing-v1' &&
        tableColumns(database, 'media_jobs').has('source_path') &&
        !tableColumns(database, 'media_jobs').has('processing_started_at')
      ) {
        database.exec('ALTER TABLE media_jobs ADD COLUMN processing_started_at TEXT');
      }
      continue;
    }
    const quotaReady =
      hasTable(database, 'contribution_quota_windows') &&
      hasTable(database, 'staged_sources') &&
      hasTable(database, 'media_metadata') &&
      tableColumns(database, 'contributions').has('quota_window_start_at');
    const mediaBaseReady = [
      'source_path',
      'trim_start_seconds',
      'trim_end_seconds',
      'mode',
      'error_code',
    ].every((column) => tableColumns(database, 'media_jobs').has(column));

    // Older #45 databases already ran the media migration before the worker
    // lease column was introduced. Add that nullable column in place so a
    // restart can recover a job claimed by a process that died mid-transform.
    if (
      migration.key === 'media-processing-v1' &&
      mediaBaseReady &&
      !tableColumns(database, 'media_jobs').has('processing_started_at')
    ) {
      database.exec('ALTER TABLE media_jobs ADD COLUMN processing_started_at TEXT');
    }
    const mediaReady = [
      'source_path',
      'trim_start_seconds',
      'trim_end_seconds',
      'mode',
      'error_code',
      'processing_started_at',
    ].every((column) => tableColumns(database, 'media_jobs').has(column));

    // Version 6 was briefly occupied by #45's media ALTERs. The stable
    // migration key lets an integrated build install #44's quota/staging
    // schema exactly once without trying to reuse that version row.
    if (migration.key === 'contribution-quota-v1' && applied?.applied && !quotaReady) {
      database.exec(migration.sql);
      migrateLegacyStagedSources(database);
      markMigration(database, migration.key);
      continue;
    }

    // Existing #44 databases may have the quota schema but no marker, while
    // existing #45 databases may have media columns at version 6. In either
    // case, record the stable identity and never replay duplicate ALTERs.
    if (migration.key === 'media-processing-v1' && mediaReady) {
      if (!applied?.applied) {
        database
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString());
      }
      migrateLegacyStagedSources(database);
      markMigration(database, migration.key);
      continue;
    }

    if (applied?.applied) {
      if (migration.key === 'contribution-quota-v1') migrateLegacyStagedSources(database);
      markMigration(database, migration.key);
      continue;
    }

    database.exec(migration.sql);
    if (migration.key === 'contribution-quota-v1') migrateLegacyStagedSources(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(migration.version, new Date().toISOString());
    markMigration(database, migration.key);
  }
  // The staged-source lease/generation fence was added after the original
  // quota migration had shipped. Keep the migration identity stable while
  // upgrading existing local databases in place.
  if (hasTable(database, 'staged_sources')) {
    const columns = tableColumns(database, 'staged_sources');
    if (!columns.has('claim_generation')) {
      database.exec(
        'ALTER TABLE staged_sources ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0',
      );
    }
    if (!columns.has('claim_expires_at')) {
      database.exec('ALTER TABLE staged_sources ADD COLUMN claim_expires_at TEXT');
    }
  }
}

function markMigration(database: RewindDatabase, key: string): void {
  database
    .prepare(
      'INSERT OR IGNORE INTO schema_migration_markers (migration_key, applied_at) VALUES (?, ?)',
    )
    .run(key, new Date().toISOString());
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
    const linkedJob = database
      .prepare(
        'SELECT idempotency_key AS idempotencyKey FROM media_jobs WHERE source_path = ? LIMIT 1',
      )
      .get(row.sourcePath) as { idempotencyKey?: string } | undefined;
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
  // The path is resolved from the validated data directory. Reset removes the
  // local DB plus server-owned temporary sources; migrations and retained
  // processed output remain available for the next local run.
  const stagingDir = resolve(config.dataDir, 'media', 'staging');
  if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
  for (const path of [
    config.databasePath,
    `${config.databasePath}-wal`,
    `${config.databasePath}-shm`,
  ]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

/** Restore only the SQLite-backed local fixture. Source files and migrations
 * are never touched. This form is used by the in-process reset endpoint. */
export function restoreFixture(database: RewindDatabase): void {
  database.exec('BEGIN');
  try {
    for (const table of [
      'reactions',
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
        count_used AS countUsed, seconds_used AS secondsUsed
       FROM cycles WHERE group_id = ? ORDER BY starts_at DESC LIMIT 1`,
    )
    .get(groupId) as Record<string, unknown> | undefined;
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
  return database
    .prepare(
      'SELECT id, group_id AS groupId, member_id AS memberId, body, created_at AS createdAt FROM messages WHERE id = ? AND group_id = ?',
    )
    .get(messageId, groupId);
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
  return database
    .prepare(
      'SELECT id, group_id AS groupId, kind, status, created_at AS createdAt FROM media_jobs WHERE id = ? AND group_id = ? AND kind = ?',
    )
    .get(jobId, groupId, kind);
}

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import type { RuntimeConfig } from './config';

const MIGRATION = readFileSync(resolve(process.cwd(), 'server/migrations/001-initial.sql'), 'utf8');
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
  const migration = database
    .prepare('SELECT 1 AS applied FROM schema_migrations WHERE version = ?')
    .get(1) as { applied?: number } | undefined;
  if (!migration?.applied) {
    database.exec(MIGRATION);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(1, new Date().toISOString());
  }
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
    for (const profile of FIXTURE.profiles) {
      membershipInsert.run(FIXTURE.group.id, profile.id, 'member', now);
    }

    database
      .prepare(
        'INSERT INTO sessions (id, member_id, group_id, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('demo-session', FIXTURE.profiles[0].id, FIXTURE.group.id, now, now);
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
  // The path is resolved from the validated data directory; only the local DB
  // and SQLite's transient WAL files are removed. Source and migrations remain.
  for (const path of [
    config.databasePath,
    `${config.databasePath}-wal`,
    `${config.databasePath}-shm`,
  ]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
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

export function getGroup(database: RewindDatabase, groupId: string) {
  const group = database
    .prepare('SELECT id, name, current_cycle_id AS currentCycleId FROM groups WHERE id = ?')
    .get(groupId) as Record<string, unknown> | undefined;
  if (!group) return null;
  const members = database
    .prepare('SELECT member_id AS memberId FROM memberships WHERE group_id = ? ORDER BY member_id')
    .all(groupId)
    .map((row) => String((row as { memberId: string }).memberId));
  return {
    id: String(group.id),
    name: String(group.name),
    currentCycleId: String(group.currentCycleId),
    memberIds: members,
  };
}

export function getCurrentCycle(database: RewindDatabase, groupId: string) {
  const cycle = database
    .prepare(
      `SELECT id, group_id AS groupId, prompt, starts_at AS startsAt, ends_at AS endsAt,
        status, lock_state AS lockState, max_count AS maxCount, max_seconds AS maxSeconds,
        count_used AS countUsed, seconds_used AS secondsUsed
       FROM cycles WHERE group_id = ? ORDER BY starts_at DESC LIMIT 1`,
    )
    .get(groupId) as Record<string, unknown> | undefined;
  if (!cycle) return null;
  return {
    id: String(cycle.id),
    groupId: String(cycle.groupId),
    prompt: String(cycle.prompt),
    startsAt: String(cycle.startsAt),
    endsAt: String(cycle.endsAt),
    status: String(cycle.status),
    lockState: String(cycle.lockState),
    quota: { maxCount: Number(cycle.maxCount), maxSeconds: Number(cycle.maxSeconds) },
    contributionUsage: {
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

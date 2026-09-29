import { randomUUID } from 'node:crypto';

import type { RewindDatabase } from '../db';
import { createCycleWindow } from '../cycles/engine';
const GROUP_NAME_MAX_LENGTH = 80;
const PROMPT_MAX_LENGTH = 160;

export const MIN_REAL_GROUP_MEMBERS = 2;
export const MAX_REAL_GROUP_MEMBERS = 10;
export const REAL_CYCLE_DURATION_MS = 28 * 24 * 60 * 60 * 1000;

export type RealGroupInputError = 'name' | 'prompt' | 'maxMembers';

export function validateRealGroupInput(input: {
  name: unknown;
  prompt: unknown;
  maxMembers: unknown;
}): { name: string; prompt: string; maxMembers: number } | null {
  if (typeof input.name !== 'string' || typeof input.prompt !== 'string') return null;
  const name = input.name.trim();
  const prompt = input.prompt.trim();
  if (
    !name ||
    name.length > GROUP_NAME_MAX_LENGTH ||
    !prompt ||
    prompt.length > PROMPT_MAX_LENGTH
  ) {
    return null;
  }
  if (
    typeof input.maxMembers !== 'number' ||
    !Number.isSafeInteger(input.maxMembers) ||
    input.maxMembers < MIN_REAL_GROUP_MEMBERS ||
    input.maxMembers > MAX_REAL_GROUP_MEMBERS
  ) {
    return null;
  }
  return { name, prompt, maxMembers: input.maxMembers };
}

export function createRealGroup(
  database: RewindDatabase,
  account: { id: string; displayName: string },
  rawInput: { name: unknown; prompt: unknown; maxMembers: unknown },
  now = new Date(),
) {
  const input = validateRealGroupInput(rawInput);
  if (!input) return null;

  const startedAt = now.toISOString();
  const profileId = `real-profile-${randomUUID()}`;
  const groupId = `real-group-${randomUUID()}`;
  const cycleId = `real-cycle-${randomUUID()}`;
  const { endsAt } = createCycleWindow({ preset: 'four-week', startsAt: startedAt });

  database.exec('BEGIN IMMEDIATE');
  try {
    const existing = database
      .prepare('SELECT id FROM real_profiles WHERE account_id = ?')
      .get(account.id) as { id: string } | undefined;
    const actualProfileId = existing?.id ?? profileId;
    if (!existing) {
      database
        .prepare(
          'INSERT INTO real_profiles (id, account_id, display_name, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(profileId, account.id, account.displayName, startedAt);
    }

    database
      .prepare('INSERT INTO groups (id, name, current_cycle_id) VALUES (?, ?, NULL)')
      .run(groupId, input.name);
    database
      .prepare(
        `INSERT INTO real_group_metadata
          (group_id, owner_account_id, max_members, cycle_duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(groupId, account.id, input.maxMembers, REAL_CYCLE_DURATION_MS, startedAt);
    database
      .prepare(
        `INSERT INTO cycles
          (id, group_id, prompt, starts_at, ends_at, status, lock_state, max_count, max_seconds, count_used, seconds_used)
         VALUES (?, ?, ?, ?, ?, 'collecting', 'locked', 5, 30, 0, 0)`,
      )
      .run(cycleId, groupId, input.prompt, startedAt, endsAt);
    database.prepare('UPDATE groups SET current_cycle_id = ? WHERE id = ?').run(cycleId, groupId);
    database
      .prepare(
        `INSERT INTO real_group_memberships
          (group_id, account_id, profile_id, role, accepted_at)
         VALUES (?, ?, ?, 'owner', ?)`,
      )
      .run(groupId, account.id, actualProfileId, startedAt);
    database
      .prepare(
        `INSERT INTO real_account_group_selections (account_id, group_id) VALUES (?, ?)
         ON CONFLICT(account_id) DO UPDATE SET group_id = excluded.group_id`,
      )
      .run(account.id, groupId);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  return getCurrentRealGroup(database, account.id);
}

export function getRealGroup(database: RewindDatabase, accountId: string, groupId: string) {
  const row = database
    .prepare(
      `SELECT g.id AS groupId, g.name, g.current_cycle_id AS cycleId,
              member.role, metadata.max_members AS maxMembers, c.prompt,
              c.starts_at AS startsAt, c.ends_at AS endsAt,
              c.status, c.lock_state AS lockState,
              c.max_count AS maxCount, c.max_seconds AS maxSeconds,
              c.count_used AS countUsed, c.seconds_used AS secondsUsed,
              (SELECT COUNT(*) FROM contributions contribution
                WHERE contribution.cycle_id = c.id) AS contributionCount
       FROM real_group_memberships member
       JOIN real_group_metadata metadata ON metadata.group_id = member.group_id
       JOIN groups g ON g.id = member.group_id
       JOIN cycles c ON c.id = g.current_cycle_id AND c.group_id = g.id
       WHERE member.account_id = ? AND g.id = ?`,
    )
    .get(accountId, groupId) as Record<string, unknown> | undefined;
  return mapRealGroup(row);
}

function mapRealGroup(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  return {
    group: {
      id: String(row.groupId),
      name: String(row.name),
      role: String(row.role),
      maxMembers: Number(row.maxMembers),
    },
    cycle: {
      id: String(row.cycleId),
      groupId: String(row.groupId),
      prompt: String(row.prompt),
      startsAt: String(row.startsAt),
      endsAt: String(row.endsAt),
      status: String(row.status),
      lockState: String(row.lockState),
      quota: { maxCount: Number(row.maxCount), maxSeconds: Number(row.maxSeconds) },
      contributionUsage: { countUsed: Number(row.countUsed), secondsUsed: Number(row.secondsUsed) },
      contributionCount: Number(row.contributionCount),
    },
  };
}

export function getCurrentRealGroup(database: RewindDatabase, accountId: string) {
  const selection = database
    .prepare('SELECT group_id AS groupId FROM real_account_group_selections WHERE account_id = ?')
    .get(accountId) as { groupId?: string } | undefined;
  return selection?.groupId ? getRealGroup(database, accountId, selection.groupId) : null;
}

export function listRealGroups(database: RewindDatabase, accountId: string) {
  const memberships = database
    .prepare(
      `SELECT group_id AS groupId FROM real_group_memberships
       WHERE account_id = ? ORDER BY accepted_at, group_id`,
    )
    .all(accountId) as { groupId: string }[];
  return memberships
    .map(({ groupId }) => getRealGroup(database, accountId, groupId))
    .filter((group): group is NonNullable<typeof group> => group !== null);
}

export function selectRealGroup(database: RewindDatabase, accountId: string, groupId: string) {
  if (!getRealGroup(database, accountId, groupId)) return false;
  database
    .prepare(
      `INSERT INTO real_account_group_selections (account_id, group_id) VALUES (?, ?)
       ON CONFLICT(account_id) DO UPDATE SET group_id = excluded.group_id`,
    )
    .run(accountId, groupId);
  return true;
}

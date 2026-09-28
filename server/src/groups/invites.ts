import { randomBytes, randomUUID } from 'node:crypto';

import type { RewindDatabase } from '../db';
import { getRealGroup } from './real';

export const DEFAULT_REAL_INVITE_TTL_SECONDS = 24 * 60 * 60;
export const MIN_REAL_INVITE_TTL_SECONDS = 5 * 60;
export const MAX_REAL_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const REAL_INVITE_CODE_PATTERN = /^[A-Z0-9]{8}$/;

export interface RealGroupInvite {
  id: string;
  code: string;
  groupId: string;
  status: 'active';
  createdAt: string;
  expiresAt: string;
}

export type AcceptRealGroupInviteResult =
  | { ok: true; status: 'accepted'; group: NonNullable<ReturnType<typeof getRealGroup>> }
  | { ok: false; status: 'expired' | 'replayed' | 'malformed' | 'denied' | 'full' };

interface RealInviteRow {
  id: string;
  groupId: string;
  code: string;
  status: 'active' | 'accepted' | 'expired';
  expiresAt: string;
}

export type CreateRealGroupInviteResult =
  | { ok: true; invite: RealGroupInvite }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'invalid_expiry' };

function nextCode(database: RewindDatabase): string {
  for (;;) {
    const code = randomBytes(8)
      .toString('base64url')
      .replace(/[^A-Z0-9]/gi, '')
      .slice(0, 8)
      .toUpperCase();
    if (
      code.length === 8 &&
      !database.prepare('SELECT 1 FROM real_group_invites WHERE code = ?').get(code)
    ) {
      return code;
    }
  }
}

export function createRealGroupInvite(
  database: RewindDatabase,
  groupId: string,
  accountId: string,
  ttlSeconds = DEFAULT_REAL_INVITE_TTL_SECONDS,
  now = new Date(),
): CreateRealGroupInviteResult {
  const membership = database
    .prepare(
      `SELECT membership.role, metadata.owner_account_id AS ownerAccountId
       FROM real_group_memberships membership
       JOIN real_group_metadata metadata ON metadata.group_id = membership.group_id
       WHERE membership.group_id = ? AND membership.account_id = ?`,
    )
    .get(groupId, accountId) as { role: string; ownerAccountId: string } | undefined;
  if (!membership) return { ok: false, reason: 'not_found' };
  if (membership.role !== 'owner' || membership.ownerAccountId !== accountId) {
    return { ok: false, reason: 'forbidden' };
  }
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < MIN_REAL_INVITE_TTL_SECONDS ||
    ttlSeconds > MAX_REAL_INVITE_TTL_SECONDS
  ) {
    return { ok: false, reason: 'invalid_expiry' };
  }

  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    const code = nextCode(database);
    const id = `real-invite-${randomBytes(12).toString('hex')}`;
    database
      .prepare(
        `INSERT INTO real_group_invites
          (id, group_id, owner_account_id, code, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, groupId, accountId, code, createdAt, expiresAt);
    database.exec('COMMIT');
    return {
      ok: true,
      invite: { id, code, groupId, status: 'active', createdAt, expiresAt },
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function acceptRealGroupInvite(
  database: RewindDatabase,
  account: { id: string; displayName: string },
  rawCode: unknown,
  requestedGroupId?: unknown,
  now = new Date(),
): AcceptRealGroupInviteResult {
  if (typeof rawCode !== 'string') return { ok: false, status: 'malformed' };
  const code = rawCode.trim().toUpperCase();
  if (!REAL_INVITE_CODE_PATTERN.test(code)) return { ok: false, status: 'malformed' };

  database.exec('BEGIN IMMEDIATE');
  try {
    const invite = database
      .prepare(
        `SELECT id, group_id AS groupId, code, status, expires_at AS expiresAt
         FROM real_group_invites WHERE code = ?`,
      )
      .get(code) as RealInviteRow | undefined;
    if (!invite) {
      database.exec('ROLLBACK');
      return { ok: false, status: 'malformed' };
    }
    if (requestedGroupId !== undefined && requestedGroupId !== invite.groupId) {
      database.exec('ROLLBACK');
      return { ok: false, status: 'denied' };
    }
    if (invite.status === 'accepted' || invite.status === 'expired') {
      database.exec('ROLLBACK');
      return {
        ok: false,
        status: invite.status === 'accepted' ? 'replayed' : 'expired',
      };
    }
    if (Date.parse(invite.expiresAt) <= now.getTime()) {
      database
        .prepare("UPDATE real_group_invites SET status = 'expired' WHERE id = ?")
        .run(invite.id);
      database.exec('COMMIT');
      return { ok: false, status: 'expired' };
    }

    const group = database
      .prepare('SELECT max_members AS maxMembers FROM real_group_metadata WHERE group_id = ?')
      .get(invite.groupId) as { maxMembers: number } | undefined;
    if (!group) {
      database.exec('ROLLBACK');
      return { ok: false, status: 'denied' };
    }
    const existing = database
      .prepare('SELECT 1 FROM real_group_memberships WHERE group_id = ? AND account_id = ?')
      .get(invite.groupId, account.id);
    if (existing) {
      database.exec('ROLLBACK');
      return { ok: false, status: 'replayed' };
    }
    const count = database
      .prepare('SELECT COUNT(*) AS count FROM real_group_memberships WHERE group_id = ?')
      .get(invite.groupId) as { count: number };
    if (Number(count.count) >= Number(group.maxMembers)) {
      database.exec('ROLLBACK');
      return { ok: false, status: 'full' };
    }

    const acceptedAt = now.toISOString();
    let profile = database
      .prepare('SELECT id FROM real_profiles WHERE account_id = ?')
      .get(account.id) as { id: string } | undefined;
    if (!profile) {
      const profileId = `real-profile-${randomUUID()}`;
      database
        .prepare(
          'INSERT INTO real_profiles (id, account_id, display_name, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(profileId, account.id, account.displayName, acceptedAt);
      profile = { id: profileId };
    }
    database
      .prepare(
        `INSERT INTO real_group_memberships
          (group_id, account_id, profile_id, role, accepted_at)
         VALUES (?, ?, ?, 'member', ?)`,
      )
      .run(invite.groupId, account.id, profile.id, acceptedAt);
    database
      .prepare(
        `UPDATE real_group_invites
         SET status = 'accepted', accepted_by_account_id = ?, accepted_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(account.id, acceptedAt, invite.id);
    database
      .prepare(
        `INSERT INTO real_account_group_selections (account_id, group_id) VALUES (?, ?)
         ON CONFLICT(account_id) DO UPDATE SET group_id = excluded.group_id`,
      )
      .run(account.id, invite.groupId);
    const joinedGroup = getRealGroup(database, account.id, invite.groupId);
    if (!joinedGroup) throw new Error('Accepted real-group membership could not be loaded.');
    database.exec('COMMIT');
    return { ok: true, status: 'accepted', group: joinedGroup };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

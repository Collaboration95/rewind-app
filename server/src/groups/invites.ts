import { randomBytes } from 'node:crypto';

import type { RewindDatabase } from '../db';

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

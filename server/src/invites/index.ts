import { randomBytes } from 'node:crypto';

import { getGroup, isOwner } from '../db';
import type { RewindDatabase } from '../db';

export const DEFAULT_INVITE_TTL_SECONDS = 24 * 60 * 60;
export const MIN_INVITE_TTL_SECONDS = 5 * 60;
export const MAX_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const INVITE_CODE_PATTERN = /^[A-Z0-9]{8}$/;

export interface LocalInvite {
  id: string;
  code: string;
  groupId: string;
  status: 'active' | 'used' | 'expired';
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export type CreateInviteResult =
  | { ok: true; invite: LocalInvite }
  | { ok: false; reason: 'forbidden' | 'not_found' | 'invalid_expiry' };

export type AcceptInviteResult =
  | { ok: true; invite: LocalInvite; group: NonNullable<ReturnType<typeof getGroup>> }
  | {
      ok: false;
      reason: 'malformed' | 'not_found' | 'expired' | 'used' | 'cross_group' | 'already_member';
    };

interface InviteRow {
  id: string;
  code: string | null;
  groupId: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  usedAt: string | null;
}

function mapInvite(row: InviteRow, now = new Date()): LocalInvite {
  const expiresAt = row.expiresAt ?? new Date(Date.parse(row.createdAt) + DEFAULT_INVITE_TTL_SECONDS * 1000).toISOString();
  const status =
    row.status === 'used' || row.usedAt
      ? 'used'
      : Date.parse(expiresAt) <= now.getTime()
        ? 'expired'
        : 'active';
  return {
    id: row.id,
    code: row.code ?? '',
    groupId: row.groupId,
    status,
    createdAt: row.createdAt,
    expiresAt,
    usedAt: row.usedAt,
  };
}

function nextCode(database: RewindDatabase): string {
  for (;;) {
    const code = randomBytes(6).toString('base64url').replace(/[^A-Z0-9]/gi, '').slice(0, 8).toUpperCase();
    if (code.length === 8 && !database.prepare('SELECT 1 FROM invites WHERE code = ?').get(code)) {
      return code;
    }
  }
}

function inviteId(code: string): string {
  return `invite-${code.toLowerCase()}`;
}

export function createInvite(
  database: RewindDatabase,
  actorMemberId: string,
  groupId: string,
  ttlSeconds = DEFAULT_INVITE_TTL_SECONDS,
  now = new Date(),
): CreateInviteResult {
  if (!getGroup(database, groupId) || !isOwner(database, groupId, actorMemberId)) {
    return { ok: false, reason: 'forbidden' };
  }
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < MIN_INVITE_TTL_SECONDS ||
    ttlSeconds > MAX_INVITE_TTL_SECONDS
  ) {
    return { ok: false, reason: 'invalid_expiry' };
  }
  const code = nextCode(database);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  database
    .prepare(
      `INSERT INTO invites (id, group_id, status, created_at, code, expires_at)
       VALUES (?, ?, 'active', ?, ?, ?)`,
    )
    .run(inviteId(code), groupId, createdAt, code, expiresAt);
  return {
    ok: true,
    invite: {
      id: inviteId(code),
      code,
      groupId,
      status: 'active',
      createdAt,
      expiresAt,
      usedAt: null,
    },
  };
}

export function acceptInvite(
  database: RewindDatabase,
  actorMemberId: string,
  rawCode: string,
  requestedGroupId?: string,
  now = new Date(),
): AcceptInviteResult {
  const code = rawCode.trim().toUpperCase();
  if (!INVITE_CODE_PATTERN.test(code)) return { ok: false, reason: 'malformed' };
  const row = database
    .prepare(
      `SELECT id, code, group_id AS groupId, status, created_at AS createdAt,
              expires_at AS expiresAt, used_at AS usedAt
       FROM invites WHERE code = ?`,
    )
    .get(code) as InviteRow | undefined;
  if (!row) return { ok: false, reason: 'not_found' };
  if (requestedGroupId && requestedGroupId !== row.groupId) {
    return { ok: false, reason: 'cross_group' };
  }
  const invite = mapInvite(row, now);
  if (invite.status === 'expired') {
    database.prepare("UPDATE invites SET status = 'expired' WHERE id = ?").run(invite.id);
    return { ok: false, reason: 'expired' };
  }
  if (invite.status === 'used') return { ok: false, reason: 'used' };
  if (
    database
      .prepare('SELECT 1 FROM memberships WHERE group_id = ? AND member_id = ?')
      .get(invite.groupId, actorMemberId)
  ) {
    return { ok: false, reason: 'already_member' };
  }

  database.exec('BEGIN');
  try {
    database
      .prepare(
        `INSERT INTO memberships (group_id, member_id, role, accepted_at)
         VALUES (?, ?, 'member', ?)`,
      )
      .run(invite.groupId, actorMemberId, now.toISOString());
    database
      .prepare("UPDATE invites SET status = 'used', invitee_member_id = ?, used_at = ? WHERE id = ?")
      .run(actorMemberId, now.toISOString(), invite.id);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return {
    ok: true,
    invite: { ...invite, status: 'used', usedAt: now.toISOString() },
    group: getGroup(database, invite.groupId, actorMemberId)!,
  };
}

import { randomUUID } from 'node:crypto';

import { recordAuditEvent } from '../audit';
import type { RewindDatabase } from '../db';
import {
  classifyDemoSession,
  DEMO_ACCESS_KIND,
  DEMO_SESSION_LIFETIME_MS,
  demoSessionExpiry,
  type DemoSession,
} from './contract';

export type SessionValidation =
  | { status: 'valid'; session: DemoSession }
  | { status: 'invalid'; reason: 'missing' | 'not_demo'; sessionId: string }
  | { status: 'expired'; reason: 'expired'; session: DemoSession }
  | { status: 'invalidated'; reason: 'invalidated'; session: DemoSession };

export interface CreateDemoSessionInput {
  memberId: string;
  groupId?: string;
  now?: Date;
  sessionId?: string;
}

export type CreateDemoSessionResult =
  | { ok: true; session: DemoSession }
  | { ok: false; reason: 'unknown_member' | 'membership_denied' };

export type InvalidateDemoSessionResult =
  | { ok: true; session: DemoSession }
  | { ok: false; reason: 'missing' | 'already_invalidated'; session?: DemoSession };

export type UpdateDemoSessionGroupResult =
  | { ok: true; session: DemoSession }
  | { ok: false; reason: 'missing' | 'inactive' | 'membership_denied' };

type SessionRow = Record<string, unknown>;

function sessionResourceId(sessionId: string): string {
  return `session:${sessionId}`;
}

function mapSession(row: SessionRow): DemoSession {
  return {
    id: String(row.id),
    accessKind: DEMO_ACCESS_KIND,
    actor: {
      memberId: String(row.memberId),
      displayName: String(row.displayName),
      isSynthetic: true,
    },
    groupId: String(row.groupId),
    startedAt: String(row.startedAt),
    expiresAt: String(row.expiresAt),
    invalidatedAt: row.invalidatedAt ? String(row.invalidatedAt) : null,
  };
}

export function getDemoSession(database: RewindDatabase, sessionId: string): DemoSession | null {
  const row = database
    .prepare(
      `SELECT s.id, s.member_id AS memberId, s.group_id AS groupId,
        s.started_at AS startedAt, s.expires_at AS expiresAt,
        s.invalidated_at AS invalidatedAt, s.access_kind AS accessKind,
        p.display_name AS displayName, p.is_synthetic AS isSynthetic
       FROM sessions s JOIN profiles p ON p.id = s.member_id
       WHERE s.id = ?`,
    )
    .get(sessionId) as SessionRow | undefined;
  if (!row || row.accessKind !== DEMO_ACCESS_KIND || Number(row.isSynthetic) !== 1) return null;
  return mapSession(row);
}

function memberGroup(database: RewindDatabase, memberId: string, groupId?: string): string | null {
  const row = database
    .prepare(
      `SELECT group_id AS groupId FROM memberships
       WHERE member_id = ? AND (? IS NULL OR group_id = ?)
       ORDER BY group_id LIMIT 1`,
    )
    .get(memberId, groupId ?? null, groupId ?? null) as { groupId?: string } | undefined;
  return row?.groupId ? String(row.groupId) : null;
}

export function createDemoSession(
  database: RewindDatabase,
  input: CreateDemoSessionInput,
): CreateDemoSessionResult {
  const profile = database
    .prepare('SELECT id, is_synthetic AS isSynthetic FROM profiles WHERE id = ?')
    .get(input.memberId) as { id?: string; isSynthetic?: number } | undefined;
  if (!profile || Number(profile.isSynthetic) !== 1) {
    return { ok: false, reason: 'unknown_member' };
  }
  const groupId = memberGroup(database, input.memberId, input.groupId);
  if (!groupId) return { ok: false, reason: 'membership_denied' };
  const startedAt = (input.now ?? new Date()).toISOString();
  const expiresAt = demoSessionExpiry(startedAt, DEMO_SESSION_LIFETIME_MS);
  const sessionId = input.sessionId ?? `demo-session-${randomUUID()}`;
  database
    .prepare(
      `INSERT INTO sessions
        (id, member_id, group_id, started_at, last_seen_at, access_kind, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionId, input.memberId, groupId, startedAt, startedAt, DEMO_ACCESS_KIND, expiresAt);
  const session = getDemoSession(database, sessionId);
  if (!session) throw new Error('The created demo session could not be loaded.');
  recordAuditEvent(database, {
    eventType: 'session.created',
    actorMemberId: session.actor.memberId,
    resourceId: sessionResourceId(session.id),
    timestamp: startedAt,
    result: 'success',
  });
  return { ok: true, session };
}

export function validateDemoSession(
  database: RewindDatabase,
  sessionId: string,
  now = new Date(),
): SessionValidation {
  const session = getDemoSession(database, sessionId);
  const resourceId = sessionResourceId(sessionId);
  if (!session) {
    recordAuditEvent(database, {
      eventType: 'session.rejected',
      resourceId,
      result: 'denied',
    });
    return { status: 'invalid', reason: 'missing', sessionId };
  }
  const lifecycle = classifyDemoSession(session.expiresAt, session.invalidatedAt, now);
  if (lifecycle === 'invalidated') {
    recordAuditEvent(database, {
      eventType: 'session.rejected',
      actorMemberId: session.actor.memberId,
      resourceId,
      timestamp: now.toISOString(),
      result: 'denied',
    });
    return { status: 'invalidated', reason: 'invalidated', session };
  }
  if (lifecycle === 'expired') {
    recordAuditEvent(database, {
      eventType: 'session.expired',
      actorMemberId: session.actor.memberId,
      resourceId,
      timestamp: now.toISOString(),
      result: 'denied',
    });
    return { status: 'expired', reason: 'expired', session };
  }
  database
    .prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
    .run(now.toISOString(), session.id);
  recordAuditEvent(database, {
    eventType: 'session.validated',
    actorMemberId: session.actor.memberId,
    resourceId,
    timestamp: now.toISOString(),
    result: 'success',
  });
  return { status: 'valid', session: { ...session } };
}

export function invalidateDemoSession(
  database: RewindDatabase,
  sessionId: string,
  now = new Date(),
): InvalidateDemoSessionResult {
  const session = getDemoSession(database, sessionId);
  if (!session) {
    recordAuditEvent(database, {
      eventType: 'session.rejected',
      resourceId: sessionResourceId(sessionId),
      timestamp: now.toISOString(),
      result: 'denied',
    });
    return { ok: false, reason: 'missing' };
  }
  if (session.invalidatedAt) return { ok: false, reason: 'already_invalidated', session };
  const invalidatedAt = now.toISOString();
  database
    .prepare('UPDATE sessions SET invalidated_at = ? WHERE id = ?')
    .run(invalidatedAt, sessionId);
  const invalidated = getDemoSession(database, sessionId);
  if (!invalidated) throw new Error('The invalidated demo session could not be loaded.');
  recordAuditEvent(database, {
    eventType: 'session.invalidated',
    actorMemberId: invalidated.actor.memberId,
    resourceId: sessionResourceId(sessionId),
    timestamp: invalidatedAt,
    result: 'success',
  });
  return { ok: true, session: invalidated };
}

export function updateDemoSessionGroup(
  database: RewindDatabase,
  sessionId: string,
  groupId: string,
): UpdateDemoSessionGroupResult {
  const session = getDemoSession(database, sessionId);
  if (!session) return { ok: false, reason: 'missing' };
  if (session.invalidatedAt || classifyDemoSession(session.expiresAt, null) !== 'valid') {
    return { ok: false, reason: 'inactive' };
  }
  if (
    !database
      .prepare('SELECT 1 FROM memberships WHERE group_id = ? AND member_id = ?')
      .get(groupId, session.actor.memberId)
  ) {
    return { ok: false, reason: 'membership_denied' };
  }
  database.prepare('UPDATE sessions SET group_id = ? WHERE id = ?').run(groupId, sessionId);
  const updated = getDemoSession(database, sessionId);
  if (!updated) throw new Error('The updated demo session could not be loaded.');
  return { ok: true, session: updated };
}

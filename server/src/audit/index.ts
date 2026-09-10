import { randomUUID } from 'node:crypto';

import type { RewindDatabase } from '../db';

export const AUDIT_EVENT_TYPES = [
  'session.created',
  'session.validated',
  'session.rejected',
  'session.expired',
  'session.invalidated',
  'job.started',
  'job.completed',
  'job.failed',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
export type AuditResult = 'success' | 'failure' | 'denied';

export interface AuditEvent {
  id: string;
  eventType: AuditEventType;
  actorMemberId: string | null;
  resourceId: string | null;
  timestamp: string;
  result: AuditResult;
}

export interface AuditEventInput {
  eventType: AuditEventType;
  actorMemberId?: string | null;
  resourceId?: string | null;
  timestamp?: string;
  result: AuditResult;
}

const SAFE_ACTOR_ID = /^demo-[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_RESOURCE_ID =
  /^(?:session|job|group|cycle|profile|message|contribution|clip|film|download):[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isAuditEventType(value: string): value is AuditEventType {
  return (AUDIT_EVENT_TYPES as readonly string[]).includes(value);
}

function isAuditResult(value: string): value is AuditResult {
  return value === 'success' || value === 'failure' || value === 'denied';
}

/**
 * Return only identifiers from the allowlisted local namespaces. Arbitrary
 * text (including paths, invite codes, and message content) becomes null.
 */
export function safeAuditIdentifier(
  value: string | null | undefined,
  kind: 'actor' | 'resource',
): string | null {
  if (!value || typeof value !== 'string') return null;
  const candidate = value.trim();
  if (kind === 'actor') return SAFE_ACTOR_ID.test(candidate) ? candidate : null;
  return SAFE_RESOURCE_ID.test(candidate) ? candidate : null;
}

function toAuditEvent(row: Record<string, unknown>): AuditEvent {
  const eventType = String(row.eventType);
  const result = String(row.result);
  if (!isAuditEventType(eventType) || !isAuditResult(result)) {
    throw new Error('The local audit store contains an unsupported event.');
  }
  return {
    id: String(row.id),
    eventType,
    actorMemberId: row.actorMemberId ? String(row.actorMemberId) : null,
    resourceId: row.resourceId ? String(row.resourceId) : null,
    timestamp: String(row.timestamp),
    result,
  };
}

export function recordAuditEvent(database: RewindDatabase, input: AuditEventInput): AuditEvent {
  if (!isAuditEventType(input.eventType)) {
    throw new TypeError(`Unsupported audit event type: ${String(input.eventType)}.`);
  }
  if (!isAuditResult(input.result)) {
    throw new TypeError(`Unsupported audit result: ${String(input.result)}.`);
  }
  const timestamp = input.timestamp ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new RangeError('Audit event timestamp must be an ISO-8601 instant.');
  }
  const candidateActorId = safeAuditIdentifier(input.actorMemberId, 'actor');
  const actorMemberId = candidateActorId
    ? ((
        database
          .prepare('SELECT id FROM profiles WHERE id = ? AND is_synthetic = 1')
          .get(candidateActorId) as { id?: string } | undefined
      )?.id ?? null)
    : null;
  const event: AuditEvent = {
    id: `audit-${randomUUID()}`,
    eventType: input.eventType,
    actorMemberId,
    resourceId: safeAuditIdentifier(input.resourceId, 'resource'),
    timestamp: new Date(timestamp).toISOString(),
    result: input.result,
  };
  database
    .prepare(
      `INSERT INTO audit_events
        (id, event_type, actor_member_id, resource_id, occurred_at, result)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.id,
      event.eventType,
      event.actorMemberId,
      event.resourceId,
      event.timestamp,
      event.result,
    );
  return event;
}

export function listAuditEvents(database: RewindDatabase, limit = 100): AuditEvent[] {
  const boundedLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 500) : 100;
  return database
    .prepare(
      `SELECT id, event_type AS eventType, actor_member_id AS actorMemberId,
        resource_id AS resourceId, occurred_at AS timestamp, result
       FROM audit_events
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`,
    )
    .all(boundedLimit)
    .map((row) => toAuditEvent(row as Record<string, unknown>));
}

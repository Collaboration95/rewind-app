import { randomUUID } from 'node:crypto';

import { isMember, type RewindDatabase } from '../db';

export const CHAT_MESSAGE_MAX_LENGTH = 2_000;

export interface ChatMessage {
  id: string;
  groupId: string;
  memberId: string;
  body: string;
  createdAt: string;
}

export interface ChatMessageEvent {
  eventId: number;
  type: 'message';
  message: ChatMessage;
  occurredAt: string;
}

export interface CreateChatMessageInput {
  groupId: string;
  memberId: string;
  body: string;
  now?: Date;
  messageId?: string;
}

export type CreateChatMessageResult =
  | { ok: true; event: ChatMessageEvent }
  | {
      ok: false;
      reason: 'membership_denied' | 'empty_body' | 'body_too_long' | 'invalid_timestamp';
    };

function mapMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: String(row.id),
    groupId: String(row.groupId),
    memberId: String(row.memberId),
    body: String(row.body),
    createdAt: String(row.createdAt),
  };
}

function mapEvent(row: Record<string, unknown>): ChatMessageEvent {
  return {
    eventId: Number(row.eventId),
    type: 'message',
    message: mapMessage(row),
    occurredAt: String(row.occurredAt),
  };
}

/**
 * Read the append-only message event log. The event id is deliberately a
 * SQLite integer so clients can reconnect with Last-Event-ID after a restart.
 */
export function listChatEvents(
  database: RewindDatabase,
  groupId: string,
  sinceEventId = 0,
  limit = 100,
): ChatMessageEvent[] {
  const boundedSince = Number.isInteger(sinceEventId) && sinceEventId >= 0 ? sinceEventId : 0;
  const boundedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  return database
    .prepare(
      `SELECT e.id AS eventId, e.occurred_at AS occurredAt,
        m.id, m.group_id AS groupId, m.member_id AS memberId,
        m.body, m.created_at AS createdAt
       FROM realtime_events e
       JOIN messages m ON m.id = e.message_id
       WHERE e.group_id = ? AND e.id > ?
       ORDER BY e.id ASC
       LIMIT ?`,
    )
    .all(groupId, boundedSince, boundedLimit)
    .map((row) => mapEvent(row as Record<string, unknown>));
}

export function createChatMessage(
  database: RewindDatabase,
  input: CreateChatMessageInput,
): CreateChatMessageResult {
  if (!isMember(database, input.groupId, input.memberId)) {
    return { ok: false, reason: 'membership_denied' };
  }
  if (typeof input.body !== 'string' || !input.body.trim()) {
    return { ok: false, reason: 'empty_body' };
  }
  const body = input.body.trim();
  if (body.length > CHAT_MESSAGE_MAX_LENGTH) {
    return { ok: false, reason: 'body_too_long' };
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return { ok: false, reason: 'invalid_timestamp' };
  const occurredAt = now.toISOString();
  const messageId = input.messageId ?? `message-${randomUUID()}`;

  database.exec('BEGIN IMMEDIATE');
  try {
    // Re-check inside the write transaction. The HTTP body is read before
    // this function is called, so membership may have changed since the
    // request-level guard ran.
    if (!isMember(database, input.groupId, input.memberId)) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'membership_denied' };
    }
    database
      .prepare(
        `INSERT INTO messages (id, group_id, member_id, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(messageId, input.groupId, input.memberId, body, occurredAt);
    database
      .prepare(
        `INSERT INTO realtime_events (group_id, message_id, event_type, occurred_at)
         VALUES (?, ?, 'message', ?)`,
      )
      .run(input.groupId, messageId, occurredAt);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  const row = database
    .prepare(
      `SELECT e.id AS eventId, e.occurred_at AS occurredAt,
        m.id, m.group_id AS groupId, m.member_id AS memberId,
        m.body, m.created_at AS createdAt
       FROM realtime_events e
       JOIN messages m ON m.id = e.message_id
       WHERE e.message_id = ?`,
    )
    .get(messageId) as Record<string, unknown> | undefined;
  if (!row) throw new Error('Persisted chat message event could not be loaded.');
  return { ok: true, event: mapEvent(row) };
}

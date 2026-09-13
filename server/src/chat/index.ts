import { randomUUID } from 'node:crypto';

import { isMember, type RewindDatabase } from '../db';
import { getDemoSession } from '../session';
import { classifyDemoSession } from '../session/contract';

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
  /** The session that established the HTTP authorization context. */
  sessionId?: string;
  body: string;
  /** A fixed timestamp for tests, or a clock evaluated inside the transaction. */
  now?: Date | (() => Date);
  messageId?: string;
}

export type CreateChatMessageResult =
  | { ok: true; event: ChatMessageEvent; deduplicated?: boolean }
  | {
      ok: false;
      reason:
        | 'membership_denied'
        | 'empty_body'
        | 'body_too_long'
        | 'invalid_timestamp'
        | 'duplicate_message';
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
  if (input.now instanceof Date && !Number.isFinite(input.now.getTime())) {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  const messageId = input.messageId ?? `message-${randomUUID()}`;

  database.exec('BEGIN IMMEDIATE');
  try {
    // Re-check the complete authorization context immediately before either
    // insert. Reading the body happens before this function is called, so a
    // session can have been invalidated while a client was still uploading it.
    // BEGIN IMMEDIATE makes this check and the inserts one serialized write.
    const currentSession = input.sessionId ? getDemoSession(database, input.sessionId) : null;
    const transactionNow =
      typeof input.now === 'function' ? input.now() : (input.now ?? new Date());
    if (!Number.isFinite(transactionNow.getTime())) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'invalid_timestamp' };
    }
    const occurredAt = transactionNow.toISOString();
    const sessionIsCurrent =
      !input.sessionId ||
      Boolean(
        currentSession &&
        currentSession.actor.memberId === input.memberId &&
        classifyDemoSession(
          currentSession.expiresAt,
          currentSession.invalidatedAt,
          transactionNow,
        ) === 'valid',
      );
    if (!sessionIsCurrent || !isMember(database, input.groupId, input.memberId)) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'membership_denied' };
    }

    // A client may have persisted the message but lost the HTTP response. A
    // retry with the same client-generated id must return that event instead
    // of inserting another message (or publishing the same event twice).
    const existing = database
      .prepare(
        `SELECT m.id, m.group_id AS groupId, m.member_id AS memberId,
          m.body, m.created_at AS createdAt,
          e.id AS eventId, e.occurred_at AS occurredAt
         FROM messages m
         LEFT JOIN realtime_events e ON e.message_id = m.id
         WHERE m.id = ?`,
      )
      .get(messageId) as Record<string, unknown> | undefined;
    if (existing) {
      const sameRequest =
        String(existing.groupId) === input.groupId &&
        String(existing.memberId) === input.memberId &&
        String(existing.body) === body;
      if (!sameRequest || existing.eventId === null || existing.eventId === undefined) {
        database.exec('ROLLBACK');
        return { ok: false, reason: 'duplicate_message' };
      }
      database.exec('COMMIT');
      return {
        ok: true,
        deduplicated: true,
        event: mapEvent(existing),
      };
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

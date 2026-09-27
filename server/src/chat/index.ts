import { randomUUID } from 'node:crypto';

import { isMember, type RewindDatabase } from '../db';
import { getDemoSession } from '../session';
import { classifyDemoSession } from '../session/contract';

export const CHAT_MESSAGE_MAX_LENGTH = 2_000;
export const SUPPORTED_CHAT_REACTION = '✨' as const;
export const SUPPORTED_CHAT_REACTIONS = [SUPPORTED_CHAT_REACTION] as const;
export type ChatReactionEmoji = (typeof SUPPORTED_CHAT_REACTIONS)[number];

export interface ChatReplyContext {
  id: string;
  memberId: string;
  body: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  groupId: string;
  memberId: string;
  body: string;
  createdAt: string;
  replyTo?: ChatReplyContext | null;
  reactionCounts?: Partial<Record<ChatReactionEmoji, number>>;
}

export interface ChatMessageEvent {
  eventId: number;
  type: 'message';
  message: ChatMessage;
  occurredAt: string;
}

export interface ChatEventMetadata {
  eventId: number;
  type: 'message';
  message: Pick<ChatMessage, 'groupId' | 'memberId'>;
  occurredAt: string;
}

export interface ChatHistoryPage {
  events: ChatMessageEvent[];
  /** Event id to use as the exclusive upper bound for the next older page. */
  nextCursor: number | null;
  watermarkEventId: number;
  hasMore: boolean;
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
  replyToMessageId?: string;
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
        | 'duplicate_message'
        | 'reply_not_found'
        | 'nested_reply_not_allowed';
    };

export interface ToggleChatReactionInput {
  groupId: string;
  memberId: string;
  sessionId?: string;
  messageId: string;
  emoji: string;
  active?: boolean;
  now?: Date | (() => Date);
}

export type ToggleChatReactionResult =
  | {
      ok: true;
      reaction: {
        messageId: string;
        groupId: string;
        memberId: string;
        emoji: ChatReactionEmoji;
        active: boolean;
        count: number;
      };
      message: ChatMessage;
    }
  | {
      ok: false;
      reason:
        'membership_denied' | 'message_not_found' | 'unsupported_reaction' | 'invalid_timestamp';
    };

function reactionCounts(database: RewindDatabase, messageId: string) {
  const rows = database
    .prepare('SELECT emoji, COUNT(*) AS count FROM reactions WHERE message_id = ? GROUP BY emoji')
    .all(messageId) as { emoji?: unknown; count?: unknown }[];
  const result: Partial<Record<ChatReactionEmoji, number>> = {};
  for (const row of rows) {
    if (row.emoji === SUPPORTED_CHAT_REACTION) result[SUPPORTED_CHAT_REACTION] = Number(row.count);
  }
  return result;
}

function mapMessage(
  row: Record<string, unknown>,
  counts: Partial<Record<ChatReactionEmoji, number>> = {},
): ChatMessage {
  const replyTo = row.replyToId
    ? {
        id: String(row.replyToId),
        memberId: String(row.replyToMemberId),
        body: String(row.replyToBody),
        createdAt: String(row.replyToCreatedAt),
      }
    : null;
  return {
    id: String(row.id),
    groupId: String(row.groupId),
    memberId: String(row.memberId),
    body: String(row.body),
    createdAt: String(row.createdAt),
    replyTo,
    reactionCounts: counts,
  };
}

function mapEvent(
  row: Record<string, unknown>,
  counts: Partial<Record<ChatReactionEmoji, number>> = {},
): ChatMessageEvent {
  return {
    eventId: Number(row.eventId),
    type: 'message',
    message: mapMessage(row, counts),
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
  const rows = database
    .prepare(
      `SELECT e.id AS eventId, e.occurred_at AS occurredAt,
        m.id, m.group_id AS groupId, m.member_id AS memberId,
        m.body, m.created_at AS createdAt,
        parent.id AS replyToId, parent.member_id AS replyToMemberId,
        parent.body AS replyToBody, parent.created_at AS replyToCreatedAt
       FROM realtime_events e
       JOIN messages m ON m.id = e.message_id
       LEFT JOIN messages parent ON parent.id = m.reply_to_message_id
       WHERE e.group_id = ? AND e.id > ?
       ORDER BY e.id ASC
       LIMIT ?`,
    )
    .all(groupId, boundedSince, boundedLimit) as Record<string, unknown>[];
  return mapChatRowsWithReactionCounts(database, rows);
}

function mapChatRowsWithReactionCounts(
  database: RewindDatabase,
  rows: Record<string, unknown>[],
): ChatMessageEvent[] {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => String(row.id));
  const placeholders = ids.map(() => '?').join(', ');
  const reactions = database
    .prepare(
      `SELECT message_id AS messageId, emoji, COUNT(*) AS count
       FROM reactions WHERE message_id IN (${placeholders}) GROUP BY message_id, emoji`,
    )
    .all(...ids) as { messageId?: unknown; emoji?: unknown; count?: unknown }[];
  const countsByMessage = new Map<string, Partial<Record<ChatReactionEmoji, number>>>();
  for (const reaction of reactions) {
    if (reaction.emoji !== SUPPORTED_CHAT_REACTION) continue;
    const counts = countsByMessage.get(String(reaction.messageId)) ?? {};
    counts[SUPPORTED_CHAT_REACTION] = Number(reaction.count);
    countsByMessage.set(String(reaction.messageId), counts);
  }
  return rows.map((row) => mapEvent(row, countsByMessage.get(String(row.id)) ?? {}));
}

/** Read a bounded latest/older page without discarding any older history. */
export function listChatHistoryPage(
  database: RewindDatabase,
  groupId: string,
  options: { beforeEventId?: number; limit?: number } = {},
): ChatHistoryPage {
  const requestedLimit = options.limit ?? 100;
  const limit =
    Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 100;
  const watermarkEventId = latestChatEventId(database, groupId);
  const beforeEventId =
    Number.isInteger(options.beforeEventId) && options.beforeEventId! > 0
      ? Math.min(options.beforeEventId!, watermarkEventId + 1)
      : watermarkEventId + 1;
  const rows = database
    .prepare(
      `SELECT e.id AS eventId, e.occurred_at AS occurredAt,
        m.id, m.group_id AS groupId, m.member_id AS memberId,
        m.body, m.created_at AS createdAt,
        parent.id AS replyToId, parent.member_id AS replyToMemberId,
        parent.body AS replyToBody, parent.created_at AS replyToCreatedAt
       FROM realtime_events e
       JOIN messages m ON m.id = e.message_id
       LEFT JOIN messages parent ON parent.id = m.reply_to_message_id
       WHERE e.group_id = ? AND e.id < ? AND e.id <= ?
       ORDER BY e.id DESC
       LIMIT ?`,
    )
    .all(groupId, beforeEventId, watermarkEventId, limit + 1) as Record<string, unknown>[];
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit).reverse();
  const events = mapChatRowsWithReactionCounts(database, pageRows);
  return {
    events,
    nextCursor: hasMore && events.length > 0 ? events[0].eventId : null,
    watermarkEventId,
    hasMore,
  };
}

/** Metadata replay for unread observers; this query never loads message or reply bodies. */
export function listChatEventMetadata(
  database: RewindDatabase,
  groupId: string,
  sinceEventId = 0,
  limit = 100,
): ChatEventMetadata[] {
  const boundedSince = Number.isInteger(sinceEventId) && sinceEventId >= 0 ? sinceEventId : 0;
  const boundedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  return database
    .prepare(
      `SELECT e.id AS eventId, e.group_id AS groupId, m.member_id AS memberId,
              e.occurred_at AS occurredAt
       FROM realtime_events e JOIN messages m ON m.id = e.message_id
       WHERE e.group_id = ? AND e.id > ?
       ORDER BY e.id ASC LIMIT ?`,
    )
    .all(groupId, boundedSince, boundedLimit)
    .map((row) => {
      const record = row as Record<string, unknown>;
      return {
        eventId: Number(record.eventId),
        type: 'message' as const,
        message: { groupId: String(record.groupId), memberId: String(record.memberId) },
        occurredAt: String(record.occurredAt),
      };
    });
}

/** Current group event watermark for a new live observer that should not count history. */
export function latestChatEventId(database: RewindDatabase, groupId: string): number {
  const row = database
    .prepare('SELECT COALESCE(MAX(id), 0) AS eventId FROM realtime_events WHERE group_id = ?')
    .get(groupId) as { eventId: number };
  return Number(row.eventId);
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
    // retry with the same client-generated id must return that event rather
    // than inserting another message or publishing it twice.
    const existing = database
      .prepare(
        `SELECT m.id, m.group_id AS groupId, m.member_id AS memberId,
          m.body, m.created_at AS createdAt,
          e.id AS eventId, e.occurred_at AS occurredAt,
          parent.id AS replyToId, parent.member_id AS replyToMemberId,
          parent.body AS replyToBody, parent.created_at AS replyToCreatedAt
         FROM messages m
         LEFT JOIN realtime_events e ON e.message_id = m.id
         LEFT JOIN messages parent ON parent.id = m.reply_to_message_id
         WHERE m.id = ?`,
      )
      .get(messageId) as Record<string, unknown> | undefined;
    if (existing) {
      const sameRequest =
        String(existing.groupId) === input.groupId &&
        String(existing.memberId) === input.memberId &&
        String(existing.body) === body &&
        (input.replyToMessageId ?? null) === (existing.replyToId ?? null);
      if (!sameRequest || existing.eventId === null || existing.eventId === undefined) {
        database.exec('ROLLBACK');
        return { ok: false, reason: 'duplicate_message' };
      }
      database.exec('COMMIT');
      return {
        ok: true,
        deduplicated: true,
        event: mapEvent(existing, reactionCounts(database, String(existing.id))),
      };
    }
    if (input.replyToMessageId) {
      const parent = database
        .prepare(
          `SELECT reply_to_message_id AS replyToMessageId
           FROM messages WHERE id = ? AND group_id = ?`,
        )
        .get(input.replyToMessageId, input.groupId) as
        { replyToMessageId?: string | null } | undefined;
      if (!parent) {
        database.exec('ROLLBACK');
        return { ok: false, reason: 'reply_not_found' };
      }
      if (parent.replyToMessageId) {
        database.exec('ROLLBACK');
        return { ok: false, reason: 'nested_reply_not_allowed' };
      }
    }
    database
      .prepare(
        `INSERT INTO messages (id, group_id, member_id, body, created_at, reply_to_message_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        messageId,
        input.groupId,
        input.memberId,
        body,
        occurredAt,
        input.replyToMessageId ?? null,
      );
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
        m.body, m.created_at AS createdAt,
        parent.id AS replyToId, parent.member_id AS replyToMemberId,
        parent.body AS replyToBody, parent.created_at AS replyToCreatedAt
       FROM realtime_events e
       JOIN messages m ON m.id = e.message_id
       LEFT JOIN messages parent ON parent.id = m.reply_to_message_id
       WHERE e.message_id = ?`,
    )
    .get(messageId) as Record<string, unknown> | undefined;
  if (!row) throw new Error('Persisted chat message event could not be loaded.');
  return { ok: true, event: mapEvent(row, reactionCounts(database, String(row.id))) };
}

function validReaction(emoji: string): emoji is ChatReactionEmoji {
  return (SUPPORTED_CHAT_REACTIONS as readonly string[]).includes(emoji);
}

export function toggleChatReaction(
  database: RewindDatabase,
  input: ToggleChatReactionInput,
): ToggleChatReactionResult {
  // Keep direct callers on the same group-scoped denial contract as HTTP
  // callers; do not reveal reaction policy to a non-member.
  if (!isMember(database, input.groupId, input.memberId)) {
    return { ok: false, reason: 'membership_denied' };
  }
  if (!validReaction(input.emoji)) return { ok: false, reason: 'unsupported_reaction' };
  if (input.now instanceof Date && !Number.isFinite(input.now.getTime())) {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    const transactionNow =
      typeof input.now === 'function' ? input.now() : (input.now ?? new Date());
    if (!Number.isFinite(transactionNow.getTime())) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'invalid_timestamp' };
    }
    const currentSession = input.sessionId ? getDemoSession(database, input.sessionId) : null;
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
    const message = database
      .prepare('SELECT id FROM messages WHERE id = ? AND group_id = ?')
      .get(input.messageId, input.groupId);
    if (!message) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'message_not_found' };
    }
    const existing = database
      .prepare(
        'SELECT 1 AS present FROM reactions WHERE message_id = ? AND member_id = ? AND emoji = ?',
      )
      .get(input.messageId, input.memberId, input.emoji) as { present?: number } | undefined;
    const active = input.active ?? existing?.present !== 1;
    if (active) {
      database
        .prepare(
          `INSERT OR IGNORE INTO reactions (id, message_id, member_id, emoji, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          `reaction-${input.messageId}-${input.memberId}-${input.emoji}`,
          input.messageId,
          input.memberId,
          input.emoji,
          transactionNow.toISOString(),
        );
    } else {
      database
        .prepare('DELETE FROM reactions WHERE message_id = ? AND member_id = ? AND emoji = ?')
        .run(input.messageId, input.memberId, input.emoji);
    }
    const count = Number(
      (
        database
          .prepare('SELECT COUNT(*) AS count FROM reactions WHERE message_id = ? AND emoji = ?')
          .get(input.messageId, input.emoji) as { count?: number }
      )?.count ?? 0,
    );
    database.exec('COMMIT');
    const row = database
      .prepare(
        `SELECT m.id, m.group_id AS groupId, m.member_id AS memberId,
           m.body, m.created_at AS createdAt,
           parent.id AS replyToId, parent.member_id AS replyToMemberId,
           parent.body AS replyToBody, parent.created_at AS replyToCreatedAt
         FROM messages m LEFT JOIN messages parent ON parent.id = m.reply_to_message_id
         WHERE m.id = ? AND m.group_id = ?`,
      )
      .get(input.messageId, input.groupId) as Record<string, unknown>;
    return {
      ok: true,
      reaction: {
        messageId: input.messageId,
        groupId: input.groupId,
        memberId: input.memberId,
        emoji: input.emoji,
        active,
        count,
      },
      message: mapMessage(row, reactionCounts(database, String(row.id))),
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function addChatReaction(
  database: RewindDatabase,
  input: Omit<ToggleChatReactionInput, 'active'>,
): ToggleChatReactionResult {
  return toggleChatReaction(database, { ...input, active: true });
}

export function removeChatReaction(
  database: RewindDatabase,
  input: Omit<ToggleChatReactionInput, 'active'>,
): ToggleChatReactionResult {
  return toggleChatReaction(database, { ...input, active: false });
}

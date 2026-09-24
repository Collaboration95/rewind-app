/**
 * Framework-free unread bookkeeping for one chat scope.
 *
 * The store keeps counts and monotonic persisted event ids only. Message bodies
 * must never reach it: the indicator is derived from persisted realtime events
 * without message content, so unread state can exist while a locked or denied
 * timeline stays hidden. The read watermark is deliberately in-memory and is
 * dropped together with the scope.
 */

export interface ChatUnreadScope {
  sessionId: string;
  groupId: string;
  memberId: string;
}

/** The only event fields unread accounting is allowed to observe. */
export interface ChatUnreadEvent {
  eventId: number;
  groupId: string;
  memberId: string;
}

export interface ChatUnreadSnapshot {
  unreadCount: number;
  /** Highest applied persisted event id in this scope, used for dedupe. */
  lastEventId: number;
}

export const INITIAL_CHAT_UNREAD: ChatUnreadSnapshot = { unreadCount: 0, lastEventId: 0 };

/** Session and group together form the security boundary for unread state. */
export function chatScopeKey(scope: ChatUnreadScope | null): string | null {
  return scope ? scope.sessionId + ':' + scope.groupId : null;
}

export type ChatUnreadApplication =
  'ignored_invalid' | 'ignored_foreign' | 'ignored_duplicate' | 'ignored_own' | 'counted' | 'read';

export interface ChatUnreadRecordResult {
  snapshot: ChatUnreadSnapshot;
  applied: ChatUnreadApplication;
}

/**
 * Project an unknown realtime payload onto the fields unread accounting may
 * see. Returning a projection rather than the payload is what guarantees that a
 * message body can never be retained by unread state.
 */
export function projectChatUnreadEvent(event: unknown): ChatUnreadEvent | null {
  if (!event || typeof event !== 'object') return null;
  const candidate = event as { message?: unknown };
  const message = candidate.message;
  if (!message || typeof message !== 'object') return null;
  const fields = message as { groupId?: unknown; memberId?: unknown };
  if (typeof fields.groupId !== 'string' || typeof fields.memberId !== 'string') return null;
  const eventId = Number((event as { eventId?: unknown }).eventId);
  return { eventId, groupId: fields.groupId, memberId: fields.memberId };
}

function withWatermark(
  snapshot: ChatUnreadSnapshot,
  eventId: number,
  applied: ChatUnreadApplication,
): ChatUnreadRecordResult {
  return { snapshot: { ...snapshot, lastEventId: eventId }, applied };
}

/**
 * Apply one persisted event to a scope, in this order:
 *
 * 1. A malformed event or one for another group must never be observed.
 * 2. An event id at or below the watermark is a reconnect replay duplicate and
 *    must not add a second count.
 * 3. The acting member's own message is not incoming mail, but it still moves
 *    the watermark so a later replay cannot count it.
 * 4. A visible chat consumes the event as read; an off-tab event counts.
 *
 * Ignored events return the same snapshot reference so callers can skip a
 * redundant state write.
 */
export function recordChatUnreadEvent(
  snapshot: ChatUnreadSnapshot,
  event: ChatUnreadEvent,
  options: { scope: ChatUnreadScope; chatActive: boolean },
): ChatUnreadRecordResult {
  const scope = options.scope;
  if (!Number.isSafeInteger(event.eventId) || event.eventId <= 0) {
    return { snapshot, applied: 'ignored_invalid' };
  }
  if (event.groupId !== scope.groupId) return { snapshot, applied: 'ignored_foreign' };
  if (event.eventId <= snapshot.lastEventId) return { snapshot, applied: 'ignored_duplicate' };
  if (event.memberId === scope.memberId) {
    return withWatermark(snapshot, event.eventId, 'ignored_own');
  }
  if (options.chatActive) {
    return { snapshot: { unreadCount: 0, lastEventId: event.eventId }, applied: 'read' };
  }
  return {
    snapshot: { unreadCount: snapshot.unreadCount + 1, lastEventId: event.eventId },
    applied: 'counted',
  };
}

/**
 * Opening the chat marks the current group read. The watermark is retained so
 * a later reconnect replay of the same ids cannot resurrect old counts.
 */
export function markChatScopeRead(snapshot: ChatUnreadSnapshot): ChatUnreadSnapshot {
  if (snapshot.unreadCount === 0) return snapshot;
  return { unreadCount: 0, lastEventId: snapshot.lastEventId };
}

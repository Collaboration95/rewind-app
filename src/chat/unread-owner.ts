import type { RealtimeConnectionState, SubscribeOptions } from './realtime-client';
import {
  INITIAL_CHAT_UNREAD,
  chatScopeKey,
  markChatScopeRead,
  projectChatUnreadEvent,
  recordChatUnreadEvent,
  type ChatUnreadScope,
  type ChatUnreadSnapshot,
} from './unread-store';

/**
 * Honest connection vocabulary for chat surfaces.
 *
 * 'unavailable' means this build has no realtime transport at all, which is a
 * different statement from a transport that is retrying.
 */
export type ChatConnectionState =
  'connecting' | 'connected' | 'reconnecting' | 'offline' | 'denied' | 'unavailable';

export interface ChatUnreadState {
  connectionState: ChatConnectionState;
  unreadCount: number;
}

export interface ChatUnreadSubscription {
  close(): void;
}

export type ChatUnreadSubscribe = (
  sessionId: string,
  groupId: string,
  options: SubscribeOptions,
) => ChatUnreadSubscription;

const UNAVAILABLE_STATE: ChatUnreadState = { connectionState: 'unavailable', unreadCount: 0 };

function sameState(left: ChatUnreadState, right: ChatUnreadState): boolean {
  return left.connectionState === right.connectionState && left.unreadCount === right.unreadCount;
}

function isAccessDeniedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  return (
    candidate.status === 401 ||
    candidate.status === 403 ||
    candidate.statusCode === 401 ||
    candidate.statusCode === 403
  );
}

function mapRealtimeState(state: RealtimeConnectionState): ChatConnectionState {
  switch (state) {
    case 'connected':
      return 'connected';
    case 'denied':
      return 'denied';
    case 'connecting':
      return 'connecting';
    default:
      // 'disconnected' still schedules a retry; 'closed' only arrives while this
      // owner is tearing the subscription down with its scope.
      return 'reconnecting';
  }
}

/**
 * App-level unread owner for one session/group scope.
 *
 * This deliberately holds a second, always-on stream beside the one ChatScreen
 * opens for its timeline. The timeline subscription dies with the chat surface,
 * so it cannot observe messages while the member is on another tab; this owner
 * exists to observe exactly those. It counts other members' events only, dedupes
 * by the persisted monotonic event id, and never retains message text.
 *
 * The class is framework-free so its lifecycle can be driven directly in tests.
 * The React binding lives in ChatUnreadProvider and reads this object through
 * useSyncExternalStore, which also keeps mutable state out of render.
 */
export class ChatUnreadOwner {
  private state: ChatUnreadState = UNAVAILABLE_STATE;
  private snapshot: ChatUnreadSnapshot = INITIAL_CHAT_UNREAD;
  private readonly listeners = new Set<() => void>();
  private subscription: ChatUnreadSubscription | null = null;
  private generation = 0;
  private scope: ChatUnreadScope | null = null;
  private currentKey: string | null = null;
  private chatActive = false;
  private denied = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): ChatUnreadState => this.state;

  /**
   * Bind to a scope and transport. A changed session or group drops the count
   * and watermark before the new stream starts, so unread state cannot cross
   * the session/group security boundary. Changing chat visibility alone never
   * restarts the stream.
   */
  bind(input: {
    chatActive: boolean;
    scope: ChatUnreadScope | null;
    subscribeChat: ChatUnreadSubscribe | null;
  }): void {
    const nextKey = chatScopeKey(input.scope);
    this.chatActive = input.chatActive;
    if (this.currentKey !== nextKey) {
      this.stopSubscription();
      this.currentKey = nextKey;
      this.snapshot = INITIAL_CHAT_UNREAD;
      this.denied = false;
    }
    this.scope = input.scope;
    if (!input.scope || !input.subscribeChat) {
      this.stopSubscription();
      this.snapshot = INITIAL_CHAT_UNREAD;
      this.denied = false;
      this.publish(UNAVAILABLE_STATE);
      return;
    }
    if (this.subscription) return;
    this.start(input.scope, input.subscribeChat);
  }

  setChatActive(active: boolean): void {
    this.chatActive = active;
  }

  /** Opening the chat marks the current group read without moving the watermark. */
  markRead(): void {
    const next = markChatScopeRead(this.snapshot);
    if (next === this.snapshot) return;
    this.snapshot = next;
    this.publish({ connectionState: this.state.connectionState, unreadCount: next.unreadCount });
  }

  /** Stop observing without disturbing the last published state. */
  dispose(): void {
    this.stopSubscription();
  }

  private start(scope: ChatUnreadScope, subscribeChat: ChatUnreadSubscribe): void {
    const generation = ++this.generation;
    this.publish({ connectionState: 'connecting', unreadCount: this.snapshot.unreadCount });
    try {
      const subscription = subscribeChat(scope.sessionId, scope.groupId, {
        onEvent: (event) => {
          // A revoked scope stops being a recipient; it must not keep counting.
          if (generation !== this.generation || this.denied) return;
          // Projection rather than the raw event: unread state holds no body text.
          const projected = projectChatUnreadEvent(event);
          if (!projected) return;
          const result = recordChatUnreadEvent(this.snapshot, projected, {
            scope,
            chatActive: this.chatActive,
          });
          if (result.snapshot === this.snapshot) return;
          this.snapshot = result.snapshot;
          this.publish({
            connectionState: this.state.connectionState,
            unreadCount: result.snapshot.unreadCount,
          });
        },
        onConnectionStateChange: (state) => {
          if (generation !== this.generation) return;
          if (state === 'denied') {
            this.denied = true;
            this.snapshot = INITIAL_CHAT_UNREAD;
          }
          this.publish({
            connectionState: mapRealtimeState(state),
            unreadCount: this.snapshot.unreadCount,
          });
        },
        onError: (error) => {
          if (generation !== this.generation) return;
          if (isAccessDeniedError(error)) {
            this.denied = true;
            this.snapshot = INITIAL_CHAT_UNREAD;
            this.publish({ connectionState: 'denied', unreadCount: 0 });
          }
        },
      });
      if (generation !== this.generation) {
        subscription.close();
        return;
      }
      this.subscription = subscription;
    } catch {
      this.publish({ connectionState: 'reconnecting', unreadCount: this.snapshot.unreadCount });
    }
  }

  private stopSubscription(): void {
    this.generation += 1;
    const subscription = this.subscription;
    this.subscription = null;
    subscription?.close();
  }

  private publish(next: ChatUnreadState): void {
    if (sameState(this.state, next)) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

export function chatConnectionLabel(state: ChatConnectionState): string {
  switch (state) {
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return 'Connected';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'offline':
      return 'Offline';
    case 'denied':
      return 'Not authorised';
    case 'unavailable':
      return 'Unavailable';
  }
}

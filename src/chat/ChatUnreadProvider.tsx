import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import type { DemoSession } from '../domain/session';
import type { RuntimeClient } from '../runtime/local-runtime-client';
import { ChatUnreadOwner, type ChatConnectionState, type ChatUnreadState } from './unread-owner';
import type { ChatUnreadScope } from './unread-store';

export type { ChatConnectionState } from './unread-owner';
export { chatConnectionLabel } from './unread-owner';

function readBrowserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export interface ChatUnreadContextValue {
  unreadCount: number;
  connectionState: ChatConnectionState;
  /** Opening the chat marks the current group read without dropping the scope. */
  markRead: () => void;
}

const ChatUnreadContext = createContext<ChatUnreadContextValue | null>(null);

/**
 * App-level unread owner.
 *
 * This is deliberately a second, always-on stream from the one ChatScreen opens
 * for its timeline. The timeline subscription dies with the chat surface, so it
 * cannot observe messages while the member is on another tab; this owner exists
 * to observe exactly those. It counts other members' events only, dedupes by the
 * persisted monotonic event id, and never retains message text.
 *
 * Scope is the session plus group pair. A changed session or group drops the
 * count and starts a fresh watermark, so a sign-out or group switch cannot leak
 * unread state across the security boundary.
 */
export function ChatUnreadProvider({
  activeGroupId,
  children,
  enabled = true,
  owner,
  runtimeClient,
  session,
}: {
  /** Group currently visible in the chat surface, or null when off-tab. */
  activeGroupId: string | null;
  children: ReactNode;
  /** Wait for the app's group lookup before opening an authorised stream. */
  enabled?: boolean;
  /** Inject an owner for tests; production creates one per provider instance. */
  owner?: ChatUnreadOwner;
  runtimeClient: RuntimeClient | null;
  session: DemoSession | null;
}) {
  const groupId = session?.groupId ?? null;
  const scope = useMemo<ChatUnreadScope | null>(
    () =>
      session && groupId
        ? { sessionId: session.id, groupId, memberId: session.actor.memberId }
        : null,
    [groupId, session],
  );
  // A stable instance without reading a ref during render: the lazy initializer
  // runs once and later renders reuse the created owner.
  const [createdOwner] = useState(() => new ChatUnreadOwner());
  const store = owner ?? createdOwner;
  const [browserOnline, setBrowserOnline] = useState(readBrowserOnline);

  const subscribeToTransport = useMemo(
    () =>
      enabled && runtimeClient?.subscribeChat
        ? (
            sessionId: string,
            targetGroupId: string,
            options: Parameters<NonNullable<RuntimeClient['subscribeChat']>>[2],
          ) => runtimeClient.subscribeChat!(sessionId, targetGroupId, options)
        : null,
    [enabled, runtimeClient],
  );
  const chatActive = Boolean(scope && activeGroupId === scope.groupId);

  // Bind after commit so the first paint is not blocked, and so a scope change
  // tears down the previous stream before the replacement starts.
  useEffect(() => {
    store.bind({ chatActive, scope, subscribeChat: subscribeToTransport });
  }, [chatActive, scope, store, subscribeToTransport]);

  // Visibility changes must not restart the stream, so it is reported separately.
  useEffect(() => {
    store.setChatActive(chatActive);
  }, [chatActive, store]);

  useEffect(() => () => store.dispose(), [store]);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function' ||
      typeof window.removeEventListener !== 'function'
    )
      return;
    const update = () => setBrowserOnline(readBrowserOnline());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  const value = useMemo<ChatUnreadContextValue>(
    () => ({
      connectionState: browserOnline ? state.connectionState : 'offline',
      markRead: () => store.markRead(),
      unreadCount: state.unreadCount,
    }),
    [browserOnline, state.connectionState, state.unreadCount, store],
  );

  return <ChatUnreadContext.Provider value={value}>{children}</ChatUnreadContext.Provider>;
}

export function useChatUnread(): ChatUnreadContextValue {
  const value = useContext(ChatUnreadContext);
  if (!value) throw new Error('useChatUnread requires ChatUnreadProvider');
  return value;
}

export function useOptionalChatUnread(): ChatUnreadContextValue | null {
  return useContext(ChatUnreadContext);
}

export type { ChatUnreadState };

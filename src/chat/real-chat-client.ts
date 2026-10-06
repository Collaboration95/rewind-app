import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { useRealAccount } from '../auth/RealAccountProvider';
import { createRuntimeEventSource } from './native-event-source';
import { RealtimeChatClient } from './realtime-client';
import { ChatUnreadOwner } from './unread-owner';
import type { ChatUnreadScope } from './unread-store';

/** The realtime chat client for the signed-in real account. The transport gets
 * authority from the browser cookie or the native Authorization header;
 * credentials never enter URLs. */
export function useRealChatClient(): RealtimeChatClient | null {
  const { authenticatedRequest, baseUrl, realtimeAuthorizationHeader } = useRealAccount();
  return useMemo(() => {
    if (!baseUrl) return null;
    const realtimeBaseUrl = baseUrl.trim().replace(/\/$/, '');
    return new RealtimeChatClient(
      realtimeBaseUrl,
      async (input, init) => {
        // Realtime supplies its full base; authenticatedRequest adds that base
        // itself. Pass only the generated API-relative path, also for /api bases.
        return authenticatedRequest(String(input).slice(realtimeBaseUrl.length), init);
      },
      {
        eventSourceFactory: (url) => {
          const authorization = realtimeAuthorizationHeader();
          return createRuntimeEventSource(
            url,
            authorization ? { Authorization: authorization } : {},
            { withCredentials: true },
          );
        },
      },
    );
  }, [authenticatedRequest, baseUrl, realtimeAuthorizationHeader]);
}

/**
 * The dock's chat badge for a real account: other members' messages that
 * arrive while the chat tab is closed. Metadata only, no message text.
 * ponytail: counts from app open; a server-side read marker would make it survive reloads.
 */
export function useRealChatUnread({
  groupId,
  memberId,
  chatActive,
}: {
  groupId: string | null;
  memberId: string | null;
  chatActive: boolean;
}) {
  const client = useRealChatClient();
  const { session } = useRealAccount();
  const accountId = session?.account.id ?? null;
  const [owner] = useState(() => new ChatUnreadOwner());
  const scope = useMemo<ChatUnreadScope | null>(
    () => (accountId && groupId && memberId ? { sessionId: accountId, groupId, memberId } : null),
    [accountId, groupId, memberId],
  );
  const subscribeChat = useMemo(
    () =>
      client
        ? (
            _sessionId: string,
            targetGroupId: string,
            options: Parameters<RealtimeChatClient['subscribe']>[2],
          ) => client.subscribe('', targetGroupId, options)
        : null,
    [client],
  );
  useEffect(() => {
    owner.bind({ chatActive, scope, subscribeChat });
  }, [chatActive, owner, scope, subscribeChat]);
  useEffect(() => {
    owner.setChatActive(chatActive);
    if (chatActive) owner.markRead();
  }, [chatActive, owner]);
  useEffect(() => () => owner.dispose(), [owner]);
  const state = useSyncExternalStore(owner.subscribe, owner.getState, owner.getState);
  return state.scopeKey === (scope ? `${scope.sessionId}:${scope.groupId}` : null)
    ? state.unreadCount
    : 0;
}

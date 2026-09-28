import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useRealAccount } from '../auth/RealAccountProvider';
import { createRuntimeEventSource } from './native-event-source';
import {
  RealtimeChatClient,
  type ChatMessage,
  type ChatMessageDraft,
  type ChatMessageEvent,
  type RealtimeConnectionState,
} from './realtime-client';

interface ChatRow {
  eventId: number;
  message: ChatMessage;
}

interface RealChatMember {
  memberId: string;
  displayName: string;
}

function appendMessage(rows: ChatRow[], event: ChatMessageEvent): ChatRow[] {
  return mergeRows(rows, [{ eventId: event.eventId, message: event.message }]);
}

function mergeRows(current: ChatRow[], incoming: ChatRow[]): ChatRow[] {
  const merged = new Map(current.map((row) => [row.message.id, row]));
  for (const row of incoming) {
    if (!merged.has(row.message.id)) merged.set(row.message.id, row);
  }
  return [...merged.values()].sort((left, right) => left.eventId - right.eventId);
}

function statusForError(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function friendlyError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Chat could not connect. Check your connection and retry.';
}

/** Authenticated chat for real accounts. The transport obtains authority from
 * the browser cookie or native Authorization header; credentials never enter URLs. */
export function RealAccountChatScreen({
  groupId,
  groupName,
  members,
  memberProfilesError,
  currentMemberId,
  onBack,
}: {
  groupId: string;
  groupName: string;
  members: RealChatMember[];
  memberProfilesError?: string | null;
  currentMemberId?: string;
  onBack: () => void;
}) {
  const auth = useRealAccount();
  const { authenticatedRequest, baseUrl, realtimeAuthorizationHeader, session } = auth;
  const memberNames = useMemo(
    () => new Map(members.map(({ memberId, displayName }) => [memberId, displayName])),
    [members],
  );
  const client = useMemo(() => {
    if (!baseUrl) return null;
    return new RealtimeChatClient(
      baseUrl,
      async (input, init) => {
        const url = new URL(String(input), baseUrl);
        return authenticatedRequest(`${url.pathname}${url.search}`, init);
      },
      {
        sessionIdInQuery: false,
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
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'denied'>('loading');
  const [connection, setConnection] = useState<RealtimeConnectionState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pendingDraft, setPendingDraft] = useState<ChatMessageDraft | null>(null);
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [reactionBusy, setReactionBusy] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const olderCursor = useRef<number | null>(null);
  const activeScope = `${session?.account.id ?? 'signed-out'}:${groupId}`;
  const activeScopeRef = useRef<string | null>(null);
  const effectiveState = !client || !session ? 'error' : state;
  const effectiveError = !client || !session ? 'Sign in again to open this group chat.' : error;

  useEffect(() => {
    if (!client || !session) return;
    activeScopeRef.current = activeScope;
    let active = true;
    let subscription: { close(): void } | null = null;
    olderCursor.current = null;
    void (async () => {
      const query = new URLSearchParams({ limit: '100' });
      const pageResponse = await authenticatedRequest(
        `/realtime/groups/${encodeURIComponent(groupId)}/messages?${query}`,
      );
      if (!pageResponse.ok) {
        const body = (await pageResponse.json().catch(() => ({}))) as { message?: string };
        const denied = pageResponse.status === 401 || pageResponse.status === 403;
        throw Object.assign(new Error(body.message ?? 'Chat history could not be loaded.'), {
          status: pageResponse.status,
          denied,
        });
      }
      const page = (await pageResponse.json()) as {
        events: ChatMessageEvent[];
        nextCursor: number | null;
        hasMore: boolean;
        watermarkEventId: number;
      };
      if (!active) return;
      setRows(page.events.map(({ eventId, message }) => ({ eventId, message })));
      olderCursor.current = page.nextCursor;
      setHasOlderMessages(page.hasMore);
      setState('ready');
      subscription = client.subscribe('', groupId, {
        sinceEventId: page.watermarkEventId,
        onEvent: (event) => {
          if (!active) return;
          setRows((current) => appendMessage(current, event));
          setState('ready');
        },
        onError: (streamError) => {
          if (!active) return;
          if (statusForError(streamError) === 401 || statusForError(streamError) === 403) {
            setRows([]);
            setState('denied');
            setConnection('denied');
            setError('Your access to this group chat has ended.');
          } else {
            setState('error');
            setError(friendlyError(streamError));
          }
        },
        onConnectionStateChange: (next) => {
          if (!active) return;
          setConnection(next);
          if (next === 'connected') {
            setState('ready');
            setError(null);
          } else if (next === 'denied') {
            setRows([]);
            setState('denied');
          }
        },
      });
    })().catch((loadError: unknown) => {
      if (!active) return;
      const denied =
        statusForError(loadError) === 401 ||
        statusForError(loadError) === 403 ||
        Boolean((loadError as { denied?: unknown })?.denied);
      setRows([]);
      setState(denied ? 'denied' : 'error');
      setConnection(denied ? 'denied' : 'disconnected');
      setError(friendlyError(loadError));
    });
    return () => {
      active = false;
      subscription?.close();
      olderCursor.current = null;
      if (activeScopeRef.current === activeScope) activeScopeRef.current = null;
    };
  }, [activeScope, authenticatedRequest, client, groupId, retryKey, session]);

  const loadOlderMessages = async () => {
    const cursor = olderCursor.current;
    const scope = activeScope;
    if (!cursor || loadingOlderMessages || state !== 'ready') return;
    setLoadingOlderMessages(true);
    try {
      const query = new URLSearchParams({ limit: '100', beforeEventId: String(cursor) });
      const pageResponse = await authenticatedRequest(
        `/realtime/groups/${encodeURIComponent(groupId)}/messages?${query}`,
      );
      if (!pageResponse.ok) {
        const body = (await pageResponse.json().catch(() => ({}))) as { message?: string };
        throw Object.assign(new Error(body.message ?? 'Older chat history could not be loaded.'), {
          status: pageResponse.status,
        });
      }
      const page = (await pageResponse.json()) as {
        events: ChatMessageEvent[];
        nextCursor: number | null;
        hasMore: boolean;
      };
      if (activeScopeRef.current !== scope) return;
      const older = page.events.map(({ eventId, message }) => ({ eventId, message }));
      setRows((current) => mergeRows(current, older));
      olderCursor.current = page.nextCursor;
      setHasOlderMessages(page.hasMore);
      setError(null);
    } catch (historyError) {
      if (activeScopeRef.current !== scope) return;
      if (statusForError(historyError) === 401 || statusForError(historyError) === 403) {
        setRows([]);
        setState('denied');
        setConnection('denied');
        setError('Your access to this group chat has ended.');
      } else {
        setError(friendlyError(historyError));
      }
    } finally {
      if (activeScopeRef.current === scope) setLoadingOlderMessages(false);
    }
  };

  const send = async () => {
    if (!client || !draft.trim() || sending || effectiveState === 'denied') return;
    const body = draft.trim();
    const messageDraft = pendingDraft?.body === body ? pendingDraft : client.createDraft(body);
    setPendingDraft(messageDraft);
    setSending(true);
    setError(null);
    try {
      const event = await client.sendMessage('', groupId, messageDraft, {
        ...(replyTarget ? { replyToMessageId: replyTarget.id } : {}),
      });
      setRows((current) => appendMessage(current, event));
      setDraft('');
      setPendingDraft(null);
      setReplyTarget(null);
    } catch (sendError) {
      const denied = statusForError(sendError) === 401 || statusForError(sendError) === 403;
      setError(friendlyError(sendError));
      if (denied) {
        setRows([]);
        setState('denied');
      }
    } finally {
      setSending(false);
    }
  };

  const toggleReaction = async (message: ChatMessage) => {
    if (!client || reactionBusy || effectiveState === 'denied') return;
    setReactionBusy(message.id);
    try {
      const { message: updated } = await client.toggleReaction('', groupId, message.id);
      setRows((current) =>
        current.map((row) => (row.message.id === updated.id ? { ...row, message: updated } : row)),
      );
    } catch (reactionError) {
      setError(friendlyError(reactionError));
    } finally {
      setReactionBusy(null);
    }
  };

  const connectionLabel =
    connection === 'connected'
      ? 'Connected'
      : connection === 'reconnecting' || connection === 'disconnected'
        ? 'Reconnecting…'
        : connection === 'denied'
          ? 'Access denied'
          : 'Connecting…';

  return (
    <View style={styles.container} testID="real-chat-screen">
      <Text style={styles.group} testID="real-chat-context">
        ACTIVE GROUP · {groupName}
      </Text>
      <Text accessibilityRole="header" style={styles.title}>
        Chat
      </Text>
      <Text accessibilityLiveRegion="polite" style={styles.connection}>
        {connectionLabel}
      </Text>
      {memberProfilesError ? (
        <Text
          accessibilityRole="alert"
          style={styles.error}
          testID="real-chat-member-profiles-error"
        >
          {memberProfilesError}
        </Text>
      ) : null}
      {effectiveState === 'loading' ? (
        <Text testID="real-chat-loading">Loading messages…</Text>
      ) : null}
      {effectiveState === 'denied' ? (
        <Text accessibilityRole="alert" style={styles.error} testID="real-chat-denied">
          Chat is unavailable because this account is no longer a member of this group.
        </Text>
      ) : null}
      {effectiveState === 'error' ? (
        <View style={styles.notice} testID="real-chat-error">
          <Text accessibilityRole="alert" style={styles.error}>
            {effectiveError}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              olderCursor.current = null;
              setHasOlderMessages(false);
              setLoadingOlderMessages(false);
              setRetryKey((key) => key + 1);
            }}
          >
            <Text style={styles.action}>Retry chat</Text>
          </Pressable>
        </View>
      ) : null}
      {effectiveState === 'ready' && rows.length === 0 ? (
        <Text style={styles.empty} testID="real-chat-empty">
          No messages yet. Start the conversation.
        </Text>
      ) : null}
      {effectiveState === 'ready' && hasOlderMessages ? (
        <Pressable
          accessibilityRole="button"
          disabled={loadingOlderMessages}
          onPress={() => void loadOlderMessages()}
          testID="real-chat-load-older"
        >
          <Text style={styles.action}>
            {loadingOlderMessages ? 'Loading older messages…' : 'Load older messages'}
          </Text>
        </Pressable>
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={({ message }) => message.id}
        renderItem={({ item: { message } }) => {
          const own = message.memberId === currentMemberId;
          const author = memberNames.get(message.memberId) ?? 'Group member';
          return (
            <View style={[styles.message, own && styles.ownMessage]} testID="real-chat-message">
              <Text style={styles.author}>{own ? 'You' : author}</Text>
              {message.replyTo ? (
                <Text style={styles.replyContext}>↳ {message.replyTo.body}</Text>
              ) : null}
              <Text style={styles.body}>{message.body}</Text>
              <View style={styles.actions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Toggle sparkle reaction"
                  disabled={reactionBusy === message.id}
                  onPress={() => void toggleReaction(message)}
                  testID={`real-chat-reaction-${message.id}`}
                >
                  <Text style={styles.action}>✨ {message.reactionCounts?.['✨'] ?? 0}</Text>
                </Pressable>
                {!message.replyTo ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setReplyTarget(message)}
                    testID={`real-chat-reply-${message.id}`}
                  >
                    <Text style={styles.action}>Reply</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          );
        }}
        style={styles.timeline}
        testID="real-chat-timeline"
      />
      {effectiveState !== 'denied' ? (
        <View style={styles.composer}>
          {replyTarget ? (
            <View style={styles.replyBanner} testID="real-chat-reply-target">
              <Text numberOfLines={1} style={styles.replyContext}>
                Replying to: {replyTarget.body}
              </Text>
              <Pressable accessibilityRole="button" onPress={() => setReplyTarget(null)}>
                <Text style={styles.action}>Cancel</Text>
              </Pressable>
            </View>
          ) : null}
          <TextInput
            accessibilityLabel="Chat message"
            maxLength={2_000}
            multiline
            onChangeText={(value) => {
              setDraft(value);
              if (pendingDraft?.body !== value) setPendingDraft(null);
            }}
            placeholder="Write a message"
            value={draft}
            style={styles.input}
            testID="real-chat-composer"
          />
          {effectiveError && effectiveState !== 'error' ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {effectiveError}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            disabled={sending || !draft.trim() || effectiveState !== 'ready'}
            onPress={() => void send()}
            style={styles.send}
            testID="real-chat-send"
          >
            <Text style={styles.sendText}>{sending ? 'Sending…' : 'Send message'}</Text>
          </Pressable>
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={onBack}
        style={styles.back}
        testID="real-group-chat-back"
      >
        <Text style={styles.action}>Back to Home</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 480, gap: 10 },
  group: { color: '#6b6258', fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },
  title: { color: '#29241f', fontSize: 24, fontWeight: '700' },
  connection: { color: '#6b6258', fontSize: 12 },
  timeline: { flex: 1, minHeight: 180 },
  message: {
    alignSelf: 'flex-start',
    backgroundColor: '#f0ece5',
    borderRadius: 14,
    marginVertical: 5,
    maxWidth: '88%',
    padding: 12,
  },
  ownMessage: { alignSelf: 'flex-end', backgroundColor: '#e5eee6' },
  author: { color: '#57473b', fontSize: 12, fontWeight: '700', marginBottom: 4 },
  body: { color: '#29241f', fontSize: 15, lineHeight: 21 },
  replyContext: { color: '#64584c', fontSize: 12, marginBottom: 4 },
  actions: { flexDirection: 'row', gap: 18, marginTop: 8 },
  action: { color: '#594a3d', fontSize: 13, fontWeight: '600', paddingVertical: 6 },
  composer: { borderTopColor: '#ddd5ca', borderTopWidth: 1, gap: 8, paddingTop: 10 },
  replyBanner: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  input: {
    backgroundColor: '#fff',
    borderColor: '#cfc5b8',
    borderRadius: 10,
    borderWidth: 1,
    color: '#29241f',
    maxHeight: 120,
    minHeight: 44,
    padding: 10,
  },
  send: {
    alignSelf: 'flex-end',
    backgroundColor: '#394d3c',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendText: { color: '#fff', fontWeight: '700' },
  empty: { color: '#594a3d', paddingVertical: 20, textAlign: 'center' },
  error: { color: '#a13f32', fontSize: 13 },
  notice: { gap: 8 },
  back: { alignSelf: 'flex-start', paddingVertical: 4 },
});

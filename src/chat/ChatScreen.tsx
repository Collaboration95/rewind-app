import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useCapsule, type CapsuleState } from '../capsule/CapsuleProvider';
import { demoRepository } from '../data/demo-repository';
import type { Group } from '../domain/profiles';
import type { DemoSession } from '../domain/session';
import { useDemoSession } from '../session/DemoSessionProvider';
import type { RuntimeClient } from '../runtime/local-runtime-client';
import { COLORS } from '../theme';
import {
  createChatMessageDraft,
  type ChatMessage,
  type ChatMessageDraft,
  type ChatMessageEvent,
} from './realtime-client';

const MESSAGE_MAX_LENGTH = 2_000;

type TimelineState = 'loading' | 'ready' | 'error' | 'unavailable' | 'denied';

interface TimelineMessage {
  eventId: number;
  message: ChatMessage;
}

function appendEvent(messages: TimelineMessage[], event: ChatMessageEvent): TimelineMessage[] {
  if (messages.some(({ message }) => message.id === event.message.id)) return messages;
  return [...messages, { eventId: event.eventId, message: event.message }].sort((left, right) => {
    if (left.eventId !== right.eventId) return left.eventId - right.eventId;
    const leftTime = Date.parse(left.message.createdAt);
    const rightTime = Date.parse(right.message.createdAt);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.message.id.localeCompare(right.message.id);
  });
}

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toLocaleString() : 'Unknown time';
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The chat connection could not be established.';
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

/**
 * The parent owns the capsule lookup, but a group remains a valid chat scope
 * when its current cycle is empty or could not be loaded. The key is the
 * security boundary: a changed session or group remounts this surface before
 * any old timeline, draft, or error state can be rendered in the new scope.
 */
export function ChatScreen({ runtimeClient }: { runtimeClient: RuntimeClient | null }) {
  const { session } = useDemoSession();
  const { state, retry } = useCapsule();
  const profiles = useMemo(() => demoRepository.listProfiles(), []);
  const group = 'group' in state ? state.group : null;
  const accessState = state.status === 'denied' ? 'denied' : group ? 'known' : 'loading';
  const scopeKey = session
    ? `${session.id}:${group?.id ?? (accessState === 'denied' ? 'denied' : 'loading')}`
    : 'no-session';
  const memberNames = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile.displayName])),
    [profiles],
  );

  return (
    <ChatSessionSurface
      accessState={accessState}
      capsuleStatus={state.status}
      group={group}
      key={scopeKey}
      memberNames={memberNames}
      retryCapsule={retry}
      runtimeClient={runtimeClient}
      session={session}
    />
  );
}

export function ChatSessionSurface({
  accessState,
  capsuleStatus,
  group,
  memberNames,
  retryCapsule,
  runtimeClient,
  session,
}: {
  accessState: 'loading' | 'known' | 'denied';
  capsuleStatus: CapsuleState['status'];
  group: Group | null;
  memberNames: Map<string, string>;
  retryCapsule: () => void;
  runtimeClient: RuntimeClient | null;
  session: DemoSession | null;
}) {
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [timelineState, setTimelineState] = useState<TimelineState>('loading');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pendingDraft, setPendingDraft] = useState<ChatMessageDraft | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [subscriptionDenied, setSubscriptionDenied] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const subscriptionScope = useRef<string | null>(null);
  const sendRequestId = useRef(0);
  const activeSendRequest = useRef<{ id: number; scope: string } | null>(null);
  const currentScopeRef = useRef<string | null>(null);
  const previousScopeRef = useRef<string | null>(null);

  const activeMessageScope = session && group ? `${session.id}:${group.id}` : null;
  currentScopeRef.current = activeMessageScope;

  const clearSensitiveState = useCallback(() => {
    subscriptionScope.current = null;
    activeSendRequest.current = null;
    setMessages([]);
    setDraft('');
    setPendingDraft(null);
    setSendError(null);
    setSending(false);
    setConnectionError(null);
    setSubscriptionDenied(false);
    setTimelineState('loading');
  }, []);

  useLayoutEffect(() => {
    if (previousScopeRef.current === activeMessageScope) return;
    previousScopeRef.current = activeMessageScope;
    clearSensitiveState();
  }, [activeMessageScope, clearSensitiveState]);

  useEffect(() => {
    if (accessState !== 'known' || !session || !group || !runtimeClient?.subscribeChat) return;

    const scopeKey = activeMessageScope;
    if (!scopeKey) return;
    subscriptionScope.current = scopeKey;
    setSubscriptionDenied(false);
    let active = true;
    let subscription: { close(): void } | null = null;
    const readyTimer = setTimeout(() => {
      if (active) setTimelineState('ready');
    }, 0);
    try {
      subscription = runtimeClient.subscribeChat(session.id, group.id, {
        onEvent: (event) => {
          if (
            !active ||
            currentScopeRef.current !== scopeKey ||
            subscriptionScope.current !== scopeKey ||
            event.message.groupId !== group.id
          )
            return;
          setMessages((current) => appendEvent(current, event));
          setTimelineState('ready');
          setConnectionError(null);
        },
        onError: (error) => {
          if (
            !active ||
            currentScopeRef.current !== scopeKey ||
            subscriptionScope.current !== scopeKey
          )
            return;
          if (isAccessDeniedError(error)) {
            clearSensitiveState();
            setSubscriptionDenied(true);
            setTimelineState('denied');
            return;
          }
          setTimelineState('error');
          setConnectionError(errorMessage(error));
        },
        onConnectionStateChange: (connectionState) => {
          if (
            !active ||
            currentScopeRef.current !== scopeKey ||
            subscriptionScope.current !== scopeKey
          )
            return;
          if (connectionState === 'denied') {
            clearSensitiveState();
            setSubscriptionDenied(true);
            setTimelineState('denied');
          } else if (connectionState === 'connected') {
            setSubscriptionDenied(false);
            setTimelineState('ready');
            setConnectionError(null);
          }
        },
      });
    } catch (error) {
      setTimeout(() => {
        if (!active || currentScopeRef.current !== scopeKey) return;
        setTimelineState('error');
        setConnectionError(errorMessage(error));
      }, 0);
    }

    return () => {
      active = false;
      clearTimeout(readyTimer);
      subscription?.close();
    };
  }, [accessState, activeMessageScope, clearSensitiveState, group, retryKey, runtimeClient, session]);

  const retry = useCallback(() => {
    setMessages([]);
    subscriptionScope.current = null;
    setConnectionError(null);
    setSendError(null);
    setPendingDraft(null);
    if (capsuleStatus === 'error' || capsuleStatus === 'loading') retryCapsule();
    setRetryKey((current) => current + 1);
  }, [capsuleStatus, retryCapsule]);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (
      !body ||
      sending ||
      subscriptionDenied ||
      !runtimeClient?.sendChatMessage ||
      !session ||
      !group
    )
      return;
    const submittedText = draft;
    const sendScope = `${session.id}:${group.id}`;
    const messageDraft =
      pendingDraft?.body === submittedText
        ? pendingDraft
        : (runtimeClient.createChatDraft?.(submittedText) ?? createChatMessageDraft(submittedText));
    const requestId = ++sendRequestId.current;
    activeSendRequest.current = { id: requestId, scope: sendScope };
    setPendingDraft(messageDraft);
    setSending(true);
    setSendError(null);
    const isCurrentSend = () => {
      const activeRequest = activeSendRequest.current;
      return Boolean(
        activeRequest &&
        activeRequest.id === requestId &&
        activeRequest.scope === sendScope &&
        currentScopeRef.current === sendScope &&
        subscriptionScope.current === sendScope,
      );
    };
    try {
      const event = await runtimeClient.sendChatMessage(session.id, group.id, messageDraft);
      if (!isCurrentSend() || event.message.groupId !== group.id) return;
      setMessages((current) => appendEvent(current, event));
      setPendingDraft(null);
      setDraft((current) => (current === submittedText ? '' : current));
    } catch (error) {
      if (!isCurrentSend()) return;
      if (isAccessDeniedError(error)) {
        clearSensitiveState();
        setSubscriptionDenied(true);
        setTimelineState('denied');
        return;
      }
      setSendError(
        error instanceof Error && error.message
          ? error.message
          : 'Your message could not be sent. Try again.',
      );
    } finally {
      if (isCurrentSend()) {
        activeSendRequest.current = null;
        setSending(false);
      }
    }
  }, [clearSensitiveState, draft, group, pendingDraft, runtimeClient, sending, session, subscriptionDenied]);

  const effectiveTimelineState: TimelineState =
      accessState === 'denied' || subscriptionDenied
      ? 'denied'
      : accessState === 'loading'
        ? 'loading'
        : !runtimeClient?.subscribeChat
          ? 'unavailable'
          : timelineState;
  const showComposer = effectiveTimelineState === 'ready' || effectiveTimelineState === 'error';
  const canRenderMessages = accessState === 'known' && effectiveTimelineState !== 'unavailable';

  return (
    <View style={styles.screen} testID="chat-screen">
      <ScrollView
        contentContainerStyle={styles.content}
        style={styles.timelineScroll}
        testID="chat-timeline"
      >
        <View style={styles.header}>
          <Text style={styles.label}>GROUP CHAT</Text>
          <Text accessibilityRole="header" style={styles.title}>
            Chat
          </Text>
          <Text style={styles.bodyText}>
            {group?.name ?? 'Messages are visible only to authorised group members.'}
          </Text>
        </View>

        {effectiveTimelineState === 'loading' ? (
          <View accessible style={styles.statePanel} testID="chat-loading">
            <Text style={styles.panelTitle}>Loading messages…</Text>
            <Text accessibilityLiveRegion="polite" style={styles.bodyText}>
              Checking the saved group conversation.
            </Text>
          </View>
        ) : null}

        {effectiveTimelineState === 'denied' ? (
          <View accessible style={styles.statePanel} testID="chat-denied">
            <Text style={styles.panelTitle}>Chat unavailable</Text>
            <Text style={styles.bodyText}>
              Choose authorised Demo access to view this group conversation.
            </Text>
          </View>
        ) : null}

        {effectiveTimelineState === 'unavailable' ? (
          <View accessible style={styles.statePanel} testID="chat-unavailable">
            <Text style={styles.panelTitle}>Chat needs the local runtime</Text>
            <Text style={styles.bodyText}>Connect the local runtime to load this group chat.</Text>
          </View>
        ) : null}

        {effectiveTimelineState === 'error' ? (
          <View accessible style={styles.errorPanel} testID="chat-error">
            <Text accessibilityRole="alert" style={styles.errorText}>
              {connectionError ?? 'The chat connection could not be established.'}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={retry}
              style={styles.outlineButton}
              testID="chat-retry"
            >
              <Text style={styles.outlineButtonText}>Retry chat connection</Text>
            </Pressable>
          </View>
        ) : null}

        {effectiveTimelineState === 'ready' && canRenderMessages && messages.length === 0 ? (
          <View accessible style={styles.statePanel} testID="chat-empty">
            <Text style={styles.panelTitle}>No messages yet</Text>
            <Text style={styles.bodyText}>Start the conversation with a short note below.</Text>
          </View>
        ) : null}

        {canRenderMessages &&
          messages.map(({ message }) => {
            const author = memberNames.get(message.memberId) ?? 'Group member';
            const isCurrentMember = message.memberId === session?.actor.memberId;
            return (
              <View
                accessible
                accessibilityLabel={`${author}${isCurrentMember ? ', you' : ''}. ${message.body}. ${formatTimestamp(message.createdAt)}`}
                key={message.id}
                style={[styles.message, isCurrentMember && styles.currentMessage]}
                testID="chat-message"
              >
                <View style={styles.messageMeta}>
                  <Text style={styles.author}>{isCurrentMember ? 'You' : author}</Text>
                  <Text style={styles.timestamp}>{formatTimestamp(message.createdAt)}</Text>
                </View>
                <Text style={styles.messageBody}>{message.body}</Text>
              </View>
            );
          })}

        {sendError ? (
          <Text accessibilityRole="alert" style={styles.fieldError} testID="chat-send-error">
            {sendError}
          </Text>
        ) : null}
      </ScrollView>

      {showComposer && !subscriptionDenied && runtimeClient?.sendChatMessage && group && session ? (
        <View style={styles.composer}>
          <Text style={styles.fieldLabel}>MESSAGE</Text>
          <TextInput
            accessibilityLabel="Chat message"
            maxLength={MESSAGE_MAX_LENGTH}
            multiline
            onChangeText={(value) => {
              setDraft(value);
              setPendingDraft((current) => (current?.body === value ? current : null));
              setSendError(null);
            }}
            placeholder="Write a message"
            placeholderTextColor={COLORS.muted}
            style={styles.input}
            testID="chat-composer"
            value={draft}
          />
          <View style={styles.composerFooter}>
            <Text style={styles.counter}>
              {draft.length}/{MESSAGE_MAX_LENGTH}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={sending || !draft.trim()}
              onPress={() => void send()}
              style={[styles.primaryButton, (sending || !draft.trim()) && styles.disabledButton]}
              testID="chat-send"
            >
              <Text style={styles.primaryButtonText}>{sending ? 'Sending…' : 'Send message'}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {sendError && pendingDraft && !subscriptionDenied ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => void send()}
          style={styles.outlineButton}
          testID="chat-send-retry"
        >
          <Text style={styles.outlineButtonText}>Retry sending</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  timelineScroll: { flex: 1 },
  content: { gap: 14, padding: 24, paddingBottom: 20 },
  header: { gap: 4 },
  label: { color: COLORS.edge, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  title: { color: COLORS.ink, fontSize: 30, fontWeight: '700', marginTop: 2 },
  bodyText: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  statePanel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
    padding: 16,
  },
  errorPanel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.edge,
    borderRadius: 10,
    borderWidth: 1,
    gap: 12,
    padding: 16,
  },
  panelTitle: { color: COLORS.ink, fontSize: 18, fontWeight: '700' },
  errorText: { color: COLORS.ink, fontSize: 14, lineHeight: 21 },
  message: {
    alignSelf: 'flex-start',
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
    maxWidth: '92%',
    padding: 14,
  },
  currentMessage: { alignSelf: 'flex-end', borderColor: COLORS.accent },
  messageMeta: { alignItems: 'baseline', flexDirection: 'row', gap: 8 },
  author: { color: COLORS.ink, fontSize: 13, fontWeight: '700' },
  timestamp: { color: COLORS.muted, fontSize: 11 },
  messageBody: { color: COLORS.ink, fontSize: 16, lineHeight: 23 },
  composer: {
    backgroundColor: COLORS.background,
    borderColor: COLORS.line,
    borderTopWidth: 1,
    gap: 8,
    padding: 16,
  },
  fieldLabel: { color: COLORS.edge, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  input: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 8,
    borderWidth: 1,
    color: COLORS.ink,
    fontSize: 16,
    minHeight: 72,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlignVertical: 'top',
  },
  composerFooter: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  counter: { color: COLORS.muted, fontSize: 12 },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  primaryButtonText: { color: COLORS.deep, fontSize: 14, fontWeight: '800' },
  disabledButton: { opacity: 0.5 },
  outlineButton: {
    alignItems: 'center',
    borderColor: COLORS.edge,
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  outlineButtonText: { color: COLORS.ink, fontSize: 14, fontWeight: '700' },
  fieldError: { color: COLORS.ink, fontSize: 14, lineHeight: 21 },
});

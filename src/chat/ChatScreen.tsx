import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useCapsule, type CapsuleState } from '../capsule/CapsuleProvider';
import { demoRepository } from '../data/demo-repository';
import type { Group } from '../domain/profiles';
import type { DemoSession } from '../domain/session';
import { useDemoSession } from '../session/DemoSessionProvider';
import type { RuntimeClient } from '../runtime/local-runtime-client';
import { COLORS } from '../theme';
import type { ChatMessage, ChatMessageEvent } from './realtime-client';

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
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [reactionBusy, setReactionBusy] = useState<string | null>(null);
  const [reactionActive, setReactionActive] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (accessState !== 'known' || !session || !group || !runtimeClient?.subscribeChat) return;

    let active = true;
    let subscription: { close(): void } | null = null;
    const readyTimer = setTimeout(() => {
      if (active) setTimelineState('ready');
    }, 0);
    try {
      subscription = runtimeClient.subscribeChat(session.id, group.id, {
        onEvent: (event) => {
          if (!active) return;
          setMessages((current) => appendEvent(current, event));
          setTimelineState('ready');
          setConnectionError(null);
        },
        onError: (error) => {
          if (!active) return;
          setTimelineState('error');
          setConnectionError(errorMessage(error));
        },
      });
    } catch (error) {
      setTimeout(() => {
        if (!active) return;
        setTimelineState('error');
        setConnectionError(errorMessage(error));
      }, 0);
    }

    return () => {
      active = false;
      clearTimeout(readyTimer);
      subscription?.close();
    };
  }, [accessState, group, retryKey, runtimeClient, session]);

  const retry = useCallback(() => {
    setMessages([]);
    setConnectionError(null);
    setSendError(null);
    setReplyTarget(null);
    setReactionActive({});
    if (capsuleStatus === 'error' || capsuleStatus === 'loading') retryCapsule();
    setRetryKey((current) => current + 1);
  }, [capsuleStatus, retryCapsule]);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body || sending || !runtimeClient?.sendChatMessage || !session || !group) return;
    setSending(true);
    setSendError(null);
    try {
      const event =
        replyTarget && runtimeClient.sendChatReply
          ? await runtimeClient.sendChatReply(session.id, group.id, body, replyTarget.id)
          : await runtimeClient.sendChatMessage(session.id, group.id, body);
      setMessages((current) => appendEvent(current, event));
      setDraft('');
      setReplyTarget(null);
    } catch (error) {
      setSendError(
        error instanceof Error && error.message
          ? error.message
          : 'Your message could not be sent. Try again.',
      );
    } finally {
      setSending(false);
    }
  }, [draft, group, replyTarget, runtimeClient, sending, session]);

  const toggleReaction = useCallback(
    async (message: ChatMessage) => {
      if (!runtimeClient?.toggleChatReaction || !session || !group || reactionBusy) return;
      setReactionBusy(message.id);
      try {
        const result = await runtimeClient.toggleChatReaction(
          session.id,
          group.id,
          message.id,
          '✨',
        );
        setMessages((current) =>
          current.map((entry) =>
            entry.message.id === message.id ? { ...entry, message: result.message } : entry,
          ),
        );
        setReactionActive((current) => ({ ...current, [message.id]: result.reaction.active }));
      } catch (error) {
        setSendError(errorMessage(error));
      } finally {
        setReactionBusy(null);
      }
    },
    [group, reactionBusy, runtimeClient, session],
  );

  const effectiveTimelineState: TimelineState =
    accessState === 'denied'
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
            const reactionCount = message.reactionCounts?.['✨'] ?? 0;
            const canReply = Boolean(runtimeClient?.sendChatReply && !message.replyTo);
            return (
              <View
                accessible={false}
                accessibilityLabel={`${author}${isCurrentMember ? ', you' : ''}. ${message.body}. ${formatTimestamp(message.createdAt)}${message.replyTo ? `. Reply to ${message.replyTo.body}` : ''}${reactionCount ? `. ${reactionCount} sparkle reactions` : ''}`}
                key={message.id}
                style={[styles.message, isCurrentMember && styles.currentMessage]}
                testID="chat-message"
              >
                <View style={styles.messageMeta}>
                  <Text style={styles.author}>{isCurrentMember ? 'You' : author}</Text>
                  <Text style={styles.timestamp}>{formatTimestamp(message.createdAt)}</Text>
                </View>
                {message.replyTo ? (
                  <View
                    accessible
                    accessibilityLabel={`Replying to ${message.replyTo.body}`}
                    style={styles.replyContext}
                    testID="chat-reply-context"
                  >
                    <Text style={styles.replyLabel}>REPLYING TO</Text>
                    <Text numberOfLines={2} style={styles.replyText}>
                      {message.replyTo.body}
                    </Text>
                  </View>
                ) : null}
                <Text style={styles.messageBody}>{message.body}</Text>
                {runtimeClient?.toggleChatReaction || canReply ? (
                  <View style={styles.messageActions}>
                    {runtimeClient?.toggleChatReaction ? (
                      <Pressable
                        accessibilityLabel={`${reactionCount} sparkle reactions, ${
                          reactionActive[message.id] === undefined
                            ? 'toggle sparkle reaction'
                            : reactionActive[message.id]
                              ? 'remove yours'
                              : 'add sparkle reaction'
                        }`}
                        accessibilityRole="button"
                        disabled={reactionBusy === message.id}
                        onPress={() => void toggleReaction(message)}
                        style={styles.actionButton}
                        testID={`chat-reaction-${message.id}`}
                      >
                        <Text style={styles.actionText}>
                          {reactionActive[message.id] ? '✨ Reacted' : '✨'} {reactionCount}
                        </Text>
                      </Pressable>
                    ) : null}
                    {canReply ? (
                      <Pressable
                        accessibilityLabel={`Reply to ${author}`}
                        accessibilityRole="button"
                        onPress={() => setReplyTarget(message)}
                        style={styles.actionButton}
                        testID={`chat-reply-${message.id}`}
                      >
                        <Text style={styles.actionText}>Reply</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })}

        {sendError ? (
          <Text accessibilityRole="alert" style={styles.fieldError} testID="chat-send-error">
            {sendError}
          </Text>
        ) : null}
      </ScrollView>

      {showComposer && runtimeClient?.sendChatMessage && group && session ? (
        <View style={styles.composer}>
          <Text style={styles.fieldLabel}>MESSAGE</Text>
          {replyTarget ? (
            <View accessible={false} style={styles.composerReply} testID="chat-reply-target">
              <Text style={styles.replyLabel}>REPLYING TO</Text>
              <Text numberOfLines={1} style={styles.replyText}>
                {replyTarget.body}
              </Text>
              <Pressable
                accessibilityLabel="Cancel reply"
                accessibilityRole="button"
                onPress={() => setReplyTarget(null)}
                testID="chat-reply-cancel"
              >
                <Text style={styles.actionText}>Cancel</Text>
              </Pressable>
            </View>
          ) : null}
          <TextInput
            accessibilityLabel="Chat message"
            maxLength={MESSAGE_MAX_LENGTH}
            multiline
            onChangeText={(value) => {
              setDraft(value);
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
  messageActions: { flexDirection: 'row', gap: 8, marginTop: 2 },
  actionButton: { paddingVertical: 3, paddingHorizontal: 2 },
  actionText: { color: COLORS.edge, fontSize: 12, fontWeight: '700' },
  replyContext: {
    backgroundColor: COLORS.background,
    borderLeftColor: COLORS.edge,
    borderLeftWidth: 3,
    gap: 2,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  composerReply: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 8,
    borderWidth: 1,
    gap: 3,
    padding: 8,
  },
  replyLabel: { color: COLORS.edge, fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  replyText: { color: COLORS.muted, fontSize: 12 },
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

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useRealAccount } from '../auth/RealAccountProvider';
import { ReportSheet } from '../real/ReportSheet';
import { blockMember, reportContent } from '../real/safety';
import { Icon } from '../ui/Icon';
import { Avatar, Glass, rw, useToast } from '../ui/primitives';
import { FONT, WARM, memberColor, serif } from '../ui/tokens';
import { useRealChatClient } from './real-chat-client';
import {
  type ChatMessage,
  type ChatMessageDraft,
  type ChatMessageEvent,
  type RealtimeConnectionState,
} from './realtime-client';
import { useNetworkOnline } from './use-network-online';

const CHAT_MAX = 2_000;

interface ChatRow {
  eventId: number;
  message: ChatMessage;
}

interface RealChatMember {
  memberId: string;
  displayName: string;
}

interface FailedMessage {
  draft: ChatMessageDraft;
  replyTo: ChatMessage | null;
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

const short = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function dayLabel(iso: string, now: number): string {
  const date = new Date(iso);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** T1–T6, T8–T11: one chat per group. Text, replies and ✨. */
export function RealAccountChatScreen({
  groupId,
  groupName,
  members,
  memberProfilesError,
  currentMemberId,
  blocked,
  onBlocked,
  unreadOnOpen = 0,
  premiere,
  bottomInset = 0,
}: {
  groupId: string;
  groupName: string;
  members: RealChatMember[];
  memberProfilesError?: string | null;
  currentMemberId?: string;
  /** People this account blocked: their messages are hidden right away. */
  blocked?: Set<string>;
  onBlocked?: (memberId: string) => void;
  /** Unread count when the tab opened: a "N new messages" line marks where they start. */
  unreadOnOpen?: number;
  /** T10: during the premiere a banner links to the film. */
  premiere?: { left: string; onWatch: () => void } | null;
  /** Room for the dock under the composer. */
  bottomInset?: number;
  onBack?: () => void;
}) {
  const auth = useRealAccount();
  const { authenticatedRequest, session } = auth;
  const client = useRealChatClient();
  const toast = useToast();
  const online = useNetworkOnline();
  const memberNames = useMemo(
    () => new Map(members.map(({ memberId, displayName }) => [memberId, displayName])),
    [members],
  );
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
      } else {
        // T8: the message stays in place, marked "Not sent · Retry".
        setFailed((current) => [...current, { draft: messageDraft, replyTo: replyTarget }]);
        setDraft('');
        setPendingDraft(null);
        setReplyTarget(null);
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

  const [failed, setFailed] = useState<FailedMessage[]>([]);
  const [openMessage, setOpenMessage] = useState<string | null>(null);
  const [reporting, setReporting] = useState<ChatMessage | null>(null);
  const [now] = useState(() => Date.now());
  const [freshFrom] = useState(unreadOnOpen);
  const scroller = useRef<ScrollView>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const offsets = useRef(new Map<string, number>());
  useEffect(
    () => () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    },
    [],
  );

  const resend = async (item: FailedMessage) => {
    if (!client || sending) return;
    setFailed((current) => current.filter((entry) => entry !== item));
    setSending(true);
    try {
      const event = await client.sendMessage('', groupId, item.draft, {
        ...(item.replyTo ? { replyToMessageId: item.replyTo.id } : {}),
      });
      setRows((current) => appendMessage(current, event));
      setError(null);
    } catch (sendError) {
      setFailed((current) => [...current, item]);
      setError(friendlyError(sendError));
    } finally {
      setSending(false);
    }
  };

  const nameOf = (memberId: string) =>
    memberId === currentMemberId ? 'You' : (memberNames.get(memberId) ?? 'Group member');
  const visible = rows.filter(({ message }) => !blocked?.has(message.memberId));
  const reconnecting =
    effectiveState === 'ready' && (connection === 'reconnecting' || connection === 'disconnected');
  const offline = !online;
  const canSend = effectiveState === 'ready' && !offline;
  const freshIndex = freshFrom > 0 ? Math.max(0, visible.length - freshFrom) : -1;
  const quoteTarget = (id: string) => {
    const y = offsets.current.get(id);
    if (y === undefined) return;
    scroller.current?.scrollTo({ y: Math.max(0, y - 120), animated: true });
    setHighlight(id);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlight(null), 1200);
  };

  const sendReport = async (reason: string, alsoBlock: boolean) => {
    if (!reporting) return null;
    try {
      await reportContent(authenticatedRequest, groupId, { messageId: reporting.id }, reason);
      if (alsoBlock) {
        await blockMember(authenticatedRequest, reporting.memberId);
        onBlocked?.(reporting.memberId);
      }
      setReporting(null);
      toast(
        alsoBlock
          ? 'Reported and blocked. You won’t see their messages or moments.'
          : 'Thanks. The Rewind team reviews reports within 24 hours.',
      );
      return null;
    } catch (failure) {
      return failure instanceof Error
        ? failure.message
        : 'The report could not be sent. Try again.';
    }
  };

  let stateView: ReactNode = null;
  if (effectiveState === 'loading')
    stateView = (
      <Text style={styles.loading} testID="real-chat-loading">
        Loading messages…
      </Text>
    );
  else if (effectiveState === 'denied')
    stateView = (
      <View style={styles.state}>
        <Text accessibilityRole="alert" style={styles.stateBody} testID="real-chat-denied">
          Chat is unavailable because this account is no longer a member of this group.
        </Text>
      </View>
    );
  else if (effectiveState === 'error')
    stateView = (
      <View accessibilityRole="alert" style={styles.state} testID="real-chat-error">
        <Text accessibilityRole="header" style={styles.stateTitle}>
          Couldn’t load the chat
        </Text>
        <Text style={styles.stateBody}>
          {effectiveError ?? 'Check your connection and try again.'}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            olderCursor.current = null;
            setHasOlderMessages(false);
            setLoadingOlderMessages(false);
            setRetryKey((key) => key + 1);
          }}
          style={({ pressed }) => [styles.stateButton, pressed && styles.pressed]}
          testID="real-chat-retry"
          {...rw('btn')}
        >
          <Text style={styles.stateButtonText}>Try again</Text>
        </Pressable>
      </View>
    );
  else if (visible.length === 0 && failed.length === 0)
    stateView = (
      <View style={styles.state} testID="real-chat-empty">
        <Text accessibilityRole="header" style={styles.stateTitle}>
          No messages yet
        </Text>
        <Text style={styles.stateBody}>
          Say hi to {groupName}. Moments stay sealed, so no spoilers.
        </Text>
      </View>
    );

  return (
    <View style={styles.container} testID="real-chat-screen">
      <View style={styles.bg} pointerEvents="none" />
      {premiere ? (
        <Pressable
          accessibilityRole="button"
          onPress={premiere.onWatch}
          style={({ pressed }) => [styles.banner, pressed && styles.pressed]}
          testID="real-chat-premiere"
          {...rw('glass')}
        >
          <View style={styles.bannerIcon} {...rw('primary')}>
            <Icon color={WARM.peachInk} filled name="play" size={16} />
          </View>
          <View style={styles.bannerText}>
            <Text style={styles.bannerTitle}>Your film is here</Text>
            <Text style={styles.bannerNote}>Premiere · {premiere.left}</Text>
          </View>
          <Text style={styles.bannerGo}>Watch</Text>
        </Pressable>
      ) : null}
      {offline || reconnecting ? (
        <View accessibilityRole="alert" style={styles.conn} testID="real-chat-connection">
          {offline ? (
            <View style={styles.connDot} />
          ) : (
            <View style={styles.connSpin} {...rw('spin')} />
          )}
          <Text style={styles.connText}>
            {offline ? 'You’re offline. Send when you’re back.' : 'Reconnecting…'}
          </Text>
        </View>
      ) : null}
      {memberProfilesError ? (
        <Text
          accessibilityRole="alert"
          style={styles.error}
          testID="real-chat-member-profiles-error"
        >
          {memberProfilesError}
        </Text>
      ) : null}
      <ScrollView
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}
        ref={scroller}
        style={styles.timeline}
        testID="real-chat-timeline"
        {...rw('no-scrollbar')}
      >
        {effectiveState === 'ready' && hasOlderMessages ? (
          <Pressable
            accessibilityRole="button"
            disabled={loadingOlderMessages}
            onPress={() => void loadOlderMessages()}
            style={styles.older}
            testID="real-chat-load-older"
          >
            <Text style={styles.olderText}>
              {loadingOlderMessages ? 'Loading older messages…' : 'Load older messages'}
            </Text>
          </Pressable>
        ) : null}
        {stateView}
        {effectiveState === 'denied'
          ? null
          : visible.map(({ message }, index) => {
              const prev = visible[index - 1]?.message;
              const newDay =
                !prev || dayLabel(prev.createdAt, now) !== dayLabel(message.createdAt, now);
              const fresh = index === freshIndex;
              const first = newDay || fresh || prev?.memberId !== message.memberId;
              const own = message.memberId === currentMemberId;
              const author = nameOf(message.memberId);
              const sparks = message.reactionCounts?.['✨'] ?? 0;
              const open = openMessage === message.id;
              return (
                <Fragment key={message.id}>
                  {newDay ? (
                    <Text style={styles.day}>{dayLabel(message.createdAt, now)}</Text>
                  ) : null}
                  {fresh ? (
                    <View accessibilityRole="text" style={styles.fresh} testID="real-chat-new">
                      <View style={styles.freshLine} />
                      <Text style={styles.freshText}>
                        {freshFrom === 1 ? '1 new message' : `${freshFrom} new messages`}
                      </Text>
                      <View style={styles.freshLine} />
                    </View>
                  ) : null}
                  <View
                    onLayout={(event) =>
                      offsets.current.set(message.id, event.nativeEvent.layout.y)
                    }
                    style={[styles.msg, first && styles.msgFirst, own && styles.msgOwn]}
                    testID="real-chat-message"
                  >
                    {own ? null : first ? (
                      <Avatar
                        color={memberColor(message.memberId)}
                        name={author}
                        size={28}
                        style={styles.cav}
                      />
                    ) : (
                      <View style={styles.cavSpace} />
                    )}
                    <View style={[styles.mcol, own && styles.mcolOwn]}>
                      {first ? (
                        <Text style={styles.meta}>
                          {own ? null : <Text style={styles.metaName}>{author} </Text>}
                          {timeLabel(message.createdAt)}
                        </Text>
                      ) : null}
                      <Pressable
                        accessibilityLabel={`${author}: ${message.body}${message.replyTo ? `. Reply to ${nameOf(message.replyTo.memberId)}` : ''}${sparks ? `. ${sparks} ✨` : ''}`}
                        accessibilityState={{ expanded: open }}
                        onPress={() => setOpenMessage(open ? null : message.id)}
                        style={[
                          styles.bub,
                          own ? styles.bubOwn : styles.bubOther,
                          (open || highlight === message.id) && styles.bubOpen,
                        ]}
                        testID={`real-chat-message-${message.id}`}
                        {...(own ? rw('own-bubble') : {})}
                      >
                        {message.replyTo ? (
                          <Pressable
                            accessibilityLabel={`Go to the message from ${nameOf(message.replyTo.memberId)}`}
                            onPress={() => quoteTarget(message.replyTo!.id)}
                            style={[styles.quote, own && styles.quoteOwn]}
                          >
                            <Text style={styles.quoteName}>{nameOf(message.replyTo.memberId)}</Text>
                            <Text numberOfLines={2} style={styles.quoteText}>
                              {message.replyTo.body}
                            </Text>
                          </Pressable>
                        ) : null}
                        <Text style={[styles.body, own && { color: WARM.peachInk }]}>
                          {message.body}
                        </Text>
                      </Pressable>
                      {sparks ? (
                        <Pressable
                          accessibilityLabel={`${sparks} sparkles. Toggle yours`}
                          accessibilityRole="button"
                          disabled={reactionBusy === message.id}
                          hitSlop={8}
                          onPress={() => void toggleReaction(message)}
                          style={styles.rx}
                          testID={`real-chat-sparks-${message.id}`}
                        >
                          <Text style={styles.rxText}>✨ {sparks}</Text>
                        </Pressable>
                      ) : null}
                      {open ? (
                        <View
                          accessibilityLabel="Message actions"
                          role="group"
                          style={styles.acts}
                          {...rw('menu-in')}
                        >
                          <Pressable
                            accessibilityLabel="Toggle sparkle reaction"
                            accessibilityRole="button"
                            disabled={reactionBusy === message.id}
                            onPress={() => {
                              setOpenMessage(null);
                              void toggleReaction(message);
                            }}
                            style={styles.act}
                            testID={`real-chat-reaction-${message.id}`}
                          >
                            <Text style={styles.actText}>✨ React</Text>
                          </Pressable>
                          {!message.replyTo ? (
                            <Pressable
                              accessibilityRole="button"
                              onPress={() => {
                                setOpenMessage(null);
                                setReplyTarget(message);
                              }}
                              style={styles.act}
                              testID={`real-chat-reply-${message.id}`}
                            >
                              <Text style={styles.actText}>Reply</Text>
                            </Pressable>
                          ) : null}
                          {own ? null : (
                            <Pressable
                              accessibilityRole="button"
                              onPress={() => {
                                setOpenMessage(null);
                                setReporting(message);
                              }}
                              style={styles.act}
                              testID={`real-chat-report-${message.id}`}
                            >
                              <Text style={styles.actText}>Report</Text>
                            </Pressable>
                          )}
                        </View>
                      ) : null}
                    </View>
                  </View>
                </Fragment>
              );
            })}
        {failed.map((item) => (
          <View key={item.draft.messageId} style={[styles.msg, styles.msgFirst, styles.msgOwn]}>
            <View style={[styles.mcol, styles.mcolOwn]}>
              <View style={[styles.bub, styles.bubOwn, styles.bubFailed]} {...rw('own-bubble')}>
                <Text style={[styles.body, { color: WARM.peachInk }]}>{item.draft.body}</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                disabled={sending || !canSend}
                onPress={() => void resend(item)}
                style={styles.fail}
                testID="real-chat-retry-send"
              >
                <Text style={styles.failText}>Not sent · Retry</Text>
              </Pressable>
            </View>
          </View>
        ))}
        {sending ? <Text style={styles.sendingNote}>Sending…</Text> : null}
      </ScrollView>
      {effectiveState !== 'denied' && effectiveState !== 'error' ? (
        <View style={[styles.cmp, { paddingBottom: bottomInset }]}>
          {replyTarget ? (
            <Glass style={styles.cmpRe} testID="real-chat-reply-target">
              <Text numberOfLines={1} style={styles.cmpReText}>
                <Text style={styles.cmpReName}>Replying to {nameOf(replyTarget.memberId)} </Text>
                {replyTarget.body}
              </Text>
              <Pressable
                accessibilityLabel="Cancel reply"
                accessibilityRole="button"
                hitSlop={6}
                onPress={() => setReplyTarget(null)}
                style={styles.cmpReClose}
              >
                <Icon name="close" size={16} />
              </Pressable>
            </Glass>
          ) : null}
          {draft.length > CHAT_MAX - 200 ? (
            <Text accessibilityLiveRegion="polite" style={styles.count}>
              {draft.length} / {CHAT_MAX}
            </Text>
          ) : null}
          {effectiveError && effectiveState === 'ready' ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {effectiveError}
            </Text>
          ) : null}
          <Glass style={styles.cmpRow} variant="composer">
            <TextInput
              accessibilityLabel="Message"
              maxLength={CHAT_MAX}
              multiline
              numberOfLines={1}
              onChangeText={(value) => {
                setDraft(value);
                if (pendingDraft?.body !== value) setPendingDraft(null);
              }}
              onKeyPress={(event) => {
                const native = event.nativeEvent as { key: string; shiftKey?: boolean };
                if (native.key === 'Enter' && !native.shiftKey && canSend) {
                  event.preventDefault?.();
                  void send();
                }
              }}
              placeholder={`Message ${short(groupName, 20)}`}
              placeholderTextColor={WARM.muted}
              style={styles.input}
              testID="real-chat-composer"
              value={draft}
              {...rw('bare')}
            />
            <Pressable
              accessibilityLabel="Send"
              accessibilityRole="button"
              accessibilityState={{ disabled: sending || !draft.trim() || !canSend }}
              disabled={sending || !draft.trim() || !canSend}
              onPress={() => void send()}
              style={[styles.send, (sending || !draft.trim() || !canSend) && styles.sendOff]}
              testID="real-chat-send"
              {...(sending || !draft.trim() || !canSend ? {} : rw('primary'))}
            >
              <Icon
                color={
                  sending || !draft.trim() || !canSend ? 'rgba(51, 35, 26, 0.4)' : WARM.peachInk
                }
                name="send"
                size={20}
              />
            </Pressable>
          </Glass>
        </View>
      ) : null}
      {reporting ? (
        <ReportSheet
          name={nameOf(reporting.memberId)}
          onCancel={() => setReporting(null)}
          onSend={sendReport}
          what="message"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  bg: { ...StyleSheet.absoluteFill },
  timeline: { flex: 1 },
  list: {
    flexGrow: 1,
    justifyContent: 'flex-end',
    paddingBottom: 12,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  loading: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 14,
    marginVertical: 40,
    textAlign: 'center',
  },
  state: {
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 18,
    marginVertical: 'auto',
    paddingBottom: 30,
  },
  stateTitle: { color: WARM.ink, textAlign: 'center', ...serif(24) },
  stateBody: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 14,
    lineHeight: 20,
    maxWidth: 260,
    textAlign: 'center',
  },
  stateButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.6)',
    borderRadius: 26,
    height: 52,
    justifyContent: 'center',
    marginTop: 12,
    paddingHorizontal: 26,
  },
  stateButtonText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 15, fontWeight: '600' },
  pressed: { opacity: 0.8 },
  banner: {
    alignItems: 'center',
    borderRadius: 22,
    flexDirection: 'row',
    gap: 12,
    marginBottom: 6,
    marginHorizontal: 16,
    minHeight: 56,
    paddingHorizontal: 12,
  },
  bannerIcon: {
    alignItems: 'center',
    borderRadius: 16,
    height: 32,
    justifyContent: 'center',
    paddingLeft: 2,
    width: 32,
  },
  bannerText: { flex: 1 },
  bannerTitle: { color: WARM.ink, ...serif(16) },
  bannerNote: { color: WARM.muted, fontFamily: FONT.body, fontSize: 12.5 },
  bannerGo: { color: WARM.ink, fontFamily: FONT.body, fontSize: 14, fontWeight: '600' },
  conn: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.82)',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  connDot: { backgroundColor: 'rgba(51, 35, 26, 0.4)', borderRadius: 4, height: 8, width: 8 },
  connSpin: {
    borderColor: 'rgba(51, 35, 26, 0.18)',
    borderRadius: 6,
    borderTopColor: WARM.accent,
    borderWidth: 2,
    height: 12,
    width: 12,
  },
  connText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 12.5 },
  older: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.6)',
    borderRadius: 999,
    justifyContent: 'center',
    marginVertical: 4,
    minHeight: 44,
    paddingHorizontal: 14,
  },
  olderText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 13, fontWeight: '600' },
  day: {
    alignSelf: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.55)',
    borderRadius: 999,
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 11.5,
    fontWeight: '500',
    marginBottom: 6,
    marginTop: 20,
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  fresh: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    marginBottom: 2,
    marginHorizontal: 4,
    marginTop: 14,
  },
  freshLine: { backgroundColor: 'rgba(224, 112, 58, 0.45)', flex: 1, height: 1 },
  freshText: { color: '#96390f', fontFamily: FONT.body, fontSize: 11.5, fontWeight: '600' },
  msg: { alignItems: 'flex-start', flexDirection: 'row', gap: 8, marginTop: 3 },
  msgFirst: { marginTop: 12 },
  msgOwn: { justifyContent: 'flex-end' },
  cav: { marginTop: 18 },
  cavSpace: { width: 28 },
  mcol: { alignItems: 'flex-start', flexShrink: 1, maxWidth: 262, minWidth: 0 },
  mcolOwn: { alignItems: 'flex-end' },
  meta: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 11.5,
    marginBottom: 3,
    marginHorizontal: 6,
  },
  metaName: { color: WARM.ink, fontWeight: '600' },
  bub: { maxWidth: '100%', paddingHorizontal: 13, paddingVertical: 9 },
  bubOther: {
    backgroundColor: 'rgba(255, 255, 255, 0.78)',
    borderBottomLeftRadius: 7,
    borderRadius: 20,
  },
  bubOwn: { backgroundColor: '#ffcda6', borderBottomRightRadius: 7, borderRadius: 20 },
  bubOpen: {
    boxShadow: '0 0 0 2px rgba(224, 112, 58, 0.55), 0 6px 16px -8px rgba(150, 80, 30, 0.45)',
  },
  bubFailed: { boxShadow: 'inset 0 0 0 1.5px rgba(143, 38, 21, 0.55)' },
  body: { color: WARM.ink, fontFamily: FONT.body, fontSize: 15, lineHeight: 20 },
  quote: {
    backgroundColor: 'rgba(246, 237, 227, 0.7)',
    borderBottomRightRadius: 10,
    borderLeftColor: WARM.accent,
    borderLeftWidth: 2,
    borderRadius: 6,
    borderTopRightRadius: 10,
    marginBottom: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  quoteOwn: { backgroundColor: 'rgba(255, 255, 255, 0.45)' },
  quoteName: { color: WARM.ink, fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600' },
  quoteText: { color: WARM.muted, fontFamily: FONT.body, fontSize: 12.5, lineHeight: 16 },
  rx: {
    backgroundColor: '#fffaf5',
    borderColor: 'rgba(51, 35, 26, 0.1)',
    borderRadius: 999,
    borderWidth: 1,
    marginHorizontal: 10,
    marginTop: -6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    zIndex: 1,
  },
  rxText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 12 },
  acts: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  act: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    borderColor: 'rgba(51, 35, 26, 0.08)',
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 14,
  },
  actText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 13, fontWeight: '600' },
  fail: { justifyContent: 'center', marginHorizontal: 4, marginTop: 2, minHeight: 32 },
  failText: { color: WARM.dangerInk, fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600' },
  sendingNote: {
    alignSelf: 'flex-end',
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 11.5,
    marginRight: 6,
    marginTop: 3,
  },
  cmp: { gap: 6, paddingHorizontal: 16 },
  cmpRe: {
    alignItems: 'center',
    borderRadius: 18,
    flexDirection: 'row',
    gap: 6,
    paddingLeft: 14,
    paddingRight: 6,
    paddingVertical: 4,
  },
  cmpReText: { color: WARM.muted, flex: 1, fontFamily: FONT.body, fontSize: 12.5 },
  cmpReName: { color: WARM.ink, fontWeight: '600' },
  cmpReClose: { alignItems: 'center', height: 36, justifyContent: 'center', width: 36 },
  count: {
    alignSelf: 'flex-end',
    backgroundColor: 'rgba(255, 255, 255, 0.8)',
    borderRadius: 999,
    color: WARM.ink,
    fontFamily: FONT.body,
    fontSize: 11.5,
    marginRight: 14,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  cmpRow: {
    alignItems: 'flex-end',
    borderRadius: 26,
    flexDirection: 'row',
    gap: 8,
    padding: 5,
    paddingLeft: 18,
  },
  input: {
    color: WARM.ink,
    flex: 1,
    fontFamily: FONT.body,
    fontSize: 15,
    lineHeight: 20,
    maxHeight: 96,
    minHeight: 42,
    paddingVertical: 11,
  },
  send: {
    alignItems: 'center',
    backgroundColor: '#ffb784',
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  sendOff: { backgroundColor: 'rgba(51, 35, 26, 0.07)' },
  error: {
    color: WARM.dangerInk,
    fontFamily: FONT.body,
    fontSize: 13,
    marginHorizontal: 16,
    textAlign: 'center',
  },
});

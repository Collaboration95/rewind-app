export interface ChatMessage {
  id: string;
  groupId: string;
  memberId: string;
  body: string;
  createdAt: string;
  replyTo?: ChatReplyContext | null;
  reactionCounts?: Partial<Record<ChatReactionEmoji, number>>;
}

export interface ChatReplyContext {
  id: string;
  memberId: string;
  body: string;
  createdAt: string;
}

export type ChatReactionEmoji = '✨';

export interface ChatReactionResult {
  messageId: string;
  groupId: string;
  memberId: string;
  emoji: ChatReactionEmoji;
  active: boolean;
  count: number;
}

export interface ChatMessageEvent {
  eventId: number;
  type: 'message';
  message: ChatMessage;
  occurredAt: string;
}

/** A draft keeps its client id alongside text so a retry is idempotent. */
export interface ChatMessageDraft {
  body: string;
  messageId: string;
}

export type RealtimeConnectionState =
  'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'denied' | 'closed';

export interface RealtimeSubscription {
  close(): void;
  readonly state: RealtimeConnectionState;
}

export interface RealtimeEventSource {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
  close(): void;
  onerror: ((event: unknown) => void) | null;
  onopen?: (() => void) | null;
  /** Some native EventSource adapters expose the HTTP status that failed. */
  status?: number;
  statusCode?: number;
}

export type RealtimeEventSourceFactory = (url: string) => RealtimeEventSource;

export interface RealtimeChatClientOptions {
  eventSourceFactory?: RealtimeEventSourceFactory;
  reconnectDelayMs?: number;
  /** Maximum time a direct message POST may remain in flight. */
  sendTimeoutMs?: number;
}

export interface SubscribeOptions {
  sinceEventId?: number;
  /** Start a fresh observer at the current end of the persisted event log. */
  startFromLatest?: boolean;
  onEvent(event: ChatMessageEvent): void;
  /** Persisted cursor delivered before live events on a startFromLatest stream. */
  onCheckpoint?(eventId: number): void;
  onError?(error: unknown): void;
  onConnectionStateChange?(state: RealtimeConnectionState): void;
  /** Alias useful to UI consumers that call the lifecycle a status. */
  onStatusChange?(state: RealtimeConnectionState): void;
  reconnect?: boolean;
  reconnectDelayMs?: number;
}

export class RealtimeChatError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly messageId?: string,
  ) {
    super(message);
    this.name = 'RealtimeChatError';
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/$/, '');
  if (/^\/(?:[^/].*)?$/i.test(trimmed)) return trimmed || '/';
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new RealtimeChatError(
      'The local realtime URL must start with http://, https://, or a same-origin / path.',
    );
  }
  return trimmed;
}

function defaultEventSourceFactory(url: string): RealtimeEventSource {
  const EventSourceConstructor = (
    globalThis as unknown as {
      EventSource?: new (source: string) => RealtimeEventSource;
    }
  ).EventSource;
  if (!EventSourceConstructor) {
    throw new RealtimeChatError(
      'This platform does not provide EventSource. Supply an eventSourceFactory for LAN realtime support.',
    );
  }
  return new EventSourceConstructor(url);
}

function randomMessageId(): string {
  const cryptoApi = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return `message-${cryptoApi.randomUUID()}`;
  return `message-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Public draft factory for consumers that do not own a RealtimeChatClient. */
export function createChatMessageDraft(body: string): ChatMessageDraft {
  return { body, messageId: randomMessageId() };
}

function errorStatus(error: unknown, source?: RealtimeEventSource): number | undefined {
  if (error && typeof error === 'object') {
    const candidate = error as { status?: unknown; statusCode?: unknown };
    if (typeof candidate.status === 'number') return candidate.status;
    if (typeof candidate.statusCode === 'number') return candidate.statusCode;
  }
  if (typeof source?.status === 'number') return source.status;
  if (typeof source?.statusCode === 'number') return source.statusCode;
  return undefined;
}

function isMessageDraft(value: string | ChatMessageDraft): value is ChatMessageDraft {
  return typeof value !== 'string';
}

export class RealtimeChatClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly eventSourceFactory: RealtimeEventSourceFactory;
  private readonly reconnectDelayMs: number;
  private readonly sendTimeoutMs: number;

  constructor(
    baseUrl: string,
    fetchImpl: typeof fetch = fetch,
    options: RealtimeChatClientOptions = {},
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    // `window.fetch` requires a Window receiver in browsers. A lexical
    // wrapper prevents class-method invocation from rebinding it to this
    // client instance while preserving injected fetch doubles.
    this.fetchImpl = (input, init) => fetchImpl(input, init);
    this.eventSourceFactory = options.eventSourceFactory ?? defaultEventSourceFactory;
    const reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    if (!Number.isFinite(reconnectDelayMs) || reconnectDelayMs < 0) {
      throw new RealtimeChatError('The realtime reconnect delay must not be negative.');
    }
    this.reconnectDelayMs = reconnectDelayMs;
    const sendTimeoutMs = options.sendTimeoutMs ?? 10_000;
    if (!Number.isFinite(sendTimeoutMs) || sendTimeoutMs <= 0) {
      throw new RealtimeChatError('The realtime message send timeout must be greater than zero.');
    }
    this.sendTimeoutMs = sendTimeoutMs;
  }

  /** Create a retryable draft without changing or discarding its compose text. */
  createDraft(body: string): ChatMessageDraft {
    return createChatMessageDraft(body);
  }

  async sendMessage(
    sessionId: string,
    groupId: string,
    bodyOrDraft: string | ChatMessageDraft,
    options: { messageId?: string; replyToMessageId?: string } = {},
  ): Promise<ChatMessageEvent> {
    const body = isMessageDraft(bodyOrDraft) ? bodyOrDraft.body : bodyOrDraft;
    const messageId =
      options.messageId ??
      (isMessageDraft(bodyOrDraft) ? bodyOrDraft.messageId : randomMessageId());
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutController =
      typeof AbortController === 'function' ? new AbortController() : undefined;
    const timeoutError = () =>
      new RealtimeChatError(
        `The realtime message did not receive a response within ${this.sendTimeoutMs} ms. You can retry safely.`,
        undefined,
        'send_timeout',
        messageId,
      );
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          timeoutController?.abort();
          reject(timeoutError());
        }, this.sendTimeoutMs);
      });
      const requestPromise = (async () => {
        const response = await this.fetchImpl(
          `${this.baseUrl}/realtime/groups/${encodeURIComponent(groupId)}/messages?sessionId=${encodeURIComponent(sessionId)}`,
          {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({
              body,
              messageId,
              ...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {}),
            }),
            ...(timeoutController ? { signal: timeoutController.signal } : {}),
          },
        );
        const payload = (await response.json().catch(() => ({}))) as {
          event?: ChatMessageEvent;
          message?: string;
          error?: string;
        };
        if (!response.ok || !payload.event) {
          throw new RealtimeChatError(
            payload.message ?? `Local realtime runtime returned HTTP ${response.status}.`,
            response.status,
            payload.error,
            messageId,
          );
        }
        return payload.event;
      })();
      return await Promise.race([requestPromise, timeoutPromise]);
    } catch (error) {
      if (timedOut) throw timeoutError();
      if (error instanceof RealtimeChatError) throw error;
      throw new RealtimeChatError(
        error instanceof Error && error.message
          ? error.message
          : 'The realtime message could not be sent.',
        undefined,
        'network_error',
        messageId,
      );
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  /** Retry the same persisted identity; the server safely replays its event. */
  retryMessage(
    sessionId: string,
    groupId: string,
    draft: ChatMessageDraft,
  ): Promise<ChatMessageEvent> {
    return this.sendMessage(sessionId, groupId, draft);
  }

  async toggleReaction(
    sessionId: string,
    groupId: string,
    messageId: string,
    emoji: ChatReactionEmoji = '✨',
    active?: boolean,
  ): Promise<{ reaction: ChatReactionResult; message: ChatMessage }> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/realtime/groups/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(messageId)}/reactions?sessionId=${encodeURIComponent(sessionId)}`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji, ...(active === undefined ? {} : { active }) }),
      },
    );
    const payload = (await response.json().catch(() => ({}))) as {
      reaction?: ChatReactionResult;
      message?: ChatMessage | string;
      error?: string;
    };
    if (
      !response.ok ||
      !payload.reaction ||
      !payload.message ||
      typeof payload.message === 'string'
    ) {
      throw new RealtimeChatError(
        typeof payload.message === 'string'
          ? payload.message
          : `Local realtime runtime returned HTTP ${response.status}.`,
        response.status,
        payload.error,
      );
    }
    return { reaction: payload.reaction, message: payload.message as ChatMessage };
  }

  subscribe(sessionId: string, groupId: string, options: SubscribeOptions): RealtimeSubscription {
    let source: RealtimeEventSource | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let lastEventId = options.sinceEventId ?? 0;
    const includeInitialSince = options.sinceEventId !== undefined;
    // Event id 0 is a valid checkpoint, so track receipt separately from its
    // numeric value. Until the first checkpoint arrives, retries must still
    // ask the server to establish a fresh unread watermark.
    let latestCheckpointReceived = !options.startFromLatest || includeInitialSince;
    let state: RealtimeConnectionState = 'connecting';
    const reconnect = options.reconnect !== false;
    const reconnectDelayMs = options.reconnectDelayMs ?? this.reconnectDelayMs;
    if (!Number.isFinite(reconnectDelayMs) || reconnectDelayMs < 0) {
      throw new RealtimeChatError('The realtime reconnect delay must not be negative.');
    }

    const setState = (next: RealtimeConnectionState) => {
      if (state === next) return;
      state = next;
      options.onConnectionStateChange?.(next);
      options.onStatusChange?.(next);
    };
    options.onConnectionStateChange?.(state);
    options.onStatusChange?.(state);

    let sourceListener: ((event: unknown) => void) | null = null;
    let sourceDeniedListener: ((event: unknown) => void) | null = null;
    let sourceCheckpointListener: ((event: unknown) => void) | null = null;
    const closeSource = () => {
      if (!source) return;
      if (sourceListener) source.removeEventListener?.('message', sourceListener);
      if (sourceDeniedListener) source.removeEventListener?.('access-denied', sourceDeniedListener);
      if (sourceCheckpointListener)
        source.removeEventListener?.('checkpoint', sourceCheckpointListener);
      source.onerror = null;
      source.onopen = null;
      source.close();
      source = null;
      sourceListener = null;
      sourceDeniedListener = null;
      sourceCheckpointListener = null;
    };

    let open: (isReconnect?: boolean) => void;
    const failWithError = (error: unknown, currentSource?: RealtimeEventSource) => {
      const statusCode = errorStatus(error, currentSource);
      const denied = statusCode === 401 || statusCode === 403;
      const normalized =
        error instanceof RealtimeChatError
          ? error
          : new RealtimeChatError(
              denied
                ? 'You no longer have access to this group chat.'
                : 'The realtime chat connection was interrupted.',
              statusCode,
              denied ? 'forbidden' : 'connection_error',
            );
      options.onError?.(normalized);
      closeSource();
      if (denied || closed || !reconnect) {
        if (denied) setState('denied');
        else if (!closed) setState('disconnected');
        return;
      }
      setState('disconnected');
      if (reconnectTimer === null) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (!closed) open(true);
        }, reconnectDelayMs);
      }
    };

    open = (isReconnect = false) => {
      if (closed) return;
      setState(isReconnect ? 'reconnecting' : 'connecting');
      const startingFromLatest =
        options.startFromLatest &&
        !includeInitialSince &&
        !latestCheckpointReceived &&
        lastEventId === 0;
      const since =
        includeInitialSince || (isReconnect && !startingFromLatest) || lastEventId > 0
          ? `&sinceEventId=${encodeURIComponent(String(lastEventId))}`
          : '';
      const startFromLatest = startingFromLatest ? '&startFromLatest=true' : '';
      let nextSource: RealtimeEventSource;
      try {
        nextSource = this.eventSourceFactory(
          `${this.baseUrl}/realtime/groups/${encodeURIComponent(groupId)}/events?sessionId=${encodeURIComponent(sessionId)}${since}${startFromLatest}`,
        );
      } catch (error) {
        failWithError(error);
        return;
      }
      source = nextSource;
      const onMessage = (event: unknown) => {
        if (source !== nextSource || closed) return;
        const data =
          event && typeof event === 'object' && 'data' in event
            ? (event as { data: unknown }).data
            : event;
        try {
          const parsed = typeof data === 'string' ? JSON.parse(data) : data;
          if (
            !parsed ||
            typeof parsed !== 'object' ||
            !('message' in parsed) ||
            !('eventId' in parsed) ||
            (parsed as { message?: { groupId?: unknown } }).message?.groupId !== groupId
          ) {
            throw new Error('The realtime message event has an invalid shape.');
          }
          const eventId = Number((parsed as { eventId: unknown }).eventId);
          if (Number.isSafeInteger(eventId) && eventId > lastEventId) lastEventId = eventId;
          options.onEvent(parsed as ChatMessageEvent);
        } catch (error) {
          options.onError?.(error);
        }
      };
      const onAccessDenied = (event: unknown) => {
        if (source !== nextSource || closed) return;
        const data =
          event && typeof event === 'object' && 'data' in event
            ? (event as { data: unknown }).data
            : event;
        let message = 'You no longer have access to this group chat.';
        let statusCode: number | undefined = 403;
        try {
          const parsed = (typeof data === 'string' ? JSON.parse(data) : data) as {
            status?: unknown;
            message?: unknown;
          };
          if (typeof parsed?.message === 'string') message = parsed.message;
          if (typeof parsed?.status === 'number') statusCode = parsed.status;
        } catch {
          // The event itself is the terminal denial signal; retain safe defaults.
        }
        failWithError(new RealtimeChatError(message, statusCode, 'forbidden'), nextSource);
      };
      const onCheckpoint = (event: unknown) => {
        if (source !== nextSource || closed) return;
        const data =
          event && typeof event === 'object' && 'data' in event
            ? (event as { data: unknown }).data
            : event;
        try {
          const parsed = (typeof data === 'string' ? JSON.parse(data) : data) as {
            eventId?: unknown;
          };
          const eventId = Number(parsed?.eventId);
          if (Number.isSafeInteger(eventId) && eventId >= 0) {
            lastEventId = Math.max(lastEventId, eventId);
            latestCheckpointReceived = true;
            options.onCheckpoint?.(eventId);
          }
        } catch {
          options.onError?.(new RealtimeChatError('The realtime event checkpoint was invalid.'));
        }
      };
      sourceListener = onMessage;
      sourceDeniedListener = onAccessDenied;
      sourceCheckpointListener = onCheckpoint;
      nextSource.addEventListener('message', onMessage);
      nextSource.addEventListener('access-denied', onAccessDenied);
      nextSource.addEventListener('checkpoint', onCheckpoint);
      nextSource.onopen = () => {
        if (source === nextSource && !closed) setState('connected');
      };
      nextSource.onerror = (error) => {
        if (source === nextSource) failWithError(error, nextSource);
      };
    };

    open();
    return {
      close: () => {
        if (closed) return;
        closed = true;
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        closeSource();
        setState('closed');
      },
      get state() {
        return state;
      },
    };
  }
}

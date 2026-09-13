export interface ChatMessage {
  id: string;
  groupId: string;
  memberId: string;
  body: string;
  createdAt: string;
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
}

export interface SubscribeOptions {
  sinceEventId?: number;
  onEvent(event: ChatMessageEvent): void;
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
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new RealtimeChatError('The local realtime URL must start with http:// or https://.');
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

  constructor(
    baseUrl: string,
    fetchImpl: typeof fetch = fetch,
    options: RealtimeChatClientOptions = {},
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.eventSourceFactory = options.eventSourceFactory ?? defaultEventSourceFactory;
    const reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    if (!Number.isFinite(reconnectDelayMs) || reconnectDelayMs < 0) {
      throw new RealtimeChatError('The realtime reconnect delay must not be negative.');
    }
    this.reconnectDelayMs = reconnectDelayMs;
  }

  /** Create a retryable draft without changing or discarding its compose text. */
  createDraft(body: string): ChatMessageDraft {
    return { body, messageId: randomMessageId() };
  }

  async sendMessage(
    sessionId: string,
    groupId: string,
    bodyOrDraft: string | ChatMessageDraft,
    options: { messageId?: string } = {},
  ): Promise<ChatMessageEvent> {
    const body = isMessageDraft(bodyOrDraft) ? bodyOrDraft.body : bodyOrDraft;
    const messageId =
      options.messageId ??
      (isMessageDraft(bodyOrDraft) ? bodyOrDraft.messageId : randomMessageId());
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/realtime/groups/${encodeURIComponent(groupId)}/messages?sessionId=${encodeURIComponent(sessionId)}`,
        {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ body, messageId }),
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
    } catch (error) {
      if (error instanceof RealtimeChatError) throw error;
      throw new RealtimeChatError(
        error instanceof Error && error.message
          ? error.message
          : 'The realtime message could not be sent.',
        undefined,
        'network_error',
        messageId,
      );
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

  subscribe(sessionId: string, groupId: string, options: SubscribeOptions): RealtimeSubscription {
    let source: RealtimeEventSource | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let lastEventId = options.sinceEventId ?? 0;
    const includeInitialSince = options.sinceEventId !== undefined;
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
    const closeSource = () => {
      if (!source) return;
      if (sourceListener) source.removeEventListener?.('message', sourceListener);
      if (sourceDeniedListener) source.removeEventListener?.('access-denied', sourceDeniedListener);
      source.onerror = null;
      source.onopen = null;
      source.close();
      source = null;
      sourceListener = null;
      sourceDeniedListener = null;
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
      const since =
        includeInitialSince || isReconnect || lastEventId > 0
          ? `&sinceEventId=${encodeURIComponent(String(lastEventId))}`
          : '';
      let nextSource: RealtimeEventSource;
      try {
        nextSource = this.eventSourceFactory(
          `${this.baseUrl}/realtime/groups/${encodeURIComponent(groupId)}/events?sessionId=${encodeURIComponent(sessionId)}${since}`,
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
      sourceListener = onMessage;
      sourceDeniedListener = onAccessDenied;
      nextSource.addEventListener('message', onMessage);
      nextSource.addEventListener('access-denied', onAccessDenied);
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

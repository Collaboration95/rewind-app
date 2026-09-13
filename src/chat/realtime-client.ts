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

export interface RealtimeSubscription {
  close(): void;
}

export interface RealtimeEventSource {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
  close(): void;
  onerror: ((event: unknown) => void) | null;
}

export type RealtimeEventSourceFactory = (url: string) => RealtimeEventSource;

export interface RealtimeChatClientOptions {
  eventSourceFactory?: RealtimeEventSourceFactory;
}

export interface SubscribeOptions {
  sinceEventId?: number;
  onEvent(event: ChatMessageEvent): void;
  onError?(error: unknown): void;
}

export class RealtimeChatError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
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

export class RealtimeChatClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly eventSourceFactory: RealtimeEventSourceFactory;

  constructor(
    baseUrl: string,
    fetchImpl: typeof fetch = fetch,
    options: RealtimeChatClientOptions = {},
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.eventSourceFactory = options.eventSourceFactory ?? defaultEventSourceFactory;
  }

  async sendMessage(sessionId: string, groupId: string, body: string): Promise<ChatMessageEvent> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/realtime/groups/${encodeURIComponent(groupId)}/messages?sessionId=${encodeURIComponent(sessionId)}`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
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
      );
    }
    return payload.event;
  }

  subscribe(sessionId: string, groupId: string, options: SubscribeOptions): RealtimeSubscription {
    const since =
      options.sinceEventId === undefined
        ? ''
        : `&sinceEventId=${encodeURIComponent(String(options.sinceEventId))}`;
    const source = this.eventSourceFactory(
      `${this.baseUrl}/realtime/groups/${encodeURIComponent(groupId)}/events?sessionId=${encodeURIComponent(sessionId)}${since}`,
    );
    const onMessage = (event: unknown) => {
      const data =
        event && typeof event === 'object' && 'data' in event
          ? (event as { data: unknown }).data
          : event;
      try {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        if (!parsed || typeof parsed !== 'object' || !('message' in parsed)) {
          throw new Error('The realtime message event has an invalid shape.');
        }
        options.onEvent(parsed as ChatMessageEvent);
      } catch (error) {
        options.onError?.(error);
      }
    };
    source.addEventListener('message', onMessage);
    source.onerror = (error) => options.onError?.(error);
    let closed = false;
    return {
      close: () => {
        if (closed) return;
        closed = true;
        source.removeEventListener?.('message', onMessage);
        source.close();
      },
    };
  }
}

import {
  RealtimeChatClient,
  type RealtimeEventSource,
  type RealtimeConnectionState,
} from '../src/chat/realtime-client';
import {
  NativeEventSource,
  NATIVE_SSE_MAX_RESPONSE_CHARS,
  createRuntimeEventSource,
} from '../src/chat/native-event-source';

class FakeXhr {
  readyState = 0;
  status = 0;
  responseText = '';
  onreadystatechange: (() => void) | null = null;
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  ontimeout: ((event: unknown) => void) | null = null;
  onabort: ((event: unknown) => void) | null = null;
  opened: [string, string] | null = null;
  headers: [string, string][] = [];
  aborted = false;
  static last: FakeXhr;

  constructor() {
    FakeXhr.last = this;
  }

  open(method: string, url: string) {
    this.opened = [method, url];
  }

  setRequestHeader(name: string, value: string) {
    this.headers.push([name, value]);
  }

  send() {}

  abort() {
    this.aborted = true;
  }

  progress(text: string) {
    this.readyState = 3;
    this.status = 200;
    this.responseText = text;
    this.onreadystatechange?.();
    this.onprogress?.();
  }
}

test('native SSE adapter parses framed events, reports open, and aborts on close', () => {
  const source = new NativeEventSource('http://127.0.0.1/events', FakeXhr);
  const messages: string[] = [];
  const checkpoints: string[] = [];
  const opened = jest.fn();
  source.onopen = opened;
  source.addEventListener('message', (event) => messages.push((event as { data: string }).data));
  source.addEventListener('checkpoint', (event) =>
    checkpoints.push((event as { data: string }).data),
  );
  const xhr = FakeXhr.last;

  expect(xhr.opened).toEqual(['GET', 'http://127.0.0.1/events']);
  expect(xhr.headers).toContainEqual(['Accept', 'text/event-stream']);
  xhr.progress('id: 9\r');
  expect(checkpoints).toEqual([]);
  xhr.progress(
    'id: 9\r\nevent: checkpoint\r\ndata: {"eventId":9}\r\n\r\nevent: message\r\ndata: {"message":\r\ndata: "hello"}\r\n\r\n',
  );

  expect(opened).toHaveBeenCalledTimes(1);
  expect(checkpoints).toEqual(['{"eventId":9}']);
  expect(messages).toEqual(['{"message":\n"hello"}']);
  source.close();
  expect(xhr.aborted).toBe(true);
});

test('real-account SSE sends native bearer authority in a header and omits it from the URL', () => {
  const client = new RealtimeChatClient('https://runtime.example', fetch, {
    eventSourceFactory: (url) =>
      new NativeEventSource(url, FakeXhr, { Authorization: 'Bearer opaque-private-token' }),
  });
  const subscription = client.subscribe('', 'real-group', { onEvent: () => {} });
  const xhr = FakeXhr.last;

  expect(xhr.opened?.[1]).toBe('https://runtime.example/realtime/groups/real-group/events');
  expect(xhr.opened?.[1]).not.toContain('opaque-private-token');
  expect(xhr.opened?.[1]).not.toContain('sessionId');
  expect(xhr.headers).toContainEqual(['Authorization', 'Bearer opaque-private-token']);
  subscription.close();
});

test('native SSE adapter dispatches a terminal double LF without waiting for another chunk', () => {
  const source = new NativeEventSource('/events', FakeXhr);
  const received: string[] = [];
  source.addEventListener('message', (event) => received.push((event as { data: string }).data));

  FakeXhr.last.progress('data: complete\n\n');

  expect(received).toEqual(['complete']);
  source.close();
});

test('native SSE adapter aborts oversized line and event buffers', () => {
  const lineSource = new NativeEventSource('/events', FakeXhr);
  const lineError = jest.fn();
  lineSource.onerror = lineError;
  const lineXhr = FakeXhr.last;
  lineXhr.progress(`${'x'.repeat(32 * 1024)}\n`);
  expect(lineError).toHaveBeenCalledTimes(1);
  expect(lineXhr.aborted).toBe(true);
  lineSource.close();

  const eventSource = new NativeEventSource('/events', FakeXhr);
  const eventError = jest.fn();
  const delivered: string[] = [];
  eventSource.onerror = eventError;
  eventSource.addEventListener('message', (event) =>
    delivered.push((event as { data: string }).data),
  );
  const eventXhr = FakeXhr.last;
  const oversizedEvent = `${Array.from(
    { length: 5 },
    () => `data: ${'x'.repeat(14 * 1024)}\n`,
  ).join('')}\n`;
  eventXhr.progress(oversizedEvent);
  expect(eventError).toHaveBeenCalledTimes(1);
  expect(delivered).toEqual([]);
  expect(eventXhr.aborted).toBe(true);
  eventSource.close();
});

test('native SSE HTTP denial reaches realtime connection state without reconnecting', () => {
  const client = new RealtimeChatClient('http://127.0.0.1:8787', fetch, {
    eventSourceFactory: (url) => new NativeEventSource(url, FakeXhr),
    reconnectDelayMs: 0,
  });
  const states: RealtimeConnectionState[] = [];
  const subscription = client.subscribe('session-1', 'demo-group', {
    onEvent: () => {},
    onConnectionStateChange: (state) => states.push(state),
  });
  const xhr = FakeXhr.last;
  xhr.readyState = 2;
  xhr.status = 403;
  xhr.onreadystatechange?.();

  expect(states).toEqual(['connecting', 'denied']);
  expect(subscription.state).toBe('denied');
  expect(xhr.aborted).toBe(true);
  subscription.close();
});

test('native SSE response rotation reconnects from its delivered cursor without loss or duplicates', async () => {
  const urls: string[] = [];
  const received: number[] = [];
  const factory = (url: string) => {
    urls.push(url);
    return new NativeEventSource(url, FakeXhr);
  };
  const client = new RealtimeChatClient('http://127.0.0.1:8787', fetch, {
    eventSourceFactory: factory,
    reconnectDelayMs: 0,
  });
  const subscription = client.subscribe('session-1', 'demo-group', {
    onEvent: (event) => received.push(event.eventId),
  });
  const firstXhr = FakeXhr.last;
  const stream = Array.from({ length: 3_000 }, (_, index) => {
    const eventId = index + 1;
    const event = {
      eventId,
      type: 'message',
      occurredAt: '2026-09-26T00:00:00.000Z',
      message: {
        id: `message-${eventId}`,
        groupId: 'demo-group',
        memberId: 'demo-1',
        body: 'x',
        createdAt: '2026-09-26T00:00:00.000Z',
      },
    };
    return `id: ${eventId}\ndata: ${JSON.stringify(event)}\n\n`;
  }).join('');

  expect(stream.length).toBeGreaterThan(NATIVE_SSE_MAX_RESPONSE_CHARS);
  firstXhr.progress(stream);
  expect(firstXhr.aborted).toBe(true);
  const lastDelivered = received[received.length - 1];
  expect(lastDelivered).toBeGreaterThan(0);

  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(urls).toHaveLength(2);
  expect(urls[1]).toMatch(new RegExp(`[?&]sinceEventId=${lastDelivered}$`));
  const replayEvent = {
    eventId: lastDelivered + 1,
    type: 'message',
    occurredAt: '2026-09-26T00:00:00.000Z',
    message: {
      id: `message-${lastDelivered + 1}`,
      groupId: 'demo-group',
      memberId: 'demo-1',
      body: 'replayed',
      createdAt: '2026-09-26T00:00:00.000Z',
    },
  };
  FakeXhr.last.progress(`id: ${lastDelivered + 1}\ndata: ${JSON.stringify(replayEvent)}\n\n`);
  expect(received).toEqual(Array.from({ length: lastDelivered + 1 }, (_, index) => index + 1));
  subscription.close();
  expect(FakeXhr.last.aborted).toBe(true);
});

test('runtime EventSource factory preserves browser EventSource and falls back to native XHR', () => {
  const previousEventSource = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  const previousXhr = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  class BrowserEventSource extends FakeEventSource {
    constructor(
      readonly url: string,
      readonly options?: { withCredentials?: boolean },
    ) {
      super();
    }
  }
  try {
    Object.defineProperty(globalThis, 'EventSource', {
      configurable: true,
      value: BrowserEventSource,
    });
    const browserSource = createRuntimeEventSource('/events', {}, { withCredentials: true });
    expect(browserSource).toBeInstanceOf(BrowserEventSource);
    expect(browserSource).toMatchObject({ url: '/events', options: { withCredentials: true } });

    Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: FakeXhr });
    expect(createRuntimeEventSource('/events')).toBeInstanceOf(NativeEventSource);
  } finally {
    if (previousEventSource) Object.defineProperty(globalThis, 'EventSource', previousEventSource);
    else Reflect.deleteProperty(globalThis, 'EventSource');
    if (previousXhr) Object.defineProperty(globalThis, 'XMLHttpRequest', previousXhr);
    else Reflect.deleteProperty(globalThis, 'XMLHttpRequest');
  }
});

class FakeEventSource implements RealtimeEventSource {
  onerror: ((event: unknown) => void) | null = null;
  onopen: (() => void) | null = null;
  status?: number;
  private readonly listeners = new Map<string, (event: unknown) => void>();
  closed = false;

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: unknown): void {
    this.listeners.get(type)?.(event);
  }
}

test('realtime client sends authenticated messages and decodes SSE events', async () => {
  const fetchImpl = jest.fn(
    async () =>
      new Response(
        JSON.stringify({
          event: {
            eventId: 4,
            type: 'message',
            occurredAt: '2026-09-13T00:00:00.000Z',
            message: {
              id: 'message-4',
              groupId: 'demo-group',
              memberId: 'demo-1',
              body: 'hello',
              createdAt: '2026-09-13T00:00:00.000Z',
            },
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
  );
  const source = new FakeEventSource();
  const factory = jest.fn<RealtimeEventSource, [string]>(() => source);
  const client = new RealtimeChatClient('http://127.0.0.1:8787', fetchImpl, {
    eventSourceFactory: factory,
  });
  const sent = await client.sendMessage('session-1', 'demo-group', 'hello');
  expect(sent.message.body).toBe('hello');
  expect(fetchImpl).toHaveBeenCalledWith(
    'http://127.0.0.1:8787/realtime/groups/demo-group/messages',
    expect.objectContaining({ method: 'POST' }),
  );

  const received: string[] = [];
  const subscription = client.subscribe('session-1', 'demo-group', {
    sinceEventId: 3,
    onEvent: (event) => received.push(event.message.body),
  });
  expect(factory).toHaveBeenCalledWith(
    'http://127.0.0.1:8787/realtime/groups/demo-group/events?sinceEventId=3',
  );
  source.emit('message', { data: JSON.stringify(sent) });
  expect(received).toEqual(['hello']);
  subscription.close();
  expect(source.closed).toBe(true);
});

test('realtime subscriptions accept the same-origin API prefix', () => {
  const client = new RealtimeChatClient('/api', fetch, {
    eventSourceFactory: () => new FakeEventSource(),
  });

  expect(client.baseUrl).toBe('/api');
});

test('reconnects from the last event without leaking another group', async () => {
  const first = new FakeEventSource();
  const second = new FakeEventSource();
  const sources = [first, second];
  const factory = jest.fn<RealtimeEventSource, [string]>(() => sources.shift()!);
  const states: RealtimeConnectionState[] = [];
  const received: string[] = [];
  const client = new RealtimeChatClient('http://127.0.0.1:8787', fetch, {
    eventSourceFactory: factory,
    reconnectDelayMs: 0,
  });
  const subscription = client.subscribe('session-1', 'demo-group', {
    onEvent: (event) => received.push(event.message.body),
    onConnectionStateChange: (state) => states.push(state),
  });
  first.onopen?.();
  first.emit('message', {
    data: JSON.stringify({
      eventId: 4,
      type: 'message',
      occurredAt: '2026-09-13T00:00:00.000Z',
      message: {
        id: 'm4',
        groupId: 'demo-group',
        memberId: 'demo-1',
        body: 'before',
        createdAt: '',
      },
    }),
  });
  first.onerror?.({});
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(factory).toHaveBeenCalledTimes(2);
  expect(factory.mock.calls[1][0]).toMatch(/[?&]sinceEventId=4/);
  second.onopen?.();
  second.emit('message', {
    data: JSON.stringify({
      eventId: 5,
      type: 'message',
      occurredAt: '2026-09-13T00:00:00.000Z',
      message: {
        id: 'm5',
        groupId: 'other-group',
        memberId: 'demo-1',
        body: 'wrong',
        createdAt: '',
      },
    }),
  });
  second.emit('message', {
    data: JSON.stringify({
      eventId: 5,
      type: 'message',
      occurredAt: '2026-09-13T00:00:00.000Z',
      message: {
        id: 'm5',
        groupId: 'demo-group',
        memberId: 'demo-1',
        body: 'after',
        createdAt: '',
      },
    }),
  });
  expect(received).toEqual(['before', 'after']);
  expect(states).toEqual(['connecting', 'connected', 'disconnected', 'reconnecting', 'connected']);
  subscription.close();
});

test('starts a new observer at the persisted high-water mark and reconnects from its checkpoint', async () => {
  const first = new FakeEventSource();
  const second = new FakeEventSource();
  const sources = [first, second];
  const factory = jest.fn<RealtimeEventSource, [string]>(() => sources.shift()!);
  const received: number[] = [];
  const checkpoints: number[] = [];
  const client = new RealtimeChatClient('http://127.0.0.1:8787', fetch, {
    eventSourceFactory: factory,
    reconnectDelayMs: 0,
  });
  const subscription = client.subscribe('session-1', 'demo-group', {
    startFromLatest: true,
    onEvent: (event) => received.push(event.eventId),
    onCheckpoint: (eventId) => checkpoints.push(eventId),
  });

  expect(factory.mock.calls[0][0]).toMatch(/[?&]startFromLatest=true/);
  first.emit('checkpoint', { data: JSON.stringify({ eventId: 21 }) });
  expect(received).toEqual([]);
  expect(checkpoints).toEqual([21]);

  first.onerror?.({});
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(factory.mock.calls[1][0]).toMatch(/[?&]sinceEventId=21/);
  second.emit('message', {
    data: JSON.stringify({
      eventId: 22,
      type: 'message',
      occurredAt: '2026-09-13T00:00:00.000Z',
      message: {
        id: 'm22',
        groupId: 'demo-group',
        memberId: 'demo-2',
        body: 'new message',
        createdAt: '',
      },
    }),
  });
  expect(received).toEqual([22]);
  subscription.close();
});

test('forwards and resumes from a valid zero checkpoint', async () => {
  const first = new FakeEventSource();
  const second = new FakeEventSource();
  const sources = [first, second];
  const factory = jest.fn<RealtimeEventSource, [string]>(() => sources.shift()!);
  const checkpoints: number[] = [];
  const client = new RealtimeChatClient('http://127.0.0.1:8787', fetch, {
    eventSourceFactory: factory,
    reconnectDelayMs: 0,
  });
  const subscription = client.subscribe('session-1', 'demo-group', {
    startFromLatest: true,
    onEvent: () => undefined,
    onCheckpoint: (eventId) => checkpoints.push(eventId),
  });

  first.emit('checkpoint', { data: JSON.stringify({ eventId: 0 }) });
  expect(checkpoints).toEqual([0]);
  first.onerror?.({});
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(factory.mock.calls[1][0]).toMatch(/[?&]sinceEventId=0/);
  expect(factory.mock.calls[1][0]).not.toMatch(/[?&]startFromLatest=true/);
  subscription.close();
});

test('requests and decodes metadata-only unread events', () => {
  const source = new FakeEventSource();
  const factory = jest.fn<RealtimeEventSource, [string]>(() => source);
  const client = new RealtimeChatClient('http://127.0.0.1:8787', fetch, {
    eventSourceFactory: factory,
  });
  const received: unknown[] = [];
  const subscription = client.subscribe('session-1', 'demo-group', {
    startFromLatest: true,
    metadataOnly: true,
    onEvent: (event) => received.push(event),
  });

  expect(factory.mock.calls[0][0]).toMatch(/[?&]startFromLatest=true&metadataOnly=true/);
  source.emit('message', {
    data: JSON.stringify({
      eventId: 4,
      type: 'message',
      message: { groupId: 'demo-group', memberId: 'demo-2' },
    }),
  });
  expect(received).toEqual([
    {
      eventId: 4,
      type: 'message',
      message: { groupId: 'demo-group', memberId: 'demo-2' },
    },
  ]);
  subscription.close();
});

test('keeps the latest-watermark handshake on reconnect until its checkpoint arrives', async () => {
  const first = new FakeEventSource();
  const second = new FakeEventSource();
  const sources = [first, second];
  const factory = jest.fn<RealtimeEventSource, [string]>(() => sources.shift()!);
  const client = new RealtimeChatClient('http://127.0.0.1:8787', fetch, {
    eventSourceFactory: factory,
    reconnectDelayMs: 0,
  });
  const subscription = client.subscribe('session-1', 'demo-group', {
    startFromLatest: true,
    onEvent: () => undefined,
  });

  first.onerror?.({});
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(factory).toHaveBeenCalledTimes(2);
  expect(factory.mock.calls[1][0]).toMatch(/[?&]startFromLatest=true/);
  expect(factory.mock.calls[1][0]).not.toMatch(/[?&]sinceEventId=0/);

  second.emit('checkpoint', { data: JSON.stringify({ eventId: 21 }) });
  subscription.close();
});

test('access denial stops reconnecting and exposes a denied state', () => {
  const source = new FakeEventSource();
  source.status = 403;
  const onError = jest.fn();
  const states: RealtimeConnectionState[] = [];
  const factory = jest.fn<RealtimeEventSource, [string]>(() => source);
  const client = new RealtimeChatClient('http://127.0.0.1:8787', fetch, {
    eventSourceFactory: factory,
    reconnectDelayMs: 0,
  });
  const subscription = client.subscribe('session-1', 'demo-group', {
    onEvent: () => undefined,
    onError,
    onConnectionStateChange: (state) => states.push(state),
  });
  source.emit('access-denied', { data: 'not valid JSON but still terminal' });
  expect(factory).toHaveBeenCalledTimes(1);
  expect(subscription.state).toBe('denied');
  expect(states).toEqual(['connecting', 'denied']);
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ status: 403, code: 'forbidden' }));
});

test('send failures retain a draft id for an explicit retry', async () => {
  const fetchImpl = jest
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          event: {
            eventId: 4,
            type: 'message',
            occurredAt: '2026-09-13T00:00:00.000Z',
            message: {
              id: 'draft-1',
              groupId: 'demo-group',
              memberId: 'demo-1',
              body: 'keep me',
              createdAt: '',
            },
          },
        }),
        { status: 201 },
      ),
    );
  const client = new RealtimeChatClient('http://127.0.0.1:8787', fetchImpl);
  const draft = client.createDraft('keep me');
  await expect(client.sendMessage('session-1', 'demo-group', draft)).rejects.toMatchObject({
    code: 'network_error',
    messageId: draft.messageId,
  });
  await client.retryMessage('session-1', 'demo-group', draft);
  expect(JSON.parse(fetchImpl.mock.calls[0][1].body as string).messageId).toBe(draft.messageId);
  expect(JSON.parse(fetchImpl.mock.calls[1][1].body as string).messageId).toBe(draft.messageId);
});

test('bounds a direct chat send, aborts fetch, and preserves its retry identity', async () => {
  jest.useFakeTimers();
  try {
    let requestInit: RequestInit | undefined;
    const fetchImpl = jest.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestInit = init;
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const client = new RealtimeChatClient('http://127.0.0.1:8787', fetchImpl, {
      sendTimeoutMs: 25,
    });
    const draft = client.createDraft('response may be lost');
    const request = client.sendMessage('session-1', 'demo-group', draft);
    const rejection = expect(request).rejects.toMatchObject({
      code: 'send_timeout',
      messageId: draft.messageId,
    });
    await jest.advanceTimersByTimeAsync(25);
    await rejection;
    expect(requestInit?.signal).toBeDefined();
    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string).messageId).toBe(
      draft.messageId,
    );
  } finally {
    jest.useRealTimers();
  }
});

describe('reaction updates', () => {
  const update = (overrides: Record<string, unknown> = {}) => ({
    type: 'reaction',
    groupId: 'demo-group',
    messageId: 'm1',
    reactionCounts: { '✨': 2 },
    revision: 10,
    occurredAt: '2026-09-13T00:00:00.000Z',
    ...overrides,
  });

  test('delivers reaction events without moving the message cursor and quietly drops malformed or foreign ones', async () => {
    const first = new FakeEventSource();
    const second = new FakeEventSource();
    const sources = [first, second];
    const factory = jest.fn<RealtimeEventSource, [string]>(() => sources.shift()!);
    const updates: unknown[] = [];
    const errors: unknown[] = [];
    const messages: number[] = [];
    const connected: boolean[] = [];
    const client = new RealtimeChatClient('http://127.0.0.1:8787', fetch, {
      eventSourceFactory: factory,
      reconnectDelayMs: 0,
    });
    const subscription = client.subscribe('session-1', 'demo-group', {
      sinceEventId: 4,
      onEvent: (event) => messages.push(event.eventId),
      onReactionUpdate: (next) => updates.push(next),
      onConnected: ({ reconnect }) => connected.push(reconnect),
      onError: (error) => errors.push(error),
    });
    first.onopen?.();
    first.emit('reaction', { data: JSON.stringify(update()) });
    first.emit('reaction', { data: JSON.stringify(update({ groupId: 'other-group' })) });
    first.emit('reaction', { data: JSON.stringify(update({ revision: 'x' })) });
    first.emit('reaction', { data: JSON.stringify(update({ reactionCounts: { '✨': -1 } })) });
    expect(updates).toEqual([
      {
        type: 'reaction',
        groupId: 'demo-group',
        messageId: 'm1',
        reactionCounts: { '✨': 2 },
        revision: 10,
        occurredAt: '2026-09-13T00:00:00.000Z',
      },
    ]);
    // Advisory frames are dropped quietly rather than failing the chat.
    expect(errors).toHaveLength(0);
    expect(messages).toEqual([]);

    // A reconnect resumes from the unchanged message cursor and says it is a reconnect.
    first.onerror?.({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(factory.mock.calls[1][0]).toMatch(/[?&]sinceEventId=4$/);
    second.onopen?.();
    expect(connected).toEqual([false, true]);
    subscription.close();
  });

  test('metadata-only unread streams never listen for reactions', () => {
    const source = new FakeEventSource();
    const add = jest.spyOn(source, 'addEventListener');
    const client = new RealtimeChatClient('http://127.0.0.1:8787', fetch, {
      eventSourceFactory: () => source,
    });
    const onReactionUpdate = jest.fn();
    const subscription = client.subscribe('session-1', 'demo-group', {
      metadataOnly: true,
      startFromLatest: true,
      onEvent: jest.fn(),
      onReactionUpdate,
    });
    expect(add.mock.calls.map(([type]) => type)).not.toContain('reaction');
    source.emit('reaction', { data: JSON.stringify(update()) });
    expect(onReactionUpdate).not.toHaveBeenCalled();
    subscription.close();
  });

  test('reads a reaction snapshot and the toggle revision', async () => {
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/reaction-counts')
        ? new Response(
            JSON.stringify({
              revision: 12,
              messages: [{ messageId: 'm1', reactionCounts: { '✨': 1 } }],
            }),
          )
        : new Response(
            JSON.stringify({
              reaction: { messageId: 'm1', groupId: 'demo-group', active: true, count: 1 },
              message: { id: 'm1', reactionCounts: { '✨': 1 } },
              reactionRevision: 11,
            }),
          ),
    );
    const client = new RealtimeChatClient('http://127.0.0.1:8787', fetchImpl);
    await expect(client.getReactionSnapshot('s', 'demo-group', ['m1'])).resolves.toEqual({
      revision: 12,
      messages: [{ messageId: 'm1', reactionCounts: { '✨': 1 } }],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/realtime/groups/demo-group/reaction-counts',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ messageIds: ['m1'] }) }),
    );
    await expect(client.toggleReaction('s', 'demo-group', 'm1')).resolves.toMatchObject({
      reactionRevision: 11,
    });
    const denied = new RealtimeChatClient(
      'http://127.0.0.1:8787',
      jest.fn(async () => new Response('{}', { status: 403 })),
    );
    await expect(denied.getReactionSnapshot('s', 'demo-group', ['m1'])).rejects.toMatchObject({
      status: 403,
    });
  });
});

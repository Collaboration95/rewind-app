import {
  RealtimeChatClient,
  type RealtimeEventSource,
  type RealtimeConnectionState,
} from '../src/chat';

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
  const factory = jest.fn(() => source);
  const client = new RealtimeChatClient('http://127.0.0.1:8787', fetchImpl, {
    eventSourceFactory: factory,
  });
  const sent = await client.sendMessage('session-1', 'demo-group', 'hello');
  expect(sent.message.body).toBe('hello');
  expect(fetchImpl).toHaveBeenCalledWith(
    'http://127.0.0.1:8787/realtime/groups/demo-group/messages?sessionId=session-1',
    expect.objectContaining({ method: 'POST' }),
  );

  const received: string[] = [];
  const subscription = client.subscribe('session-1', 'demo-group', {
    sinceEventId: 3,
    onEvent: (event) => received.push(event.message.body),
  });
  expect(factory).toHaveBeenCalledWith(
    'http://127.0.0.1:8787/realtime/groups/demo-group/events?sessionId=session-1&sinceEventId=3',
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
  expect(factory.mock.calls[1][0]).toContain('&sinceEventId=4');
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

  expect(factory.mock.calls[0][0]).toContain('&startFromLatest=true');
  first.emit('checkpoint', { data: JSON.stringify({ eventId: 21 }) });
  expect(received).toEqual([]);
  expect(checkpoints).toEqual([21]);

  first.onerror?.({});
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(factory.mock.calls[1][0]).toContain('&sinceEventId=21');
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

  expect(factory.mock.calls[1][0]).toContain('&sinceEventId=0');
  expect(factory.mock.calls[1][0]).not.toContain('&startFromLatest=true');
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
  expect(factory.mock.calls[1][0]).toContain('&startFromLatest=true');
  expect(factory.mock.calls[1][0]).not.toContain('&sinceEventId=0');

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

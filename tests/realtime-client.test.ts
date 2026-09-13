import { RealtimeChatClient, type RealtimeEventSource } from '../src/chat';

class FakeEventSource implements RealtimeEventSource {
  onerror: ((event: unknown) => void) | null = null;
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

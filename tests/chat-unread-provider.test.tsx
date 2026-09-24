import { act, render, waitFor } from '@testing-library/react-native';
import { Text, View } from 'react-native';

import { ChatUnreadProvider, useChatUnread } from '../src/chat/ChatUnreadProvider';
import type { RealtimeConnectionState, SubscribeOptions } from '../src/chat/realtime-client';
import type { DemoSession } from '../src/domain/session';
import type { RuntimeClient } from '../src/runtime/local-runtime-client';

const sessionA: DemoSession = {
  id: 'session-a',
  accessKind: 'demo',
  actor: { memberId: 'demo-1', displayName: 'Amber', isSynthetic: true },
  groupId: 'demo-group',
  startedAt: '2026-09-13T00:00:00.000Z',
  expiresAt: '2026-09-14T00:00:00.000Z',
  invalidatedAt: null,
};

const sessionB: DemoSession = { ...sessionA, id: 'session-b', groupId: 'other-group' };

interface Subscription {
  options: SubscribeOptions;
  close: jest.Mock;
}

/**
 * The provider owns an always-on stream independent of ChatScreen. These tests
 * drive that stream directly instead of mounting App, so the first patch can be
 * verified before any App.tsx integration.
 */
function runtimeMock() {
  const subscriptions: Subscription[] = [];
  const subscribeChat = jest.fn(
    (_sessionId: string, _groupId: string, options: SubscribeOptions) => {
      const close = jest.fn();
      subscriptions.push({ close, options });
      return { close, state: 'connecting' as RealtimeConnectionState };
    },
  );
  const client: RuntimeClient = {
    baseUrl: 'http://localhost:8787',
    getHealth: jest.fn(),
    getGroupForMember: jest.fn(),
    getCurrentCycle: jest.fn(),
    advanceDemoCycle: jest.fn(),
    subscribeChat,
  };
  return {
    client,
    subscribeChat,
    subscriptions,
    latest: () => subscriptions[subscriptions.length - 1],
  };
}

function message(eventId: number, memberId: string) {
  return {
    eventId,
    type: 'message' as const,
    occurredAt: '2026-09-13T01:00:00.000Z',
    message: {
      id: 'message-' + eventId,
      groupId: 'demo-group',
      memberId,
      body: 'Body for event ' + eventId,
      createdAt: '2026-09-13T01:00:00.000Z',
    },
  };
}

function Probe() {
  const { connectionState, unreadCount, markRead } = useChatUnread();
  return (
    <View>
      <Text testID="unread">{String(unreadCount)}</Text>
      <Text testID="connection">{connectionState}</Text>
      <Text onPress={markRead} testID="mark-read">
        read
      </Text>
    </View>
  );
}

function renderOwner(
  {
    activeGroupId = null,
    runtimeClient,
    session = sessionA,
  }: {
    activeGroupId?: string | null;
    runtimeClient: RuntimeClient | null;
    session?: DemoSession | null;
  } = { runtimeClient: null },
) {
  return render(
    <ChatUnreadProvider
      activeGroupId={activeGroupId}
      runtimeClient={runtimeClient}
      session={session}
    >
      <Probe />
    </ChatUnreadProvider>,
  );
}

describe('ChatUnreadProvider', () => {
  it('opens exactly one always-on stream for the session group scope', async () => {
    const runtime = runtimeMock();
    const result = await renderOwner({ runtimeClient: runtime.client });
    await result.findByTestId('unread');

    expect(runtime.subscribeChat).toHaveBeenCalledTimes(1);
    expect(runtime.subscribeChat.mock.calls[0][0]).toBe('session-a');
    expect(runtime.subscribeChat.mock.calls[0][1]).toBe('demo-group');
    expect(runtime.subscribeChat.mock.calls[0][2].startFromLatest).toBe(true);
  });

  it('counts an off-tab message and does not resubscribe when chat becomes visible', async () => {
    const runtime = runtimeMock();
    const result = await renderOwner({ runtimeClient: runtime.client });
    await result.findByTestId('unread');

    await act(async () => runtime.latest().options.onEvent(message(7, 'demo-2')));
    expect(result.getByTestId('unread')).toHaveTextContent('1');

    // Opening the chat must not tear down and rebuild the always-on stream.
    await act(async () =>
      result.rerender(
        <ChatUnreadProvider
          activeGroupId="demo-group"
          runtimeClient={runtime.client}
          session={sessionA}
        >
          <Probe />
        </ChatUnreadProvider>,
      ),
    );
    expect(runtime.subscribeChat).toHaveBeenCalledTimes(1);
  });

  it('does not count a message while its own group is the visible chat', async () => {
    const runtime = runtimeMock();
    const result = await renderOwner({
      activeGroupId: 'demo-group',
      runtimeClient: runtime.client,
    });
    await result.findByTestId('unread');

    await act(async () => runtime.latest().options.onEvent(message(9, 'demo-2')));
    expect(result.getByTestId('unread')).toHaveTextContent('0');
  });

  it('counts an event arriving mid-flight of opening the chat from another tab', async () => {
    const runtime = runtimeMock();
    const result = await renderOwner({ runtimeClient: runtime.client });
    await result.findByTestId('unread');
    await act(async () => runtime.latest().options.onEvent(message(3, 'demo-2')));
    expect(result.getByTestId('unread')).toHaveTextContent('1');

    await act(async () =>
      result.rerender(
        <ChatUnreadProvider
          activeGroupId="demo-group"
          runtimeClient={runtime.client}
          session={sessionA}
        >
          <Probe />
        </ChatUnreadProvider>,
      ),
    );
    // A second event is visible, so it is read rather than counted.
    await act(async () => runtime.latest().options.onEvent(message(4, 'demo-2')));
    expect(result.getByTestId('unread')).toHaveTextContent('0');
  });

  it("never counts the acting member's own message", async () => {
    const runtime = runtimeMock();
    const result = await renderOwner({ runtimeClient: runtime.client });
    await result.findByTestId('unread');

    await act(async () => runtime.latest().options.onEvent(message(5, 'demo-1')));
    expect(result.getByTestId('unread')).toHaveTextContent('0');
  });

  it('holds no message text in provider state', async () => {
    const runtime = runtimeMock();
    const result = await renderOwner({ runtimeClient: runtime.client });
    await result.findByTestId('unread');
    await act(async () => runtime.latest().options.onEvent(message(8, 'demo-2')));

    const serialized = JSON.stringify(result.toJSON());
    expect(serialized).not.toContain('Body for event 8');
    expect(result.getByTestId('unread')).toHaveTextContent('1');
  });

  it('keeps a stable count across a reconnect replay of the same event id', async () => {
    const runtime = runtimeMock();
    const result = await renderOwner({ runtimeClient: runtime.client });
    await result.findByTestId('unread');

    await act(async () => runtime.latest().options.onEvent(message(7, 'demo-2')));
    expect(result.getByTestId('unread')).toHaveTextContent('1');

    await act(async () => {
      runtime.latest().options.onConnectionStateChange?.('reconnecting');
      runtime.latest().options.onConnectionStateChange?.('connected');
    });
    // The stream reopens and the server replays event 7 before anything new.
    await act(async () => runtime.latest().options.onEvent(message(7, 'demo-2')));
    expect(result.getByTestId('unread')).toHaveTextContent('1');

    // A genuinely new event still counts.
    await act(async () => runtime.latest().options.onEvent(message(10, 'demo-2')));
    expect(result.getByTestId('unread')).toHaveTextContent('2');
  });

  it('exposes explicit connecting, reconnecting, and connected lifecycle states', async () => {
    const runtime = runtimeMock();
    const result = await renderOwner({ runtimeClient: runtime.client });
    await result.findByTestId('unread');

    expect(result.getByTestId('connection')).toHaveTextContent('connecting');

    await act(async () => {
      runtime.latest().options.onConnectionStateChange?.('connected');
    });
    expect(result.getByTestId('connection')).toHaveTextContent('connected');

    await act(async () => runtime.latest().options.onConnectionStateChange?.('disconnected'));
    expect(result.getByTestId('connection')).toHaveTextContent('reconnecting');

    await act(async () => runtime.latest().options.onConnectionStateChange?.('reconnecting'));
    expect(result.getByTestId('connection')).toHaveTextContent('reconnecting');

    await act(async () => runtime.latest().options.onConnectionStateChange?.('connected'));
    expect(result.getByTestId('connection')).toHaveTextContent('connected');
  });

  it('reports offline while the browser is offline and recovers afterwards', async () => {
    const runtime = runtimeMock();
    const previousOnline = navigator.onLine;
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    try {
      const result = await renderOwner({ runtimeClient: runtime.client });
      await result.findByTestId('unread');
      expect(result.getByTestId('connection')).toHaveTextContent('offline');
    } finally {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: previousOnline });
    }
  });

  it('reports unavailable when no realtime transport exists', async () => {
    const result = await renderOwner({ runtimeClient: null });
    expect(result.getByTestId('connection')).toHaveTextContent('unavailable');
    expect(result.getByTestId('unread')).toHaveTextContent('0');
  });

  it('ends the stream and returns to a zero count on sign-out', async () => {
    const runtime = runtimeMock();
    const result = await renderOwner({ runtimeClient: runtime.client });
    await result.findByTestId('unread');
    await act(async () => runtime.latest().options.onEvent(message(6, 'demo-2')));
    expect(result.getByTestId('unread')).toHaveTextContent('1');

    await act(async () =>
      result.rerender(
        <ChatUnreadProvider activeGroupId={null} runtimeClient={runtime.client} session={null}>
          <Probe />
        </ChatUnreadProvider>,
      ),
    );
    expect(result.getByTestId('unread')).toHaveTextContent('0');
    expect(result.getByTestId('connection')).toHaveTextContent('unavailable');
    expect(runtime.latest().close).toHaveBeenCalled();
  });

  it('clears the count and rebinds the stream when the group scope changes', async () => {
    const runtime = runtimeMock();
    const result = await renderOwner({ runtimeClient: runtime.client });
    await result.findByTestId('unread');
    await act(async () => runtime.latest().options.onEvent(message(6, 'demo-2')));
    expect(result.getByTestId('unread')).toHaveTextContent('1');

    await act(async () =>
      result.rerender(
        <ChatUnreadProvider activeGroupId={null} runtimeClient={runtime.client} session={sessionB}>
          <Probe />
        </ChatUnreadProvider>,
      ),
    );
    expect(result.getByTestId('unread')).toHaveTextContent('0');
    await waitFor(() => expect(runtime.subscribeChat).toHaveBeenCalledTimes(2));
    expect(runtime.subscribeChat.mock.calls[1][1]).toBe('other-group');
    expect(runtime.subscribeChat.mock.calls[0][2].onEvent).toBeDefined();
  });

  it('keeps the scope watermark through a temporary group lookup refresh', async () => {
    const runtime = runtimeMock();
    const result = await renderOwner({ runtimeClient: runtime.client });
    await result.findByTestId('unread');
    await act(async () => runtime.latest().options.onEvent(message(6, 'demo-2')));
    expect(result.getByTestId('unread')).toHaveTextContent('1');

    await act(async () =>
      result.rerender(
        <ChatUnreadProvider
          activeGroupId={null}
          enabled={false}
          runtimeClient={runtime.client}
          session={sessionA}
        >
          <Probe />
        </ChatUnreadProvider>,
      ),
    );
    expect(runtime.latest().close).toHaveBeenCalled();
    expect(result.getByTestId('unread')).toHaveTextContent('1');

    await act(async () =>
      result.rerender(
        <ChatUnreadProvider activeGroupId={null} runtimeClient={runtime.client} session={sessionA}>
          <Probe />
        </ChatUnreadProvider>,
      ),
    );
    expect(runtime.subscribeChat).toHaveBeenCalledTimes(2);
    expect(runtime.subscribeChat.mock.calls[1][2].sinceEventId).toBe(6);
    await act(async () => runtime.latest().options.onEvent(message(6, 'demo-2')));
    expect(result.getByTestId('unread')).toHaveTextContent('1');
  });

  it('replays the gap from a zero checkpoint when the stream is replaced before a message', async () => {
    const runtime = runtimeMock();
    const result = await renderOwner({ runtimeClient: runtime.client });
    await result.findByTestId('unread');

    await act(async () => runtime.latest().options.onCheckpoint?.(0));
    expect(result.getByTestId('unread')).toHaveTextContent('0');

    await act(async () =>
      result.rerender(
        <ChatUnreadProvider
          activeGroupId={null}
          enabled={false}
          runtimeClient={runtime.client}
          session={sessionA}
        >
          <Probe />
        </ChatUnreadProvider>,
      ),
    );
    expect(runtime.latest().close).toHaveBeenCalled();

    await act(async () =>
      result.rerender(
        <ChatUnreadProvider activeGroupId={null} runtimeClient={runtime.client} session={sessionA}>
          <Probe />
        </ChatUnreadProvider>,
      ),
    );
    expect(runtime.subscribeChat).toHaveBeenCalledTimes(2);
    expect(runtime.latest().options.sinceEventId).toBe(0);

    await act(async () => runtime.latest().options.onEvent(message(1, 'demo-2')));
    expect(result.getByTestId('unread')).toHaveTextContent('1');
    await act(async () => runtime.latest().options.onEvent(message(1, 'demo-2')));
    expect(result.getByTestId('unread')).toHaveTextContent('1');
  });

  it('marks the current scope read on demand', async () => {
    const runtime = runtimeMock();
    const result = await renderOwner({ runtimeClient: runtime.client });
    await result.findByTestId('unread');
    await act(async () => runtime.latest().options.onEvent(message(6, 'demo-2')));
    await act(async () => runtime.latest().options.onEvent(message(7, 'demo-2')));
    expect(result.getByTestId('unread')).toHaveTextContent('2');

    await act(async () => result.getByTestId('mark-read').props.onPress());
    expect(result.getByTestId('unread')).toHaveTextContent('0');
  });

  it('marks denial explicitly and stops counting', async () => {
    const runtime = runtimeMock();
    const result = await renderOwner({ runtimeClient: runtime.client });
    await result.findByTestId('unread');
    await act(async () => runtime.latest().options.onEvent(message(11, 'demo-2')));
    expect(result.getByTestId('unread')).toHaveTextContent('1');

    await act(async () => runtime.latest().options.onConnectionStateChange?.('denied'));
    expect(result.getByTestId('connection')).toHaveTextContent('denied');
    // Revoked access clears the indicator and ignores any later delivery.
    expect(result.getByTestId('unread')).toHaveTextContent('0');

    await act(async () => runtime.latest().options.onEvent(message(12, 'demo-2')));
    expect(result.getByTestId('unread')).toHaveTextContent('0');
  });
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ComponentProps } from 'react';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import App from '../App';
import { ChatSessionSurface } from '../src/chat/ChatScreen';
import type { Cycle } from '../src/domain/cycles';
import type { Group, MembershipDenied } from '../src/domain/profiles';
import type { DemoSession } from '../src/domain/session';
import type { ChatMessageEvent, SubscribeOptions } from '../src/chat';
import type { RuntimeClient } from '../src/runtime/local-runtime-client';

let mockNetworkListener:
  ((state: { isConnected: boolean; isInternetReachable: boolean }) => void) | null;

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);
jest.mock('expo-network', () => ({
  addNetworkStateListener: (listener: typeof mockNetworkListener) => {
    mockNetworkListener = listener;
    return { remove: jest.fn() };
  },
  getNetworkStateAsync: jest
    .fn()
    .mockResolvedValue({ isConnected: true, isInternetReachable: true }),
}));

const group: Group = {
  id: 'demo-group',
  name: 'Weekend People',
  memberIds: ['demo-1', 'demo-2'],
  currentCycleId: 'demo-cycle',
};

const cycle: Cycle = {
  id: 'demo-cycle',
  groupId: 'demo-group',
  prompt: 'Prompt',
  startsAt: '2026-09-13T00:00:00.000Z',
  endsAt: '2026-09-14T00:00:00.000Z',
  status: 'collecting',
  lockState: 'locked',
  quota: { maxCount: 5, maxSeconds: 30 },
  contributionUsage: { countUsed: 0, secondsUsed: 0 },
};

const sessionA: DemoSession = {
  id: 'session-a',
  accessKind: 'demo',
  actor: { memberId: 'demo-1', displayName: 'Amber', isSynthetic: true },
  groupId: 'demo-group',
  startedAt: '2026-09-13T00:00:00.000Z',
  expiresAt: '2026-09-14T00:00:00.000Z',
  invalidatedAt: null,
};

const sessionB: DemoSession = {
  ...sessionA,
  id: 'session-b',
  groupId: 'other-group',
};

const otherGroup: Group = {
  ...group,
  id: 'other-group',
  name: 'Other People',
};

const memberNames = new Map([
  ['demo-1', 'Amber'],
  ['demo-2', 'Birch'],
]);

function event(
  eventId: number,
  body: string,
  createdAt: string,
  memberId = 'demo-1',
): ChatMessageEvent {
  return {
    eventId,
    type: 'message',
    occurredAt: createdAt,
    message: {
      id: `message-${eventId}`,
      groupId: 'demo-group',
      memberId,
      body,
      createdAt,
    },
  };
}

function runtimeMock(overrides: Partial<RuntimeClient> = {}) {
  let subscriptionOptions: SubscribeOptions | undefined;
  const client: RuntimeClient = {
    baseUrl: 'http://localhost:8787',
    getHealth: jest.fn().mockResolvedValue({
      ok: true,
      service: 'rewind-local-runtime',
      version: 'test',
      ready: true,
      checks: { sqlite: true, ffmpegConfigured: true },
      addresses: { local: 'http://localhost:8787', lan: null },
    }),
    getGroupForMember: jest.fn().mockResolvedValue(group),
    getCurrentCycle: jest.fn().mockResolvedValue(cycle),
    advanceDemoCycle: jest.fn(),
    subscribeChat: jest.fn((_sessionId, _groupId, options) => {
      subscriptionOptions = options;
      return { close: jest.fn(), state: 'connected' as const };
    }),
    sendChatMessage: jest
      .fn()
      .mockResolvedValue(event(3, 'Sent from the composer', '2026-09-13T03:00:00.000Z')),
    ...overrides,
  };
  return {
    client,
    emit: (next: ChatMessageEvent) => subscriptionOptions?.onEvent(next),
    fail: (error: unknown) => subscriptionOptions?.onError?.(error),
    deny: () => subscriptionOptions?.onConnectionStateChange?.('denied'),
    connect: () => subscriptionOptions?.onConnectionStateChange?.('connected'),
    reconnect: () => subscriptionOptions?.onConnectionStateChange?.('reconnecting'),
  };
}

function ScopedChatSurface({
  scope,
  ...props
}: ComponentProps<typeof ChatSessionSurface> & { scope: string }) {
  return <ChatSessionSurface key={scope} {...props} />;
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('persistent group chat timeline', () => {
  it('shows connecting, connected, and reconnecting connection states', async () => {
    const runtime = runtimeMock();
    const result = await render(
      <ScopedChatSurface
        accessState="known"
        capsuleStatus="ready"
        group={group}
        scope="session-a:demo-group"
        memberNames={memberNames}
        retryCapsule={jest.fn()}
        runtimeClient={runtime.client}
        session={sessionA}
      />,
    );
    expect(result.getByTestId('chat-connection-status')).toHaveTextContent(
      'Chat connection: Connecting…',
    );
    await result.findByTestId('chat-empty');

    await act(async () => runtime.connect());
    expect(result.getByTestId('chat-connection-status')).toHaveTextContent(
      'Chat connection: Connected',
    );

    await act(async () => runtime.reconnect());
    expect(result.getByTestId('chat-connection-status')).toHaveTextContent(
      'Chat connection: Reconnecting…',
    );

    await act(async () => runtime.connect());
    expect(result.getByTestId('chat-connection-status')).toHaveTextContent(
      'Chat connection: Connected',
    );
  });

  it('shows offline and online when native reachability changes', async () => {
    const runtime = runtimeMock();
    const result = await render(
      <ScopedChatSurface
        accessState="known"
        capsuleStatus="ready"
        group={group}
        scope="session-a:demo-group"
        memberNames={memberNames}
        retryCapsule={jest.fn()}
        runtimeClient={runtime.client}
        session={sessionA}
      />,
    );
    await result.findByTestId('chat-empty');
    await act(async () =>
      mockNetworkListener?.({ isConnected: false, isInternetReachable: false }),
    );
    expect(result.getByTestId('chat-connection-status')).toHaveTextContent(
      'Chat connection: Offline',
    );
    await act(async () => mockNetworkListener?.({ isConnected: true, isInternetReachable: true }));
    expect(result.getByTestId('chat-connection-status')).toHaveTextContent(
      'Chat connection: Connecting…',
    );
  });

  it('renders persisted events in event order and sends text through the runtime', async () => {
    const runtime = runtimeMock();
    const result = await render(<App runtimeClient={runtime.client} />);
    await fireEvent.press(await result.findByRole('tab', { name: 'Chat' }));
    await result.findByTestId('chat-empty');

    await act(async () => {
      runtime.emit(event(2, 'Second message', '2026-09-13T01:00:00.000Z', 'demo-2'));
      runtime.emit(event(1, 'First message', '2026-09-13T02:00:00.000Z'));
    });
    await waitFor(() => expect(result.getAllByTestId('chat-message')).toHaveLength(2));
    expect(result.getByText('First message')).toBeTruthy();
    expect(result.getByText('Second message')).toBeTruthy();
    expect(result.getAllByTestId('chat-message')[0]).toHaveTextContent(/First message/);

    await act(async () => fireEvent.changeText(result.getByTestId('chat-composer'), 'A new note'));
    await fireEvent.press(result.getByTestId('chat-send'));
    await waitFor(() => expect(runtime.client.sendChatMessage).toHaveBeenCalled());
    expect(runtime.client.sendChatMessage).toHaveBeenCalledWith(
      expect.any(String),
      'demo-group',
      expect.objectContaining({ body: 'A new note', messageId: expect.any(String) }),
    );
    expect(result.getByText('Sent from the composer')).toBeTruthy();
  });

  it('keeps an understandable connection error and supports retry', async () => {
    const runtime = runtimeMock();
    const result = await render(<App runtimeClient={runtime.client} />);
    await fireEvent.press(await result.findByRole('tab', { name: 'Chat' }));
    await result.findByTestId('chat-empty');

    await act(async () => runtime.fail(new Error('The local runtime is offline.')));
    expect(await result.findByTestId('chat-error')).toBeTruthy();
    expect(result.getByText('The local runtime is offline.')).toBeTruthy();
    await fireEvent.press(result.getByTestId('chat-retry'));
    await result.findByTestId('chat-empty');
  });

  it('does not render message text when group membership is denied', async () => {
    const denied: MembershipDenied = { kind: 'MembershipDenied' };
    const runtime = runtimeMock({ getGroupForMember: jest.fn().mockResolvedValue(denied) });
    const result = await render(<App runtimeClient={runtime.client} />);
    await fireEvent.press(await result.findByRole('tab', { name: 'Chat' }));
    await result.findByTestId('chat-denied');
    expect(result.queryByText('private text')).toBeNull();
    expect(runtime.client.subscribeChat).not.toHaveBeenCalled();
  });

  it('keeps chat available when the authorized group has no current cycle or its cycle fails', async () => {
    const emptyRuntime = runtimeMock({
      getCurrentCycle: jest.fn().mockResolvedValue({ kind: 'NotFound' as const }),
    });
    const empty = await render(<App runtimeClient={emptyRuntime.client} />);
    await fireEvent.press(await empty.findByRole('tab', { name: 'Chat' }));
    await empty.findByTestId('chat-empty');
    expect(empty.getByTestId('chat-composer')).toBeTruthy();

    const errorRuntime = runtimeMock({
      getCurrentCycle: jest.fn().mockRejectedValue(new Error('cycle unavailable')),
    });
    const failed = await render(<App runtimeClient={errorRuntime.client} />);
    await fireEvent.press(await failed.findByRole('tab', { name: 'Chat' }));
    await failed.findByTestId('chat-empty');
    expect(failed.getByTestId('chat-composer')).toBeTruthy();
  });

  it('exposes accessible reply context and toggles a supported reaction', async () => {
    const original = event(8, 'Original message', '2026-09-13T04:00:00.000Z');
    const reply = event(9, 'A reply', '2026-09-13T04:01:00.000Z');
    reply.message.replyTo = {
      id: original.message.id,
      memberId: original.message.memberId,
      body: original.message.body,
      createdAt: original.message.createdAt,
    };
    const runtime = runtimeMock({
      sendChatReply: jest.fn().mockResolvedValue(reply),
      toggleChatReaction: jest.fn().mockImplementation(async (_session, _group, messageId) => ({
        reaction: {
          messageId,
          groupId: 'demo-group',
          memberId: 'demo-1',
          emoji: '✨',
          active: true,
          count: 1,
        },
        message: { ...original.message, reactionCounts: { '✨': 1 } },
      })),
    });
    const result = await render(
      <ChatSessionSurface
        accessState="known"
        capsuleStatus="ready"
        group={group}
        memberNames={memberNames}
        retryCapsule={jest.fn()}
        runtimeClient={runtime.client}
        session={sessionA}
      />,
    );
    await result.findByTestId('chat-empty');
    await act(async () => runtime.emit(original));
    await result.findByTestId(`chat-reaction-${original.message.id}`);
    expect(result.getByTestId('chat-message').props.accessible).toBe(false);
    const reaction = result.getByTestId(`chat-reaction-${original.message.id}`);
    expect(reaction.props.accessibilityLabel).toBe('0 sparkle reactions, toggle sparkle reaction');
    await fireEvent.press(reaction);
    await waitFor(() => expect(result.getByText('✨ Reacted 1')).toBeTruthy());
    await fireEvent.press(result.getByTestId(`chat-reply-${original.message.id}`));
    expect(result.getByTestId('chat-reply-target').props.accessible).toBe(false);
    expect(result.getByRole('button', { name: 'Cancel reply' })).toBeTruthy();
    expect(result.getAllByText('Original message').length).toBeGreaterThan(0);
    await fireEvent.changeText(result.getByTestId('chat-composer'), 'A reply');
    await fireEvent.press(result.getByTestId('chat-send'));
    await waitFor(() =>
      expect(runtime.client.sendChatReply).toHaveBeenCalledWith(
        sessionA.id,
        group.id,
        expect.objectContaining({ body: 'A reply', messageId: expect.any(String) }),
        original.message.id,
      ),
    );
    await act(async () => runtime.emit(reply));
    expect(result.getByTestId('chat-reply-context')).toHaveAccessibleName(
      'Replying to Original message',
    );
  });

  it('retains a reply draft identity when the response is lost and retries', async () => {
    const original = event(12, 'Original for retry', '2026-09-13T06:00:00.000Z');
    const reply = event(13, 'Reply after retry', '2026-09-13T06:01:00.000Z');
    const sendChatReply = jest
      .fn()
      .mockRejectedValueOnce(new Error('The response was lost.'))
      .mockResolvedValueOnce(reply);
    const runtime = runtimeMock({ sendChatReply });
    const result = await render(
      <ChatSessionSurface
        accessState="known"
        capsuleStatus="ready"
        group={group}
        memberNames={memberNames}
        retryCapsule={jest.fn()}
        runtimeClient={runtime.client}
        session={sessionA}
      />,
    );
    await result.findByTestId('chat-empty');
    await act(async () => runtime.emit(original));
    await result.findByTestId(`chat-reply-${original.message.id}`);
    await fireEvent.press(result.getByTestId(`chat-reply-${original.message.id}`));
    await fireEvent.changeText(result.getByTestId('chat-composer'), 'Retry this reply');
    await fireEvent.press(result.getByTestId('chat-send'));
    await result.findByTestId('chat-send-error');
    const firstDraft = sendChatReply.mock.calls[0][2];
    expect(firstDraft).toEqual(expect.objectContaining({ body: 'Retry this reply' }));
    await fireEvent.press(result.getByTestId('chat-send-retry'));
    await waitFor(() => expect(sendChatReply).toHaveBeenCalledTimes(2));
    expect(sendChatReply.mock.calls[1][2].messageId).toBe(firstDraft.messageId);
    expect(result.getByText('Reply after retry')).toBeTruthy();
  });

  it('lets the server-authoritative toggle remove a reaction persisted before remount', async () => {
    const original = event(10, 'Persisted reaction', '2026-09-13T05:00:00.000Z');
    let persistedActive = false;
    const toggleChatReaction = jest
      .fn()
      .mockImplementation(async (_session, _group, messageId, emoji, requestedActive) => {
        expect(requestedActive).toBeUndefined();
        persistedActive = !persistedActive;
        const count = persistedActive ? 2 : 1;
        return {
          reaction: {
            messageId,
            groupId: 'demo-group',
            memberId: 'demo-1',
            emoji,
            active: persistedActive,
            count,
          },
          message: { ...original.message, reactionCounts: { '✨': count } },
        };
      });
    const runtime = runtimeMock({ toggleChatReaction });
    const result = await render(
      <ScopedChatSurface
        accessState="known"
        capsuleStatus="ready"
        group={group}
        scope="reaction-scope-a"
        memberNames={memberNames}
        retryCapsule={jest.fn()}
        runtimeClient={runtime.client}
        session={sessionA}
      />,
    );
    await result.findByTestId('chat-empty');
    await act(async () =>
      runtime.emit({
        ...original,
        message: { ...original.message, reactionCounts: { '✨': 1 } },
      }),
    );
    const reaction = await result.findByTestId(`chat-reaction-${original.message.id}`);

    // The first click adds a reaction that is now persisted on the server.
    await fireEvent.press(reaction);
    await waitFor(() => expect(reaction).toHaveTextContent('✨ Reacted 2'));

    // A scope remount clears local viewer state while the persisted reaction remains active.
    await act(async () =>
      result.rerender(
        <ScopedChatSurface
          accessState="known"
          capsuleStatus="ready"
          group={group}
          scope="reaction-scope-b"
          memberNames={memberNames}
          retryCapsule={jest.fn()}
          runtimeClient={runtime.client}
          session={sessionA}
        />,
      ),
    );
    await result.findByTestId('chat-empty');
    await act(async () =>
      runtime.emit({
        ...original,
        message: { ...original.message, reactionCounts: { '✨': 2 } },
      }),
    );
    const remountedReaction = await result.findByTestId(`chat-reaction-${original.message.id}`);
    expect(remountedReaction).toHaveTextContent('✨ 2');
    expect(remountedReaction).not.toHaveTextContent('Reacted');
    expect(remountedReaction.props.accessibilityLabel).toBe(
      '2 sparkle reactions, toggle sparkle reaction',
    );

    // Because the click is a server-authoritative toggle, it removes the persisted reaction.
    await fireEvent.press(remountedReaction);
    await waitFor(() => expect(remountedReaction).toHaveTextContent('✨ 1'));
    expect(toggleChatReaction).toHaveBeenLastCalledWith(
      sessionA.id,
      group.id,
      original.message.id,
      '✨',
    );
  });

  it('clears a previous group body before subscribing to a new group scope', async () => {
    const runtime = runtimeMock();
    const result = await render(
      <ScopedChatSurface
        accessState="known"
        capsuleStatus="ready"
        group={group}
        scope="session-a:demo-group"
        memberNames={memberNames}
        retryCapsule={jest.fn()}
        runtimeClient={runtime.client}
        session={sessionA}
      />,
    );
    await result.findByTestId('chat-empty');
    await act(async () =>
      runtime.emit(event(7, 'Only in the first group', '2026-09-13T01:00:00.000Z')),
    );
    expect(result.getByText('Only in the first group')).toBeTruthy();

    await act(async () =>
      result.rerender(
        <ScopedChatSurface
          accessState="known"
          capsuleStatus="ready"
          group={otherGroup}
          scope="session-b:other-group"
          memberNames={memberNames}
          retryCapsule={jest.fn()}
          runtimeClient={runtime.client}
          session={sessionB}
        />,
      ),
    );
    expect(result.queryByText('Only in the first group')).toBeNull();
    await result.findByTestId('chat-empty');
  });

  it('terminally denies the chat when a send loses access before the stream does', async () => {
    const sendChatMessage = jest.fn().mockRejectedValue({ status: 403 });
    const runtime = runtimeMock({ sendChatMessage });
    const result = await render(<App runtimeClient={runtime.client} />);
    await fireEvent.press(await result.findByRole('tab', { name: 'Chat' }));
    await result.findByTestId('chat-empty');
    await act(async () =>
      fireEvent.changeText(result.getByTestId('chat-composer'), 'Sensitive revoked note'),
    );
    await fireEvent.press(result.getByTestId('chat-send'));
    await result.findByTestId('chat-denied');
    expect(result.queryByText('Sensitive revoked note')).toBeNull();
    expect(result.queryByTestId('chat-composer')).toBeNull();
    expect(result.queryByTestId('chat-send-retry')).toBeNull();
    await act(async () =>
      runtime.emit(event(8, 'Post-denial private text', '2026-09-13T08:00:00.000Z')),
    );
    expect(result.queryByText('Post-denial private text')).toBeNull();
  });

  it('clears the timeline and compose state when access is revoked', async () => {
    const runtime = runtimeMock();
    const result = await render(<App runtimeClient={runtime.client} />);
    await fireEvent.press(await result.findByRole('tab', { name: 'Chat' }));
    await result.findByTestId('chat-empty');
    await act(async () =>
      runtime.emit(event(6, 'Revoked private text', '2026-09-13T06:00:00.000Z')),
    );
    await result.findByText('Revoked private text');
    await act(async () =>
      fireEvent.changeText(result.getByTestId('chat-composer'), 'Sensitive unsent draft'),
    );
    await act(async () => runtime.deny());
    await result.findByTestId('chat-denied');
    expect(result.queryByText('Revoked private text')).toBeNull();
    expect(result.queryByText('Sensitive unsent draft')).toBeNull();
    expect(result.queryByTestId('chat-composer')).toBeNull();
    expect(result.queryByTestId('chat-send-retry')).toBeNull();
  });

  it('retains a failed draft identity across connection retry before sending again', async () => {
    const sendChatMessage = jest
      .fn()
      .mockRejectedValueOnce(new Error('The response was lost.'))
      .mockResolvedValueOnce(event(5, 'Sent once after reconnect', '2026-09-13T05:00:00.000Z'));
    const runtime = runtimeMock({ sendChatMessage });
    const result = await render(<App runtimeClient={runtime.client} />);
    await fireEvent.press(await result.findByRole('tab', { name: 'Chat' }));
    await result.findByTestId('chat-empty');
    await act(async () =>
      fireEvent.changeText(result.getByTestId('chat-composer'), 'Retry after reconnect'),
    );
    await fireEvent.press(result.getByTestId('chat-send'));
    await result.findByTestId('chat-send-error');
    const firstDraft = sendChatMessage.mock.calls[0][2];
    await act(async () => runtime.fail(new Error('The connection dropped.')));
    await result.findByTestId('chat-error');
    await fireEvent.press(result.getByTestId('chat-retry'));
    await result.findByTestId('chat-empty');
    expect(result.getByTestId('chat-composer')).toHaveProp('value', 'Retry after reconnect');
    await fireEvent.press(result.getByTestId('chat-send-retry'));
    await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(2));
    expect(sendChatMessage.mock.calls[1][2].messageId).toBe(firstDraft.messageId);
    expect(result.getByText('Sent once after reconnect')).toBeTruthy();
  });

  it('does not let a stale send completion clear a newer scope send', async () => {
    let resolveFirst!: (value: ChatMessageEvent) => void;
    let resolveSecond!: (value: ChatMessageEvent) => void;
    const firstSend = new Promise<ChatMessageEvent>((resolve) => {
      resolveFirst = resolve;
    });
    const secondSend = new Promise<ChatMessageEvent>((resolve) => {
      resolveSecond = resolve;
    });
    const sendChatMessage = jest
      .fn()
      .mockReturnValueOnce(firstSend)
      .mockReturnValueOnce(secondSend);
    const runtime = runtimeMock({ sendChatMessage });
    const result = await render(<App runtimeClient={runtime.client} />);
    await fireEvent.press(await result.findByRole('tab', { name: 'Chat' }));
    await result.findByTestId('chat-empty');
    await act(async () =>
      fireEvent.changeText(result.getByTestId('chat-composer'), 'First scope message'),
    );
    await fireEvent.press(result.getByTestId('chat-send'));
    await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(1));
    const otherGroup: Group = {
      ...group,
      id: 'other-group',
      name: 'Other Group',
      currentCycleId: 'other-cycle',
    };
    const otherCycle: Cycle = { ...cycle, groupId: otherGroup.id, id: otherGroup.currentCycleId };
    await act(async () =>
      result.rerender(
        <App
          cycleRepository={{ getCurrentCycle: jest.fn().mockResolvedValue(otherCycle) }}
          groupRepository={{ getGroupForMember: jest.fn().mockResolvedValue(otherGroup) }}
          runtimeClient={runtime.client}
        />,
      ),
    );
    await waitFor(() => expect(result.getByText('Other Group')).toBeTruthy());
    await result.findByTestId('chat-empty');
    await act(async () =>
      fireEvent.changeText(result.getByTestId('chat-composer'), 'Second scope message'),
    );
    await fireEvent.press(result.getByTestId('chat-send'));
    await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(2));
    expect(result.getByTestId('chat-send')).toHaveTextContent('Sending…');
    await act(async () =>
      resolveFirst(event(9, 'Stale first scope response', '2026-09-13T09:00:00.000Z')),
    );
    expect(result.getByTestId('chat-send')).toHaveTextContent('Sending…');
    expect(result.getByTestId('chat-send')).toBeDisabled();
    const secondEvent = event(10, 'Second scope response', '2026-09-13T10:00:00.000Z');
    secondEvent.message.groupId = otherGroup.id;
    await act(async () => resolveSecond(secondEvent));
    await waitFor(() => expect(result.getByText('Second scope response')).toBeTruthy());
  });
});

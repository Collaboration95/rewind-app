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

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

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
      return { close: jest.fn() };
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
      'A new note',
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
    await fireEvent.press(result.getByTestId(`chat-reaction-${original.message.id}`));
    await waitFor(() => expect(result.getByText('✨ Reacted 1')).toBeTruthy());
    await fireEvent.press(result.getByTestId(`chat-reply-${original.message.id}`));
    expect(result.getAllByText('Original message').length).toBeGreaterThan(0);
    await fireEvent.changeText(result.getByTestId('chat-composer'), 'A reply');
    await fireEvent.press(result.getByTestId('chat-send'));
    await waitFor(() =>
      expect(runtime.client.sendChatReply).toHaveBeenCalledWith(
        sessionA.id,
        group.id,
        'A reply',
        original.message.id,
      ),
    );
    await act(async () => runtime.emit(reply));
    expect(result.getByTestId('chat-reply-context')).toHaveAccessibleName(
      'Replying to Original message',
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
});

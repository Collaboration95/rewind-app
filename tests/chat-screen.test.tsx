import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import App from '../App';
import type { Cycle } from '../src/domain/cycles';
import type { Group, MembershipDenied } from '../src/domain/profiles';
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
  };
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
      expect.objectContaining({ body: 'A new note', messageId: expect.any(String) }),
    );
    expect(result.getByText('Sent from the composer')).toBeTruthy();
  });

  it('keeps one draft identity and compose text when the response is lost', async () => {
    const sendChatMessage = jest
      .fn()
      .mockRejectedValueOnce(new Error('The response was lost.'))
      .mockResolvedValueOnce(event(4, 'Recovered note', '2026-09-13T04:00:00.000Z'));
    const runtime = runtimeMock({ sendChatMessage });
    const result = await render(<App runtimeClient={runtime.client} />);
    await fireEvent.press(await result.findByRole('tab', { name: 'Chat' }));
    await result.findByTestId('chat-empty');

    await act(async () =>
      fireEvent.changeText(result.getByTestId('chat-composer'), 'Keep this text'),
    );
    await fireEvent.press(result.getByTestId('chat-send'));
    await result.findByTestId('chat-send-error');
    expect(result.getByTestId('chat-composer')).toHaveProp('value', 'Keep this text');
    const firstDraft = sendChatMessage.mock.calls[0][2];
    expect(firstDraft).toEqual(
      expect.objectContaining({ body: 'Keep this text', messageId: expect.any(String) }),
    );

    await fireEvent.press(result.getByTestId('chat-send-retry'));
    await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(2));
    expect(sendChatMessage.mock.calls[1][2].messageId).toBe(firstDraft.messageId);
    expect(result.getByText('Recovered note')).toBeTruthy();
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

  it('restores the ready timeline on reconnect without waiting for another message', async () => {
    const runtime = runtimeMock();
    const result = await render(<App runtimeClient={runtime.client} />);
    await fireEvent.press(await result.findByRole('tab', { name: 'Chat' }));
    await result.findByTestId('chat-empty');

    await act(async () => runtime.emit(event(2, 'Still here', '2026-09-13T02:00:00.000Z')));
    await act(async () => runtime.fail(new Error('The local runtime is offline.')));
    expect(await result.findByTestId('chat-error')).toBeTruthy();
    await act(async () => runtime.connect());
    await waitFor(() => expect(result.queryByTestId('chat-error')).toBeNull());
    expect(result.getByText('Still here')).toBeTruthy();
    expect(result.getByTestId('chat-composer')).toBeTruthy();
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

  it('hides and disables the composer when the subscription is terminally denied', async () => {
    const runtime = runtimeMock();
    const result = await render(<App runtimeClient={runtime.client} />);
    await fireEvent.press(await result.findByRole('tab', { name: 'Chat' }));
    await result.findByTestId('chat-empty');

    await act(async () => runtime.deny());
    expect(await result.findByTestId('chat-denied')).toBeTruthy();
    expect(result.queryByTestId('chat-composer')).toBeNull();
    expect(result.queryByTestId('chat-send')).toBeNull();
    expect(runtime.client.sendChatMessage).not.toHaveBeenCalled();
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

  it('clears the previous group timeline before a new group scope is ready', async () => {
    const runtime = runtimeMock();
    const otherGroup: Group = {
      ...group,
      id: 'other-group',
      name: 'Other Group',
      currentCycleId: 'other-cycle',
    };
    const otherCycle: Cycle = { ...cycle, groupId: otherGroup.id, id: otherGroup.currentCycleId };
    const firstGroupRepository = {
      getGroupForMember: jest.fn().mockResolvedValue(group),
    };
    const firstCycleRepository = {
      getCurrentCycle: jest.fn().mockResolvedValue(cycle),
    };
    const result = await render(
      <App
        cycleRepository={firstCycleRepository}
        groupRepository={firstGroupRepository}
        runtimeClient={runtime.client}
      />,
    );
    await fireEvent.press(await result.findByRole('tab', { name: 'Chat' }));
    await result.findByTestId('chat-empty');
    await act(async () =>
      runtime.emit(event(7, 'First group private text', '2026-09-13T07:00:00.000Z')),
    );
    await result.findByText('First group private text');

    const secondGroupRepository = {
      getGroupForMember: jest.fn().mockResolvedValue(otherGroup),
    };
    const secondCycleRepository = {
      getCurrentCycle: jest.fn().mockResolvedValue(otherCycle),
    };
    await act(async () => {
      result.rerender(
        <App
          cycleRepository={secondCycleRepository}
          groupRepository={secondGroupRepository}
          runtimeClient={runtime.client}
        />,
      );
    });

    expect(result.queryByText('First group private text')).toBeNull();
    await waitFor(() => expect(result.getByText('Other Group')).toBeTruthy());
    await result.findByTestId('chat-empty');
    expect(result.queryByText('First group private text')).toBeNull();
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
    expect(result.getByTestId('chat-send-retry')).toBeTruthy();

    await fireEvent.press(result.getByTestId('chat-send-retry'));
    await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(2));
    expect(sendChatMessage.mock.calls[1][2].messageId).toBe(firstDraft.messageId);
    expect(result.getByText('Sent once after reconnect')).toBeTruthy();
  });
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import App from '../App';
import type { ChatMessageEvent, SubscribeOptions } from '../src/chat';
import type { Cycle } from '../src/domain/cycles';
import type { Group } from '../src/domain/profiles';
import type { RuntimeClient } from '../src/runtime/local-runtime-client';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

const firstGroup: Group = {
  id: 'demo-group',
  name: 'Weekend People',
  memberIds: ['demo-1', 'demo-2'],
  currentCycleId: 'demo-cycle',
};
const secondGroup: Group = {
  ...firstGroup,
  id: 'new-group',
  name: 'New People',
  currentCycleId: 'new-cycle',
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

interface Stream {
  groupId: string;
  options: SubscribeOptions;
  close: jest.Mock;
}

function message(eventId: number, groupId = firstGroup.id): ChatMessageEvent {
  return {
    eventId,
    type: 'message',
    occurredAt: '2026-09-13T01:00:00.000Z',
    message: {
      id: 'message-' + eventId,
      groupId,
      memberId: 'demo-2',
      body: 'Private text that must not appear in the badge',
      createdAt: '2026-09-13T01:00:00.000Z',
    },
  };
}

function runtimeMock() {
  let selectedGroup = firstGroup;
  const streams: Stream[] = [];
  const subscribeChat = jest.fn(
    (_sessionId: string, groupId: string, options: SubscribeOptions) => {
      const stream = { groupId, options, close: jest.fn() };
      streams.push(stream);
      return { close: stream.close, state: 'connecting' as const };
    },
  );
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
    getGroupForMember: jest.fn().mockImplementation(async () => selectedGroup),
    getCurrentCycle: jest.fn().mockImplementation(async (groupId: string) => ({
      ...cycle,
      id: groupId === secondGroup.id ? secondGroup.currentCycleId : cycle.id,
      groupId,
    })),
    advanceDemoCycle: jest.fn(),
    createGroup: jest.fn().mockImplementation(async () => {
      selectedGroup = secondGroup;
      return { ok: true, group: secondGroup };
    }),
    subscribeChat,
  };
  return { client, streams, subscribeChat };
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('app-wide chat unread indicator', () => {
  it('counts only off-tab delivery, clears on opening Chat, and ignores reconnect replay', async () => {
    const runtime = runtimeMock();
    const result = await render(<App runtimeClient={runtime.client} />);
    await waitFor(() => expect(runtime.subscribeChat).toHaveBeenCalledTimes(1));
    expect(result.queryByTestId('chat-unread-badge')).toBeNull();

    await act(async () => runtime.streams[0].options.onEvent(message(7)));
    expect(result.getByTestId('chat-unread-badge')).toHaveTextContent('1');
    expect(result.getByRole('tab', { name: 'Chat, 1 unread message' })).toBeTruthy();
    expect(JSON.stringify(result.toJSON())).not.toContain('Private text that must not appear');

    await act(async () => {
      runtime.streams[0].options.onConnectionStateChange?.('reconnecting');
      runtime.streams[0].options.onEvent(message(7));
      runtime.streams[0].options.onConnectionStateChange?.('connected');
    });
    expect(result.getByTestId('chat-unread-badge')).toHaveTextContent('1');

    await fireEvent.press(result.getByTestId('nav-chat'));
    await result.findByTestId('chat-screen');
    expect(result.queryByTestId('chat-unread-badge')).toBeNull();
    expect(runtime.subscribeChat).toHaveBeenCalledTimes(2);
    expect(result.getByRole('tab', { name: 'Chat', selected: true })).toBeTruthy();

    await act(async () => runtime.streams[0].options.onEvent(message(8)));
    expect(result.queryByTestId('chat-unread-badge')).toBeNull();

    await fireEvent.press(result.getByTestId('nav-home'));
    await act(async () => runtime.streams[0].options.onEvent(message(9)));
    expect(result.getByTestId('chat-unread-badge')).toHaveTextContent('1');
    // Leaving Chat closes only the timeline stream; the unread stream persists.
    expect(runtime.streams[1].close).toHaveBeenCalled();
    expect(runtime.streams[0].close).not.toHaveBeenCalled();
  });

  it('closes and clears the old group scope after a group switch', async () => {
    const runtime = runtimeMock();
    const result = await render(<App runtimeClient={runtime.client} />);
    await waitFor(() => expect(runtime.subscribeChat).toHaveBeenCalledTimes(1));
    await act(async () => runtime.streams[0].options.onEvent(message(4)));
    expect(result.getByTestId('chat-unread-badge')).toHaveTextContent('1');

    await fireEvent.press(result.getByTestId('nav-settings'));
    await fireEvent.press(result.getByRole('button', { name: 'Create a local group' }));
    await fireEvent.changeText(result.getByTestId('group-name-input'), 'New People');
    await fireEvent.press(result.getByTestId('create-group-submit'));
    await waitFor(() => expect(runtime.subscribeChat).toHaveBeenCalledTimes(2));

    expect(runtime.streams[0].close).toHaveBeenCalled();
    expect(runtime.streams[1].groupId).toBe(secondGroup.id);
    expect(result.queryByTestId('chat-unread-badge')).toBeNull();
    await act(async () => runtime.streams[0].options.onEvent(message(5)));
    expect(result.queryByTestId('chat-unread-badge')).toBeNull();
    await act(async () => runtime.streams[1].options.onEvent(message(6, secondGroup.id)));
    expect(result.getByTestId('chat-unread-badge')).toHaveTextContent('1');
  });

  it('closes and clears the stream on sign-out', async () => {
    const runtime = runtimeMock();
    const result = await render(<App runtimeClient={runtime.client} />);
    await waitFor(() => expect(runtime.subscribeChat).toHaveBeenCalledTimes(1));
    await act(async () => runtime.streams[0].options.onEvent(message(4)));
    expect(result.getByTestId('chat-unread-badge')).toHaveTextContent('1');

    await fireEvent.press(result.getByTestId('nav-settings'));
    await fireEvent.press(result.getByTestId('sign-out'));
    await result.findByRole('header', { name: 'Choose who you are showing' });
    expect(runtime.streams[0].close).toHaveBeenCalled();
    expect(result.queryByTestId('chat-unread-badge')).toBeNull();
  });
});

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { useRealAccount } from '../src/auth/RealAccountProvider';
import { RealAccountChatScreen } from '../src/chat/RealAccountChatScreen';

const mockMessageListeners: ((event: unknown) => void)[] = [];

jest.mock('../src/auth/RealAccountProvider', () => ({ useRealAccount: jest.fn() }));
jest.mock('../src/chat/native-event-source', () => ({
  createRuntimeEventSource: () => ({
    addEventListener: jest.fn((type: string, listener: (event: unknown) => void) => {
      if (type === 'message') mockMessageListeners.push(listener);
    }),
    close: jest.fn(),
    onerror: null,
    onopen: null,
    removeEventListener: jest.fn(),
  }),
}));

beforeEach(() => {
  mockMessageListeners.length = 0;
});

const savedMessage = {
  id: 'root-message',
  groupId: 'real-group-a',
  memberId: 'real-profile-owner',
  body: 'A saved group message',
  createdAt: '2026-09-29T00:00:00.000Z',
  replyTo: null,
  reactionCounts: { '✨': 0 },
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('real-account chat', () => {
  it('loads history older than the first 100 and keeps newer live events deduplicated', async () => {
    const latestPage = Array.from({ length: 100 }, (_, index) => {
      const eventId = index + 2;
      return {
        eventId,
        type: 'message' as const,
        occurredAt: savedMessage.createdAt,
        message: {
          ...savedMessage,
          id: `message-${eventId}`,
          body: `Saved message ${eventId}`,
        },
      };
    });
    const liveEvent = {
      eventId: 102,
      type: 'message' as const,
      occurredAt: savedMessage.createdAt,
      message: { ...savedMessage, id: 'message-102', body: 'Live newer message' },
    };
    const oldestEvent = {
      eventId: 1,
      type: 'message' as const,
      occurredAt: savedMessage.createdAt,
      message: { ...savedMessage, id: 'message-1', body: 'Oldest saved message' },
    };
    const authenticatedRequest = jest.fn(async (path: string) => {
      if (path.includes('beforeEventId=1')) {
        return response({
          events: [oldestEvent],
          nextCursor: null,
          watermarkEventId: 101,
          hasMore: false,
        });
      }
      if (path.startsWith('/realtime/groups/real-group-a/messages?limit=100')) {
        return response({
          events: latestPage,
          nextCursor: 1,
          watermarkEventId: 101,
          hasMore: true,
        });
      }
      throw new Error(`Unexpected authenticated request: ${path}`);
    });
    (useRealAccount as jest.Mock).mockReturnValue({
      baseUrl: 'https://runtime.example',
      session: { account: { id: 'account-id', displayName: 'Member' } },
      authenticatedRequest,
      realtimeAuthorizationHeader: () => undefined,
    });

    const result = await render(
      <RealAccountChatScreen
        groupId="real-group-a"
        groupName="Saturday table"
        currentMemberId="real-profile-member"
        members={[]}
        onBack={jest.fn()}
      />,
    );
    const timeline = result.getByTestId('real-chat-timeline') as unknown as {
      props: { data: { message: { id: string; body: string } }[] };
    };
    await waitFor(() => expect(timeline.props.data).toHaveLength(100));
    expect(timeline.props.data.at(-1)?.message.body).toBe('Saved message 101');
    expect(result.getByTestId('real-chat-load-older')).toBeTruthy();
    await act(async () => {
      for (const listener of mockMessageListeners) {
        listener({ data: JSON.stringify(liveEvent), lastEventId: '102' });
      }
    });
    await waitFor(() => expect(timeline.props.data).toHaveLength(101));
    expect(timeline.props.data.at(-1)?.message.body).toBe('Live newer message');

    await fireEvent.press(result.getByTestId('real-chat-load-older'));
    await waitFor(() => expect(timeline.props.data).toHaveLength(102));
    expect(timeline.props.data[0].message.body).toBe('Oldest saved message');
    expect(timeline.props.data.at(-1)?.message.body).toBe('Live newer message');
    expect(authenticatedRequest).toHaveBeenCalledWith(
      '/realtime/groups/real-group-a/messages?limit=100&beforeEventId=1',
    );

    await act(async () => {
      for (const listener of mockMessageListeners) {
        listener({ data: JSON.stringify(liveEvent), lastEventId: '102' });
      }
    });
    expect(
      timeline.props.data.filter((row) => row.message.id === liveEvent.message.id),
    ).toHaveLength(1);
    expect(result.queryByTestId('real-chat-load-older')).toBeNull();
  });

  it('loads the selected group, sends replies and never adds session credentials to request URLs', async () => {
    const authenticatedRequest = jest.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/realtime/groups/real-group-a/messages?limit=100')) {
        return response({
          events: [{ eventId: 4, type: 'message', message: savedMessage }],
          nextCursor: null,
          watermarkEventId: 4,
          hasMore: false,
        });
      }
      if (path === '/realtime/groups/real-group-a/messages') {
        const body = JSON.parse(String(init?.body)) as { body: string; replyToMessageId?: string };
        return response(
          {
            event: {
              eventId: 5,
              type: 'message',
              message: {
                ...savedMessage,
                id: 'reply-message',
                memberId: 'real-profile-member',
                body: body.body,
                replyTo: body.replyToMessageId ? savedMessage : null,
              },
            },
          },
          201,
        );
      }
      if (path === '/realtime/groups/real-group-a/messages/root-message/reactions') {
        return response({
          reaction: {
            messageId: 'root-message',
            groupId: 'real-group-a',
            memberId: 'real-profile-member',
            emoji: '✨',
            active: true,
            count: 1,
          },
          message: { ...savedMessage, reactionCounts: { '✨': 1 } },
        });
      }
      throw new Error(`Unexpected authenticated request: ${path}`);
    });
    (useRealAccount as jest.Mock).mockReturnValue({
      baseUrl: 'https://runtime.example',
      session: {
        account: { id: 'account-id', displayName: 'Member' },
      },
      authenticatedRequest,
      realtimeAuthorizationHeader: () => 'Bearer private-token-value',
    });

    const result = await render(
      <RealAccountChatScreen
        groupId="real-group-a"
        groupName="Saturday table"
        currentMemberId="real-profile-member"
        members={[
          { memberId: 'real-profile-owner', displayName: 'Owner' },
          { memberId: 'real-profile-member', displayName: 'Member' },
        ]}
        onBack={jest.fn()}
      />,
    );
    expect(await result.findByText('A saved group message')).toBeTruthy();
    expect(result.getByTestId('real-chat-context').props.children).toEqual([
      'Group · ',
      'Saturday table',
    ]);
    await fireEvent.press(result.getByTestId('real-chat-reply-root-message'));
    await fireEvent.changeText(result.getByTestId('real-chat-composer'), 'A reply from a member');
    await fireEvent.press(result.getByTestId('real-chat-send'));
    expect(await result.findByText('A reply from a member')).toBeTruthy();
    await fireEvent.press(result.getByTestId('real-chat-reaction-root-message'));
    expect(await result.findByText('✨ 1')).toBeTruthy();
    const requestUrls = authenticatedRequest.mock.calls.map(([path]) => String(path));
    expect(requestUrls.every((path) => !path.includes('private-token-value'))).toBe(true);
    expect(requestUrls.every((path) => !path.includes('sessionId'))).toBe(true);
    expect(authenticatedRequest).toHaveBeenCalledWith(
      '/realtime/groups/real-group-a/messages',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows an explicit denied state when group history is forbidden', async () => {
    const authenticatedRequest = jest.fn(async () => response({ message: 'forbidden' }, 403));
    (useRealAccount as jest.Mock).mockReturnValue({
      baseUrl: 'https://runtime.example',
      session: { account: { id: 'account-id', displayName: 'Member' } },
      authenticatedRequest,
      realtimeAuthorizationHeader: () => undefined,
    });
    const result = await render(
      <RealAccountChatScreen
        groupId="real-group-a"
        groupName="Saturday table"
        currentMemberId="real-profile-member"
        members={[]}
        onBack={jest.fn()}
      />,
    );
    expect(await result.findByTestId('real-chat-denied')).toBeTruthy();
    expect(result.queryByTestId('real-chat-composer')).toBeNull();
  });
});

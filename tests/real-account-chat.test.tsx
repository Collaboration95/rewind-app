import { fireEvent, render } from '@testing-library/react-native';

import { useRealAccount } from '../src/auth/RealAccountProvider';
import { RealAccountChatScreen } from '../src/chat/RealAccountChatScreen';

jest.mock('../src/auth/RealAccountProvider', () => ({ useRealAccount: jest.fn() }));
jest.mock('../src/chat/native-event-source', () => ({
  createRuntimeEventSource: () => ({
    addEventListener: jest.fn(),
    close: jest.fn(),
    onerror: null,
    onopen: null,
    removeEventListener: jest.fn(),
  }),
}));

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
      'ACTIVE GROUP · ',
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

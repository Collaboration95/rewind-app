import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { Platform } from 'react-native';

import { RealAccountClient } from '../src/auth/real-account-client';
import { useRealAccount } from '../src/auth/RealAccountProvider';
import { RealAccountChatScreen } from '../src/chat/RealAccountChatScreen';
import type { ChatMessageEvent } from '../src/chat/realtime-client';

const mockMessageListeners: ((event: unknown) => void)[] = [];
const mockEventSources: {
  url: string;
  headers: Record<string, string>;
  options: { withCredentials?: boolean };
  listeners: Map<string, (event: unknown) => void>;
  close: jest.Mock;
  onerror: ((event: unknown) => void) | null;
  onopen: (() => void) | null;
}[] = [];

jest.mock('../src/auth/RealAccountProvider', () => ({ useRealAccount: jest.fn() }));
jest.mock('../src/chat/native-event-source', () => ({
  createRuntimeEventSource: (
    url: string,
    headers: Record<string, string>,
    options: { withCredentials?: boolean },
  ) => {
    const listeners = new Map<string, (mockEvent: unknown) => void>();
    const source = {
      url,
      headers,
      options,
      listeners,
      addEventListener: jest.fn((type: string, listener: (mockEvent: unknown) => void) => {
        listeners.set(type, listener);
        if (type === 'message') mockMessageListeners.push(listener);
      }),
      close: jest.fn(),
      onerror: null,
      onopen: null,
      removeEventListener: jest.fn((type: string) => listeners.delete(type)),
    };
    mockEventSources.push(source);
    return source;
  },
}));

beforeEach(() => {
  mockMessageListeners.length = 0;
  mockEventSources.length = 0;
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
    expect(result.getByTestId('real-chat-timeline')).toBeTruthy();
    const rows = () => result.queryAllByTestId('real-chat-message');
    await waitFor(() => expect(rows()).toHaveLength(100));
    expect(rows().at(-1)).toHaveTextContent(/Saved message 101/);
    expect(result.getByTestId('real-chat-load-older')).toBeTruthy();
    await act(async () => {
      for (const listener of mockMessageListeners) {
        listener({ data: JSON.stringify(liveEvent), lastEventId: '102' });
      }
    });
    await waitFor(() => expect(rows()).toHaveLength(101));
    expect(rows().at(-1)).toHaveTextContent(/Live newer message/);

    await fireEvent.press(result.getByTestId('real-chat-load-older'));
    await waitFor(() => expect(rows()).toHaveLength(102));
    expect(rows()[0]).toHaveTextContent(/Oldest saved message/);
    expect(rows().at(-1)).toHaveTextContent(/Live newer message/);
    expect(authenticatedRequest).toHaveBeenCalledWith(
      '/realtime/groups/real-group-a/messages?limit=100&beforeEventId=1',
    );

    await act(async () => {
      for (const listener of mockMessageListeners) {
        listener({ data: JSON.stringify(liveEvent), lastEventId: '102' });
      }
    });
    expect(result.getAllByText(liveEvent.message.body)).toHaveLength(1);
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
    expect(result.getByTestId('real-chat-composer').props.placeholder).toBe(
      'Message Saturday table',
    );
    await fireEvent.press(result.getByTestId('real-chat-message-root-message'));
    await fireEvent.press(result.getByTestId('real-chat-reply-root-message'));
    await fireEvent.changeText(result.getByTestId('real-chat-composer'), 'A reply from a member');
    await fireEvent.press(result.getByTestId('real-chat-send'));
    expect(await result.findByText('A reply from a member')).toBeTruthy();
    await fireEvent.press(result.getByTestId('real-chat-message-root-message'));
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

// Exercise the screen's actual adapter and real authentication transport together.
// Mock only the external fetch/SSE boundaries so duplicated prefixes cannot pass.
describe('composed real-account chat transport', () => {
  it.each([
    ['ios', 'https://runtime.example'],
    ['ios', 'https://runtime.example/api'],
    ['ios', 'https://runtime.example/rewind/api/'],
    ['web', 'https://runtime.example/api/'],
    ['web', '/api'],
  ])('reads, writes, safely retries and reconnects with %s base %s', async (platform, baseUrl) => {
    const originalOS = Platform.OS;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { href: 'https://runtime.example/', origin: 'https://runtime.example' } },
    });
    let result: Awaited<ReturnType<typeof render>> | undefined;
    try {
      const token = 'fixture-native-token';
      const prefix = baseUrl.replace(/\/$/, '');
      const messagesPath = '/realtime/groups/real-group-a/messages';
      const messagesUrl = new URL(`${prefix}${messagesPath}`, 'https://runtime.example/').href;
      const savedEvent: ChatMessageEvent = {
        eventId: 4,
        type: 'message',
        occurredAt: savedMessage.createdAt,
        message: savedMessage,
      };
      const persisted = new Map<string, typeof savedEvent>();
      let loseReplyResponse = true;
      let reactionCount = 0;
      const fetcher = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === `${messagesUrl}?limit=100`) {
          return response({
            events: [savedEvent],
            nextCursor: 3,
            watermarkEventId: 4,
            hasMore: true,
          });
        }
        if (url === `${messagesUrl}?limit=100&beforeEventId=3`) {
          return response({
            events: [
              {
                eventId: 2,
                type: 'message',
                message: { ...savedMessage, id: 'older', body: 'Older history' },
              },
            ],
            nextCursor: null,
            watermarkEventId: 4,
            hasMore: false,
          });
        }
        if (url === messagesUrl && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as {
            body: string;
            messageId: string;
            replyToMessageId?: string;
          };
          if (!persisted.has(body.messageId)) {
            persisted.set(body.messageId, {
              eventId: body.replyToMessageId ? 6 : 5,
              type: 'message',
              occurredAt: savedMessage.createdAt,
              message: {
                ...savedMessage,
                id: body.messageId,
                memberId: 'real-profile-member',
                body: body.body,
                replyTo: body.replyToMessageId ? savedMessage : null,
              },
            });
          }
          if (body.replyToMessageId && loseReplyResponse) {
            loseReplyResponse = false;
            throw new Error('Fixture response lost after persistence');
          }
          return response({ event: persisted.get(body.messageId) }, 201);
        }
        if (url === `${messagesUrl}/root-message/reactions` && init?.method === 'POST') {
          reactionCount = reactionCount === 0 ? 1 : 0;
          return response({
            reaction: {
              messageId: savedMessage.id,
              groupId: savedMessage.groupId,
              memberId: 'real-profile-member',
              emoji: '✨',
              active: reactionCount === 1,
              count: reactionCount,
            },
            message: { ...savedMessage, reactionCounts: { '✨': reactionCount } },
          });
        }
        return response({ message: 'Unexpected composed route', error: 'not_found' }, 404);
      });
      const accountClient = new RealAccountClient(baseUrl, undefined, fetcher);
      const authenticatedRequest = (path: string, init: RequestInit = {}) =>
        accountClient.request(path, init, platform === 'ios' ? token : undefined);
      (useRealAccount as jest.Mock).mockReturnValue({
        baseUrl,
        session: { account: { id: 'account-id', displayName: 'Member' } },
        authenticatedRequest,
        realtimeAuthorizationHeader: () => accountClient.realtimeAuthorizationHeader(token),
      });
      result = await render(
        <RealAccountChatScreen
          groupId="real-group-a"
          groupName="Saturday table"
          currentMemberId="real-profile-member"
          members={[]}
          onBack={jest.fn()}
        />,
      );
      await result.findByText(savedMessage.body);
      await fireEvent.press(result.getByTestId('real-chat-load-older'));
      await result.findByText('Older history');
      await fireEvent.changeText(result.getByTestId('real-chat-composer'), 'Composed text');
      await fireEvent.press(result.getByTestId('real-chat-send'));
      expect(fetcher.mock.calls.at(-1)?.[0]).toBe(messagesUrl);
      await result.findByText('Composed text');
      expect(result.getByTestId('real-chat-composer').props.value).toBe('');

      await fireEvent.press(result.getByTestId('real-chat-message-root-message'));

      await fireEvent.press(result.getByTestId('real-chat-reply-root-message'));
      await fireEvent.changeText(result.getByTestId('real-chat-composer'), 'Composed reply');
      await fireEvent.press(result.getByTestId('real-chat-send'));
      await result.findByText('Fixture response lost after persistence');
      // T8: the message stays in place, marked "Not sent · Retry".
      expect(result.getByTestId('real-chat-composer').props.value).toBe('');
      expect(result.getByText('Composed reply')).toBeTruthy();
      expect(result.getByTestId('real-chat-retry-send')).toHaveTextContent('Not sent · Retry');
      await fireEvent.press(result.getByTestId('real-chat-retry-send'));
      await waitFor(() => expect(result!.queryByTestId('real-chat-retry-send')).toBeNull());
      await result.findByText('Composed reply');
      expect(result.getByTestId('real-chat-composer').props.value).toBe('');
      expect(result.queryByTestId('real-chat-reply-target')).toBeNull();
      expect(persisted.size).toBe(2);
      const posts = fetcher.mock.calls.filter(
        ([url, init]) => String(url) === messagesUrl && init?.method === 'POST',
      );
      expect(posts).toHaveLength(3);
      expect(posts[1][1]?.body).toBe(posts[2][1]?.body);
      expect(JSON.parse(String(posts[2][1]?.body)).replyToMessageId).toBe(savedMessage.id);
      expect(posts[2][1]?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(posts[2][1]?.headers).get('Content-Type')).toBe('application/json');

      await fireEvent.press(result.getByTestId('real-chat-message-root-message'));

      await fireEvent.press(result.getByTestId('real-chat-reaction-root-message'));
      await result.findByText('✨ 1');
      await fireEvent.press(result.getByTestId('real-chat-message-root-message'));
      await fireEvent.press(result.getByTestId('real-chat-reaction-root-message'));
      await waitFor(() => expect(result!.queryByText('✨ 1')).toBeNull());

      const firstSource = mockEventSources[0];
      expect(firstSource.url).toBe(`${prefix}/realtime/groups/real-group-a/events?sinceEventId=4`);
      expect(firstSource.options).toEqual({ withCredentials: true });
      expect(firstSource.headers).toEqual(
        platform === 'ios' ? { Authorization: `Bearer ${token}` } : {},
      );
      const replyEvent = [...persisted.values()].find(({ eventId }) => eventId === 6)!;
      await act(async () =>
        firstSource.listeners.get('message')?.({ data: JSON.stringify(replyEvent) }),
      );
      expect(result.getAllByText('Composed reply')).toHaveLength(1);
      jest.useFakeTimers();
      await act(async () => firstSource.onerror?.({ status: 0 }));
      await act(async () => jest.advanceTimersByTimeAsync(1_000));
      const resumedSource = mockEventSources[1];
      expect(firstSource.close).toHaveBeenCalledTimes(1);
      expect(resumedSource.url).toBe(
        `${prefix}/realtime/groups/real-group-a/events?sinceEventId=6`,
      );
      expect(resumedSource.headers).toEqual(firstSource.headers);
      await act(async () => resumedSource.onopen?.());
      // T5: the Reconnecting pill goes away once the stream is back.
      expect(result.queryByTestId('real-chat-connection')).toBeNull();
      jest.useRealTimers();

      for (const [url, init] of fetcher.mock.calls) {
        expect(String(url)).not.toContain(token);
        expect(String(url)).not.toContain('sessionId');
        expect(String(url)).not.toContain('/api/api/');
        expect(init?.credentials).toBe(platform === 'ios' ? 'omit' : 'include');
        expect(new Headers(init?.headers).get('Authorization')).toBe(
          platform === 'ios' ? `Bearer ${token}` : null,
        );
      }
      // A revoked membership remains terminal, without reconnecting or retaining history.
      jest.useFakeTimers();
      await act(async () =>
        resumedSource.listeners.get('access-denied')?.({ data: JSON.stringify({ status: 403 }) }),
      );
      expect(result.getByTestId('real-chat-denied')).toBeTruthy();
      expect(result.queryByTestId('real-chat-composer')).toBeNull();
      expect(result.queryByText(savedMessage.body)).toBeNull();
      await act(async () => jest.advanceTimersByTimeAsync(2_000));
      expect(mockEventSources).toHaveLength(2);
    } finally {
      await result?.unmount();
      jest.useRealTimers();
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else delete (globalThis as { window?: unknown }).window;
    }
  });
});

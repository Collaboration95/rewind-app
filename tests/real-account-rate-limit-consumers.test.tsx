import { useState } from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Platform, Pressable, Text, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { RealAccountProvider, useRealAccount } from '../src/auth/RealAccountProvider';
import { rateLimitMessage, RealAccountClient } from '../src/auth/real-account-client';
import { blockMember, reportContent, unblockMember } from '../src/real/safety';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const originalPlatform = Platform.OS;
const originalFetch = globalThis.fetch;
const token = 't'.repeat(43);
const account = {
  id: 'account-1',
  username: 'one',
  displayName: 'One',
  createdAt: '2026-10-05T00:00:00Z',
  updatedAt: '2026-10-05T00:00:00Z',
};
const message = 'You have reached the report and block limit. Please try again later.';
const jsonResponse = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function Probe() {
  const auth = useRealAccount();
  const [outcome, setOutcome] = useState('');
  return (
    <View>
      <Text testID="state">{auth.state}</Text>
      <Text testID="outcome">{outcome}</Text>
      <Pressable
        testID="delete"
        onPress={async () => setOutcome(await auth.deleteAccount('wrong password'))}
      >
        <Text>Delete account</Text>
      </Pressable>
    </View>
  );
}

beforeEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue(token);
});
afterEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
  globalThis.fetch = originalFetch;
  jest.useRealTimers();
});

test('account deletion returns throttled through the actual client and preserves the session', async () => {
  jest.useFakeTimers();
  const fetcher = jest.fn().mockImplementation(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/auth/session'))
      return jsonResponse(
        {
          account,
          idleExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          absoluteExpiresAt: new Date(Date.now() + 100_000).toISOString(),
        },
        200,
      );
    if (url.endsWith('/auth/account/delete'))
      return jsonResponse({ error: 'password_check_throttled' }, 429);
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetcher;
  const result = await render(
    <RealAccountProvider baseUrl="https://api.rewind.example">
      <Probe />
    </RealAccountProvider>,
  );
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
  expect(result.getByTestId('state')).toHaveTextContent('active');
  await fireEvent.press(result.getByTestId('delete'));
  expect(result.getByTestId('outcome')).toHaveTextContent('throttled');
  expect(result.getByTestId('state')).toHaveTextContent('active');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
    password: 'wrong password',
  });
  expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('Authorization')).toBe(
    `Bearer ${token}`,
  );
  expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
});

test.each(['report', 'block', 'unblock'] as const)(
  '%s preserves server feedback through the actual authenticated client',
  async (operation) => {
    const fetcher = jest
      .fn()
      .mockImplementation(async () => jsonResponse({ error: 'rate_limited', message }, 429));
    const client = new RealAccountClient('https://api.rewind.example', undefined, fetcher);
    const request = (path: string, init?: RequestInit) => client.request(path, init ?? {}, token);
    const work =
      operation === 'report'
        ? reportContent(request, 'group-1', { memberId: 'member-1' }, 'Spam')
        : operation === 'block'
          ? blockMember(request, 'member-1')
          : unblockMember(request, 'member-1');
    await expect(work).rejects.toThrow(message);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  },
);

test('throttling feedback falls back safely without replacing other HTTP error messages', async () => {
  const fallback = 'The group could not be created. Check the details and retry.';
  await expect(rateLimitMessage(new Response('bad JSON', { status: 429 }), fallback)).resolves.toBe(
    fallback,
  );
  await expect(rateLimitMessage(jsonResponse({ message: 42 }, 429), fallback)).resolves.toBe(
    fallback,
  );
  await expect(rateLimitMessage(jsonResponse({ message: ' ' }, 429), fallback)).resolves.toBe(
    fallback,
  );
  const otherError = jsonResponse({ message: 'Internal detail' }, 500);
  await expect(rateLimitMessage(otherError, fallback)).resolves.toBe(fallback);
  expect(otherError.bodyUsed).toBe(false);
});

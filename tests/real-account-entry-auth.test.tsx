import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import App from '../App';

const secureStoreMock = { token: null as string | null };

jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => secureStoreMock.token,
  setItemAsync: async (_key: string, value: string) => {
    secureStoreMock.token = value;
  },
  deleteItemAsync: async () => {
    secureStoreMock.token = null;
  },
}));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

const apiAccount = {
  id: 'account-1',
  username: 'pilot.user',
  displayName: 'Pilot User',
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
};
const nativeToken = 't'.repeat(43);
const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const runtimeClient = { baseUrl: 'https://rewind.example' } as never;
const originalFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeAll(() => {
  process.env.REWIND_TEST_DEMO_FIXTURE = 'false';
});

beforeEach(async () => {
  secureStoreMock.token = null;
  await AsyncStorage.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('real account entry flow', () => {
  it('shows generic wrong-password feedback and keeps Demo identity untouched', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(401, { error: 'sign_in_failed', message: 'Sign-in failed.' }),
      ) as typeof fetch;
    const result = await render(<App runtimeClient={runtimeClient} />);

    await fireEvent.press(await result.findByRole('button', { name: 'Sign in' }));
    await fireEvent.changeText(result.getByLabelText('Username'), 'pilot.user');
    await fireEvent.changeText(result.getByLabelText('Password'), 'wrong password');
    await fireEvent.press(result.getByTestId('real-account-submit'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());

    expect(
      await result.findByText(
        'Sign-in failed. Check your username and password, or try again later.',
      ),
    ).toBeTruthy();
    expect(secureStoreMock.token).toBeNull();
    expect(result.queryByTestId('demo-entry-demo-1')).toBeNull();
  });

  it('stores the native token securely, restores the account, and clears it on sign-out', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { account: apiAccount, token: nativeToken, expiresAt }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { signedOut: true })) as typeof fetch;
    const result = await render(<App runtimeClient={runtimeClient} />);

    await fireEvent.press(await result.findByRole('button', { name: 'Sign in' }));
    await fireEvent.changeText(result.getByLabelText('Username'), 'pilot.user');
    await fireEvent.changeText(result.getByLabelText('Password'), 'correct password');
    await fireEvent.press(result.getByTestId('real-account-submit'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));

    expect(await result.findByRole('header', { name: 'You’re signed in' })).toBeTruthy();
    expect(secureStoreMock.token).toBe(nativeToken);
    const demoStorage = JSON.stringify(await AsyncStorage.getAllKeys());
    expect(demoStorage).not.toContain('real-account');
    expect(demoStorage).not.toContain(nativeToken);
    const [loginUrl, loginInit] = (globalThis.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(loginUrl).toBe('https://rewind.example/auth/login');
    expect(loginInit.body).toContain('"clientType":"native"');
    expect(loginInit.credentials).toBe('omit');

    await fireEvent.press(result.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(secureStoreMock.token).toBeNull());
    expect(await result.findByRole('header', { name: 'Welcome to Rewind' })).toBeTruthy();
    const [logoutUrl, logoutInit] = (globalThis.fetch as jest.Mock).mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(logoutUrl).toBe('https://rewind.example/auth/logout');
    expect(new Headers(logoutInit.headers).get('Authorization')).toBe(`Bearer ${nativeToken}`);
  });

  it('keeps entry visible offline, offers retry, then explains expiry or administrator reset', async () => {
    secureStoreMock.token = nativeToken;
    globalThis.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(jsonResponse(401, { error: 'session_required' })) as typeof fetch;
    const result = await render(<App runtimeClient={runtimeClient} />);

    expect(await result.findByTestId('real-account-offline-status')).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Retry session check' }));
    expect(
      await result.findByText(/session expired or an administrator reset your password/i),
    ).toBeTruthy();
    expect(secureStoreMock.token).toBeNull();
    expect(result.queryByTestId('main-navigation')).toBeNull();
  });
});

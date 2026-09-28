import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';
import { Platform } from 'react-native';

import App from '../App';
import { signOutMarkerStore } from '../src/auth/sign-out-marker';

const secureStoreMock = { token: null as string | null, failClear: false };

jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => secureStoreMock.token,
  setItemAsync: async (_key: string, value: string) => {
    secureStoreMock.token = value;
  },
  deleteItemAsync: async () => {
    if (secureStoreMock.failClear) throw new Error('SecureStore unavailable');
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
const signOutMarkerKey = 'rewind.real-account.sign-out-pending';
const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const runtimeClient = { baseUrl: 'https://rewind.example' } as never;
const originalFetch = globalThis.fetch;
const originalPlatformOS = Platform.OS;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function activeSessionResponse() {
  return jsonResponse(200, {
    account: apiAccount,
    idleExpiresAt: expiresAt,
    absoluteExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });
}

function webAccountFetch(logout: () => Response | Promise<Response>) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/auth/session')) return activeSessionResponse();
    if (url.endsWith('/real/groups/current')) return jsonResponse(200, { group: null });
    if (url.endsWith('/auth/logout')) return logout();
    throw new Error(`Unexpected real-account request: ${url}`);
  }) as typeof fetch;
}

function useWebPlatform() {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web', writable: true });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { href: 'https://rewind.example/', origin: 'https://rewind.example' },
    },
    writable: true,
  });
}

function restorePlatform() {
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    value: originalPlatformOS,
    writable: true,
  });
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: unknown }).window;
}

beforeAll(() => {
  process.env.REWIND_TEST_DEMO_FIXTURE = 'false';
});

beforeEach(async () => {
  secureStoreMock.token = null;
  secureStoreMock.failClear = false;
  await AsyncStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
  globalThis.fetch = originalFetch;
  restorePlatform();
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
      .mockResolvedValueOnce(jsonResponse(200, { group: null }))
      .mockResolvedValueOnce(jsonResponse(200, { signedOut: true })) as typeof fetch;
    const result = await render(<App runtimeClient={runtimeClient} />);

    await fireEvent.press(await result.findByRole('button', { name: 'Sign in' }));
    await fireEvent.changeText(result.getByLabelText('Username'), 'pilot.user');
    await fireEvent.changeText(result.getByLabelText('Password'), 'correct password');
    await fireEvent.press(result.getByTestId('real-account-submit'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));

    expect(await result.findByRole('header', { name: 'Choose a group' })).toBeTruthy();
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
    const [groupUrl] = (globalThis.fetch as jest.Mock).mock.calls[1] as [string, RequestInit];
    expect(groupUrl).toBe('https://rewind.example/real/groups/current');
    const [logoutUrl, logoutInit] = (globalThis.fetch as jest.Mock).mock.calls[2] as [
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

  it('reports and retries SecureStore cleanup failure after a restored session is expired', async () => {
    secureStoreMock.token = nativeToken;
    secureStoreMock.failClear = true;
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'session_required' }))
      .mockResolvedValueOnce(jsonResponse(200, { signedOut: true })) as typeof fetch;
    const result = await render(<App runtimeClient={runtimeClient} />);

    expect(await result.findByRole('header', { name: 'Welcome to Rewind' })).toBeTruthy();
    expect(result.getByTestId('real-account-session-status')).toHaveTextContent(
      /server says this session has ended.*could not confirm deletion/i,
    );
    expect(secureStoreMock.token).toBe(nativeToken);
    expect(await result.findByRole('button', { name: 'Retry local cleanup' })).toBeTruthy();

    secureStoreMock.failClear = false;
    await fireEvent.press(result.getByRole('button', { name: 'Retry local cleanup' }));
    await waitFor(() => expect(secureStoreMock.token).toBeNull());
    expect(result.queryByTestId('real-account-session-status')).toBeNull();
  });

  it.each([
    ['non-2xx response', () => jsonResponse(503, { signedOut: false })],
    ['network failure', () => Promise.reject(new Error('offline'))],
  ])(
    'keeps the web account active after logout %s without server confirmation',
    async (_, logoutResult) => {
      useWebPlatform();
      globalThis.fetch = webAccountFetch(logoutResult);
      const result = await render(<App runtimeClient={runtimeClient} />);

      expect(await result.findByRole('header', { name: 'Choose a group' })).toBeTruthy();
      await fireEvent.press(result.getByRole('button', { name: 'Sign out' }));

      expect(await result.findByRole('button', { name: 'Retry sign out' })).toBeTruthy();
      expect(result.getByRole('header', { name: 'Choose a group' })).toBeTruthy();
      expect(result.getByTestId('logout-unconfirmed')).toHaveTextContent(
        /You are still signed in on this browser/,
      );
      expect(result.queryByRole('header', { name: 'Welcome to Rewind' })).toBeNull();
      const logoutCall = (globalThis.fetch as jest.Mock).mock.calls.find(([url]) =>
        String(url).endsWith('/auth/logout'),
      );
      expect(logoutCall?.[1].credentials).toBe('include');
    },
  );

  it.each([
    ['non-2xx response', () => jsonResponse(503, { signedOut: false })],
    ['network failure', () => Promise.reject(new Error('offline'))],
  ])(
    'retains the native credential and reports incomplete sign-out after %s',
    async (_, logoutResult) => {
      secureStoreMock.token = nativeToken;
      globalThis.fetch = webAccountFetch(logoutResult);
      const result = await render(<App runtimeClient={runtimeClient} />);

      expect(await result.findByRole('header', { name: 'Choose a group' })).toBeTruthy();
      await fireEvent.press(result.getByRole('button', { name: 'Sign out' }));

      expect(await result.findByRole('header', { name: 'Welcome to Rewind' })).toBeTruthy();
      expect(result.getByTestId('real-account-session-status')).toHaveTextContent(
        /server did not confirm revocation.*credential may remain and you may still be signed in/i,
      );
      expect(secureStoreMock.token).toBe(nativeToken);
      const [, logoutInit] = (globalThis.fetch as jest.Mock).mock.calls[1] as [string, RequestInit];
      expect(new Headers(logoutInit.headers).get('Authorization')).toBe(`Bearer ${nativeToken}`);
    },
  );

  it('closes protected UI but offers retry when remote revocation succeeds and SecureStore deletion fails', async () => {
    secureStoreMock.token = nativeToken;
    secureStoreMock.failClear = true;
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(activeSessionResponse())
      .mockResolvedValueOnce(jsonResponse(200, { signedOut: true })) as typeof fetch;
    const result = await render(<App runtimeClient={runtimeClient} />);

    expect(await result.findByRole('header', { name: 'You’re signed in' })).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Sign out' }));

    expect(await result.findByRole('header', { name: 'Welcome to Rewind' })).toBeTruthy();
    expect(result.getByTestId('real-account-session-status')).toHaveTextContent(
      /server says this session has ended.*could not confirm deletion.*credential may remain/i,
    );
    expect(result.getByTestId('real-account-session-status')).not.toHaveTextContent(
      /signed out on this device/i,
    );
    expect(secureStoreMock.token).toBe(nativeToken);
    expect(await AsyncStorage.getItem(signOutMarkerKey)).toBe('remote-revoked');
    expect(await result.findByRole('button', { name: 'Retry local cleanup' })).toBeTruthy();

    secureStoreMock.failClear = false;
    await fireEvent.press(result.getByRole('button', { name: 'Retry local cleanup' }));
    await waitFor(() => expect(secureStoreMock.token).toBeNull());
    expect(await AsyncStorage.getItem(signOutMarkerKey)).toBeNull();
    expect(result.queryByTestId('real-account-session-status')).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('retains the native credential under a pending marker after remote failure and retries across restart', async () => {
    secureStoreMock.token = nativeToken;
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(activeSessionResponse())
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(jsonResponse(200, { signedOut: true })) as typeof fetch;
    const result = await render(<App runtimeClient={runtimeClient} />);

    expect(await result.findByRole('header', { name: 'You’re signed in' })).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Sign out' }));

    expect(await result.findByRole('header', { name: 'Welcome to Rewind' })).toBeTruthy();
    expect(result.queryByRole('header', { name: 'You’re signed in' })).toBeNull();
    expect(result.getByTestId('real-account-session-status')).toHaveTextContent(
      /could not confirm deletion.*server did not confirm revocation.*credential may remain/i,
    );
    expect(await result.findByRole('button', { name: 'Retry sign out' })).toBeTruthy();
    expect(secureStoreMock.token).toBe(nativeToken);
    expect(await AsyncStorage.getItem(signOutMarkerKey)).toBe('pending');

    await result.unmount();
    secureStoreMock.failClear = false;
    const restarted = await render(<App runtimeClient={runtimeClient} />);
    expect(await restarted.findByRole('header', { name: 'Welcome to Rewind' })).toBeTruthy();
    expect(restarted.queryByRole('header', { name: 'You’re signed in' })).toBeNull();
    expect(restarted.getByTestId('real-account-session-status')).toHaveTextContent(
      /sign-out recovery is pending.*will not restore.*revocation may still be unconfirmed/i,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    await fireEvent.press(restarted.getByRole('button', { name: 'Sign in' }));
    await fireEvent.changeText(restarted.getByLabelText('Username'), 'pilot.user');
    await fireEvent.changeText(restarted.getByLabelText('Password'), 'new password');
    await fireEvent.press(restarted.getByTestId('real-account-submit'));
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(restarted.getByTestId('real-account-session-status')).toHaveTextContent(
      /sign-out recovery is pending/i,
    );

    await act(async () => {
      await fireEvent.press(restarted.getByRole('button', { name: 'Retry sign out' }));
    });
    await waitFor(() => expect(secureStoreMock.token).toBeNull());
    expect(await AsyncStorage.getItem(signOutMarkerKey)).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(restarted.queryByTestId('real-account-session-status')).toBeNull();
    expect(await restarted.findByRole('header', { name: 'Sign in' })).toBeTruthy();
    await waitFor(() => expect(restarted.queryByTestId('real-account-session-status')).toBeNull());
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('retains the token if confirmed revocation cannot be recorded, then retries after restart', async () => {
    secureStoreMock.token = nativeToken;
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(activeSessionResponse())
      .mockResolvedValueOnce(jsonResponse(200, { signedOut: true }))
      .mockResolvedValueOnce(jsonResponse(200, { signedOut: true })) as typeof fetch;
    const result = await render(<App runtimeClient={runtimeClient} />);
    expect(await result.findByRole('header', { name: 'You’re signed in' })).toBeTruthy();

    const originalWrite = signOutMarkerStore.write;
    const markerWrite = jest
      .spyOn(signOutMarkerStore, 'write')
      .mockImplementation((marker) =>
        marker === 'remote-revoked'
          ? Promise.reject(new Error('AsyncStorage unavailable'))
          : originalWrite(marker),
      );
    await fireEvent.press(result.getByRole('button', { name: 'Sign out' }));

    expect(await result.findByRole('header', { name: 'Welcome to Rewind' })).toBeTruthy();
    expect(result.getByTestId('real-account-session-status')).toHaveTextContent(
      /sign-out recovery is pending.*will not restore/i,
    );
    expect(secureStoreMock.token).toBe(nativeToken);
    expect(await AsyncStorage.getItem(signOutMarkerKey)).toBe('pending');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    markerWrite.mockRestore();

    await result.unmount();
    const restarted = await render(<App runtimeClient={runtimeClient} />);
    expect(await restarted.findByRole('header', { name: 'Welcome to Rewind' })).toBeTruthy();
    expect(restarted.queryByRole('header', { name: 'You’re signed in' })).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    await fireEvent.press(restarted.getByRole('button', { name: 'Retry sign out' }));
    await waitFor(() => expect(secureStoreMock.token).toBeNull());
    expect(await AsyncStorage.getItem(signOutMarkerKey)).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(
      new Headers(((globalThis.fetch as jest.Mock).mock.calls[2][1] as RequestInit).headers).get(
        'Authorization',
      ),
    ).toBe(`Bearer ${nativeToken}`);
  });

  it('aborts native sign-out when the recovery marker cannot be saved and keeps the account active', async () => {
    secureStoreMock.token = nativeToken;
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(activeSessionResponse())
      .mockResolvedValueOnce(jsonResponse(200, { signedOut: true })) as typeof fetch;
    const result = await render(<App runtimeClient={runtimeClient} />);
    expect(await result.findByRole('header', { name: 'You’re signed in' })).toBeTruthy();

    const markerWrite = jest
      .spyOn(signOutMarkerStore, 'write')
      .mockRejectedValueOnce(new Error('AsyncStorage unavailable'));
    await fireEvent.press(result.getByRole('button', { name: 'Sign out' }));

    expect(await result.findByRole('header', { name: 'You’re signed in' })).toBeTruthy();
    expect(result.getByTestId('logout-unconfirmed')).toHaveTextContent(
      /sign-out did not start.*could not save its recovery state.*still signed in/i,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(secureStoreMock.token).toBe(nativeToken);
    expect(markerWrite).toHaveBeenCalledWith('pending');

    markerWrite.mockRestore();
    await fireEvent.press(result.getByRole('button', { name: 'Retry sign out' }));
    await waitFor(() => expect(secureStoreMock.token).toBeNull());
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(await AsyncStorage.getItem(signOutMarkerKey)).toBeNull();
  });

  it('keeps recovery durable when marker deletion fails after confirmed logout', async () => {
    secureStoreMock.token = nativeToken;
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(activeSessionResponse())
      .mockResolvedValueOnce(jsonResponse(200, { signedOut: true })) as typeof fetch;
    const result = await render(<App runtimeClient={runtimeClient} />);
    expect(await result.findByRole('header', { name: 'You’re signed in' })).toBeTruthy();

    const markerClear = jest
      .spyOn(signOutMarkerStore, 'clear')
      .mockRejectedValueOnce(new Error('AsyncStorage unavailable'));
    await fireEvent.press(result.getByRole('button', { name: 'Sign out' }));

    expect(await result.findByRole('header', { name: 'Welcome to Rewind' })).toBeTruthy();
    expect(secureStoreMock.token).toBeNull();
    expect(await AsyncStorage.getItem(signOutMarkerKey)).toBe('remote-revoked');
    expect(result.getByTestId('real-account-session-status')).toHaveTextContent(
      /server confirmed sign-out.*deleted its saved sign-in.*could not clear the recovery marker/i,
    );
    markerClear.mockRestore();

    await result.unmount();
    const restarted = await render(<App runtimeClient={runtimeClient} />);
    expect(await restarted.findByRole('header', { name: 'Welcome to Rewind' })).toBeTruthy();
    expect(restarted.getByTestId('real-account-session-status')).toHaveTextContent(
      /server says this session has ended.*could not confirm deletion/i,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    await fireEvent.press(restarted.getByRole('button', { name: 'Retry local cleanup' }));
    expect(await AsyncStorage.getItem(signOutMarkerKey)).toBeNull();
    await waitFor(() => expect(restarted.queryByTestId('real-account-session-status')).toBeNull());
    expect(secureStoreMock.token).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the startup marker cannot be read and allows recovery retry', async () => {
    secureStoreMock.token = nativeToken;
    const markerRead = jest
      .spyOn(signOutMarkerStore, 'read')
      .mockRejectedValueOnce(new Error('AsyncStorage unavailable'));
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { signedOut: true })) as typeof fetch;
    const result = await render(<App runtimeClient={runtimeClient} />);

    expect(await result.findByRole('header', { name: 'Welcome to Rewind' })).toBeTruthy();
    expect(result.getByTestId('real-account-session-status')).toHaveTextContent(
      /could not verify sign-out recovery state.*saved sign-in was not restored/i,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(secureStoreMock.token).toBe(nativeToken);

    markerRead.mockRestore();
    await fireEvent.press(result.getByRole('button', { name: 'Retry sign out' }));
    await waitFor(() => expect(secureStoreMock.token).toBeNull());
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(signOutMarkerKey)).toBeNull();
  });

  it('returns web to entry only after the server confirms cookie revocation', async () => {
    useWebPlatform();
    globalThis.fetch = webAccountFetch(() => jsonResponse(200, { signedOut: true }));
    const result = await render(<App runtimeClient={runtimeClient} />);

    expect(await result.findByRole('header', { name: 'Choose a group' })).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Sign out' }));
    expect(await result.findByRole('header', { name: 'Welcome to Rewind' })).toBeTruthy();
    expect(result.queryByTestId('logout-unconfirmed')).toBeNull();
  });
});

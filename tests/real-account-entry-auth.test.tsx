import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';
import { Platform, Share } from 'react-native';

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
const originalInviteWebOrigin = process.env.EXPO_PUBLIC_INVITE_WEB_ORIGIN;

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

function emptyContributionLedger(cycleId: string) {
  return jsonResponse(200, {
    cycleId,
    memberId: apiAccount.id,
    allowance: {
      maxCount: 5,
      maxSeconds: 30,
      countUsed: 0,
      secondsUsed: 0,
      deletionsUsed: 0,
      deletionAvailability: 'available',
    },
    entries: [],
    pagination: { limit: 50, hasMore: false, nextCursor: null },
  });
}

function webAccountFetch(logout: () => Response | Promise<Response>) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/auth/session')) return activeSessionResponse();
    if (url.endsWith('/real/groups/current')) return jsonResponse(200, { group: null });
    if (url.endsWith('/real/groups')) return jsonResponse(200, { groups: [] });
    if (url.endsWith('/auth/logout')) return logout();
    throw new Error(`Unexpected real-account request: ${url}`);
  }) as typeof fetch;
}

function nativeAccountFetch(logout: () => Response | Promise<Response>) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/auth/session')) return activeSessionResponse();
    if (url.endsWith('/real/groups/current')) return jsonResponse(200, { group: null });
    if (url.endsWith('/real/groups')) return jsonResponse(200, { groups: [] });
    if (url.endsWith('/auth/logout')) return logout();
    throw new Error(`Unexpected real-account request: ${url}`);
  }) as typeof fetch;
}

function logoutRequestCount() {
  return (globalThis.fetch as jest.Mock).mock.calls.filter(([url]) =>
    String(url).endsWith('/auth/logout'),
  ).length;
}

function useWebPlatform(href = 'https://rewind.example/') {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web', writable: true });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { href, origin: 'https://rewind.example' },
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
  if (originalInviteWebOrigin === undefined) delete process.env.EXPO_PUBLIC_INVITE_WEB_ORIGIN;
  else process.env.EXPO_PUBLIC_INVITE_WEB_ORIGIN = originalInviteWebOrigin;
  restorePlatform();
});

describe('real account entry flow', () => {
  it('keeps a fresh browser entry screen free of a false expired-session message', async () => {
    useWebPlatform();
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'session_required' })) as typeof fetch;
    const result = await render(<App runtimeClient={runtimeClient} />);

    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
    expect(result.queryByTestId('real-account-session-status')).toBeNull();
    expect(
      result.queryByText(/session expired or an administrator reset your password/i),
    ).toBeNull();
  });

  it('registers a new account and carries the username into its direct sign-in path', async () => {
    useWebPlatform();
    const newAccount = { ...apiAccount, username: 'new.member', displayName: 'new.member' };
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'session_required' }))
      .mockResolvedValueOnce(jsonResponse(201, { account: newAccount }))
      .mockResolvedValueOnce(jsonResponse(200, { account: newAccount, expiresAt }))
      .mockResolvedValueOnce(jsonResponse(200, { group: null }))
      .mockResolvedValueOnce(jsonResponse(200, { groups: [] })) as typeof fetch;

    const result = await render(<App runtimeClient={runtimeClient} />);
    await waitFor(() => expect(result.getByTestId('welcome-entry')).toBeTruthy(), {
      timeout: 5000,
    });
    expect(result.queryByRole('button', { name: 'Try Demo' })).toBeNull();
    await fireEvent.press(result.getByRole('button', { name: 'Create account' }));
    await fireEvent.changeText(result.getByLabelText('Username'), 'new.member');
    await fireEvent.changeText(result.getByLabelText('Password'), 'correct horse battery staple');
    await fireEvent.changeText(
      result.getByLabelText('Confirm password'),
      'correct horse battery staple',
    );
    await fireEvent.press(result.getByTestId('registration-submit'));

    expect(await result.findByTestId('registration-success')).toHaveTextContent(
      'Your account is ready. Sign in to continue.',
    );
    expect(secureStoreMock.token).toBeNull();
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      'https://rewind.example/auth/register',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({
          username: 'new.member',
          password: 'correct horse battery staple',
        }),
      }),
    );

    await fireEvent.press(result.getByTestId('registration-continue-to-sign-in'));
    expect(result.getByLabelText('Username').props.value).toBe('new.member');
    await fireEvent.changeText(result.getByLabelText('Password'), 'correct horse battery staple');
    await fireEvent.press(result.getByTestId('real-account-submit'));
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://rewind.example/auth/login',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(secureStoreMock.token).toBeNull();
  });

  it('keeps an invitation actionable when the invitee registers before signing in', async () => {
    useWebPlatform(
      'https://rewind.example/invite?groupId=real-group-1&code=AB12CD34&expiresAt=2099-09-23T12%3A00%3A00.000Z',
    );
    const newAccount = { ...apiAccount, username: 'invitee.user', displayName: 'invitee.user' };
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'session_required' }))
      .mockResolvedValueOnce(jsonResponse(201, { account: newAccount })) as typeof fetch;

    const result = await render(<App runtimeClient={runtimeClient} />);
    expect(await result.findByTestId('invite-sign-in-intent')).toHaveTextContent(
      'Invitation for group real-group-1 saved. Sign in to continue.',
    );
    await fireEvent.press(result.getByRole('button', { name: 'Create account' }));
    await fireEvent.changeText(result.getByLabelText('Username'), 'invitee.user');
    await fireEvent.changeText(result.getByLabelText('Password'), 'correct horse battery staple');
    await fireEvent.changeText(
      result.getByLabelText('Confirm password'),
      'correct horse battery staple',
    );
    await fireEvent.press(result.getByTestId('registration-submit'));

    expect(await result.findByTestId('registration-success')).toHaveTextContent(
      'Your account is ready. Sign in to accept the invitation.',
    );
    await fireEvent.press(result.getByTestId('registration-continue-to-sign-in'));
    expect(result.getByTestId('invite-sign-in-intent')).toHaveTextContent(
      'Invitation for group real-group-1 saved. Sign in to continue.',
    );
  });

  it('shows duplicate-name and password-confirmation errors without submitting invalid details', async () => {
    useWebPlatform();
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'session_required' }))
      .mockResolvedValueOnce(jsonResponse(409, { error: 'username_unavailable' })) as typeof fetch;
    const result = await render(<App runtimeClient={runtimeClient} />);

    await fireEvent.press(await result.findByRole('button', { name: 'Create account' }));
    await fireEvent.changeText(result.getByLabelText('Username'), 'existing.member');
    await fireEvent.changeText(result.getByLabelText('Password'), 'correct horse battery staple');
    await fireEvent.changeText(result.getByLabelText('Confirm password'), 'different password');
    await fireEvent.press(result.getByTestId('registration-submit'));
    expect(result.getByTestId('registration-error')).toHaveTextContent('Passwords do not match.');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    await fireEvent.changeText(
      result.getByLabelText('Confirm password'),
      'correct horse battery staple',
    );
    await fireEvent.press(result.getByTestId('registration-submit'));
    expect(await result.findByTestId('registration-error')).toHaveTextContent(
      /username is already in use/i,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(secureStoreMock.token).toBeNull();
  });

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

  it('routes a signed-out HTTPS invite through sign-in and retains its intent afterward', async () => {
    useWebPlatform();
    const groupId = 'real-group-invite-123';
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const windowValue = (globalThis as { window: { location: { href: string; origin: string } } })
      .window;
    windowValue.location.href = `https://rewind.example/invite?groupId=${groupId}&code=AB12CD34&expiresAt=${encodeURIComponent(expiresAt)}`;
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'session_required' }))
      .mockResolvedValueOnce(jsonResponse(200, { account: apiAccount, expiresAt }))
      .mockResolvedValueOnce(jsonResponse(200, { group: null }))
      .mockResolvedValueOnce(jsonResponse(200, { groups: [] })) as typeof fetch;

    const result = await render(<App runtimeClient={runtimeClient} />);
    expect(await result.findByTestId('invite-sign-in-intent')).toHaveTextContent(
      new RegExp(groupId),
    );
    expect(result.queryByRole('button', { name: 'Try Demo' })).toBeNull();
    await fireEvent.changeText(result.getByLabelText('Username'), 'pilot.user');
    await fireEvent.changeText(result.getByLabelText('Password'), 'correct password');
    await fireEvent.press(result.getByTestId('real-account-submit'));

    expect(await result.findByTestId('real-invite-intent')).toHaveTextContent(
      /Your group invitation is ready/,
    );
    expect(result.getByTestId('real-invite-intent')).not.toHaveTextContent(groupId);
    expect(result.getByTestId('real-invite-intent')).toHaveTextContent(/Invitation retained/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
    result.unmount();
  });

  it('lets a real owner create, copy, and share a group-specific HTTPS invite', async () => {
    useWebPlatform();
    const groupId = 'real-group-owner-456';
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const realGroup = {
      group: { id: groupId, name: 'Saturday table', role: 'owner', maxMembers: 4 },
      cycle: {
        id: 'cycle-1',
        prompt: 'A moment?',
        startsAt: new Date().toISOString(),
        endsAt: expiresAt,
        quota: { maxCount: 5, maxSeconds: 30 },
        contributionUsage: { countUsed: 0, secondsUsed: 0 },
        contributionCount: 0,
      },
    };
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(activeSessionResponse())
      .mockResolvedValueOnce(jsonResponse(200, { group: realGroup }))
      .mockResolvedValueOnce(jsonResponse(200, { groups: [realGroup] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          group: { id: groupId, name: 'Saturday table' },
          members: [
            { displayName: 'Pilot User', role: 'owner', joinedAt: new Date().toISOString() },
          ],
          pendingInviteCount: 0,
        }),
      )
      .mockResolvedValueOnce(emptyContributionLedger('cycle-1'))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          invite: {
            id: 'real-invite-1',
            code: 'ABCDEF',
            groupId,
            status: 'active',
            createdAt: new Date().toISOString(),
            expiresAt,
          },
        }),
      ) as typeof fetch;
    const copy = jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });

    const result = await render(<App runtimeClient={runtimeClient} />);
    await result.findByRole('header', { name: 'Saturday table' });
    await fireEvent.press(result.getByTestId('real-group-create-invite'));
    const inviteLink = `https://rewind.example/invite?groupId=${groupId}&code=ABCDEF&expiresAt=${encodeURIComponent(expiresAt)}`;
    await waitFor(() =>
      expect(result.getByTestId('real-group-invite-code').props.children).toBe('ABC-DEF'),
    );
    expect(result.getByTestId('real-group-invite-expiry')).toHaveTextContent(/Active/);
    expect(inviteLink).not.toMatch(/session|token|password|authorization/i);

    await fireEvent.press(result.getByTestId('real-group-copy-invite'));
    await waitFor(() => expect(copy).toHaveBeenCalledWith('ABC-DEF'));
    await fireEvent.press(result.getByTestId('real-group-share-invite'));
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('ABC-DEF') }),
      ),
    );
    await fireEvent.press(result.getByRole('button', { name: 'Copy invite link' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(inviteLink));
    expect(globalThis.fetch).toHaveBeenCalledTimes(6);
    result.unmount();
  });

  it('uses the configured public web origin for native invite links, not the API origin', async () => {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: 'ios',
      writable: true,
    });
    process.env.EXPO_PUBLIC_INVITE_WEB_ORIGIN = 'https://share.rewind.example/';
    const groupId = 'real-group-native-789';
    const inviteExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const realGroup = {
      group: { id: groupId, name: 'Sunday walk', role: 'owner', maxMembers: 5 },
      cycle: {
        id: 'cycle-native-1',
        prompt: 'What stayed with you?',
        startsAt: new Date().toISOString(),
        endsAt: inviteExpiry,
        quota: { maxCount: 5, maxSeconds: 30 },
        contributionUsage: { countUsed: 0, secondsUsed: 0 },
        contributionCount: 0,
      },
    };
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { account: apiAccount, token: nativeToken, expiresAt }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { group: realGroup }))
      .mockResolvedValueOnce(jsonResponse(200, { groups: [realGroup] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          group: { id: groupId, name: 'Sunday walk' },
          members: [
            { displayName: 'Pilot User', role: 'owner', joinedAt: new Date().toISOString() },
          ],
          pendingInviteCount: 0,
        }),
      )
      .mockResolvedValueOnce(emptyContributionLedger('cycle-native-1'))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          invite: {
            id: 'real-invite-native-1',
            code: 'EFGHIJ',
            groupId,
            status: 'active',
            createdAt: new Date().toISOString(),
            expiresAt: inviteExpiry,
          },
        }),
      ) as typeof fetch;

    const result = await render(<App runtimeClient={runtimeClient} />);
    await fireEvent.press(await result.findByRole('button', { name: 'Sign in' }));
    await fireEvent.changeText(result.getByLabelText('Username'), 'pilot.user');
    await fireEvent.changeText(result.getByLabelText('Password'), 'correct password');
    await fireEvent.press(result.getByTestId('real-account-submit'));
    await result.findByRole('header', { name: 'Sunday walk' });
    await fireEvent.press(result.getByTestId('real-group-create-invite'));

    const inviteLink = `https://share.rewind.example/invite?groupId=${groupId}&code=EFGHIJ&expiresAt=${encodeURIComponent(inviteExpiry)}`;
    await waitFor(() =>
      expect(result.getByTestId('real-group-invite-code').props.children).toBe('EFG-HIJ'),
    );
    expect(new URL(inviteLink).origin).toBe('https://share.rewind.example');
    expect(inviteLink).not.toContain('https://rewind.example');
    expect(inviteLink).not.toMatch(/session|token|password|authorization/i);
    expect(globalThis.fetch).toHaveBeenCalledTimes(6);
    result.unmount();
  });

  it('stores the native token securely, restores the account, and clears it on sign-out', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { account: apiAccount, token: nativeToken, expiresAt }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { group: null }))
      .mockResolvedValueOnce(jsonResponse(200, { groups: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { signedOut: true })) as typeof fetch;
    const result = await render(<App runtimeClient={runtimeClient} />);

    await fireEvent.press(await result.findByRole('button', { name: 'Sign in' }));
    await fireEvent.changeText(result.getByLabelText('Username'), 'pilot.user');
    await fireEvent.changeText(result.getByLabelText('Password'), 'correct password');
    await fireEvent.press(result.getByTestId('real-account-submit'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(3));

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
    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
    const [groupUrl] = (globalThis.fetch as jest.Mock).mock.calls[1] as [string, RequestInit];
    expect(groupUrl).toBe('https://rewind.example/real/groups/current');
    const [logoutUrl, logoutInit] = (globalThis.fetch as jest.Mock).mock.calls[3] as [
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

    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Sign in' }));
    expect(await result.findByTestId('real-account-offline-status')).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Retry session check' }));
    await waitFor(() => expect(secureStoreMock.token).toBeNull());
    await fireEvent.press(result.getByRole('button', { name: 'Sign in' }));
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

    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
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

      expect(await result.findByTestId('welcome-entry')).toBeTruthy();
      expect(result.getByTestId('real-account-session-status')).toHaveTextContent(
        /server did not confirm revocation.*credential may remain and you may still be signed in/i,
      );
      expect(secureStoreMock.token).toBe(nativeToken);
      const [, logoutInit] = (globalThis.fetch as jest.Mock).mock.calls[3] as [string, RequestInit];
      expect(new Headers(logoutInit.headers).get('Authorization')).toBe(`Bearer ${nativeToken}`);
    },
  );

  it('closes protected UI but offers retry when remote revocation succeeds and SecureStore deletion fails', async () => {
    secureStoreMock.token = nativeToken;
    secureStoreMock.failClear = true;
    globalThis.fetch = nativeAccountFetch(() => jsonResponse(200, { signedOut: true }));
    const result = await render(<App runtimeClient={runtimeClient} />);

    expect(await result.findByRole('header', { name: 'Choose a group' })).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Sign out' }));

    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
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
    expect(
      (globalThis.fetch as jest.Mock).mock.calls.filter(([url]) =>
        String(url).endsWith('/auth/logout'),
      ),
    ).toHaveLength(1);
  });

  it('retains the native credential under a pending marker after remote failure and retries across restart', async () => {
    secureStoreMock.token = nativeToken;
    const logoutResults: (() => Response | Promise<Response>)[] = [
      () => Promise.reject(new Error('offline')),
      () => jsonResponse(200, { signedOut: true }),
    ];
    globalThis.fetch = nativeAccountFetch(() => {
      const result = logoutResults.shift();
      if (!result) throw new Error('Unexpected extra logout request');
      return result();
    });
    const result = await render(<App runtimeClient={runtimeClient} />);

    expect(await result.findByRole('header', { name: 'Choose a group' })).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Sign out' }));

    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
    expect(result.queryByRole('header', { name: 'Choose a group' })).toBeNull();
    expect(result.getByTestId('real-account-session-status')).toHaveTextContent(
      /could not confirm deletion.*server did not confirm revocation.*credential may remain/i,
    );
    expect(await result.findByRole('button', { name: 'Retry sign out' })).toBeTruthy();
    expect(secureStoreMock.token).toBe(nativeToken);
    expect(await AsyncStorage.getItem(signOutMarkerKey)).toBe('pending');

    await result.unmount();
    secureStoreMock.failClear = false;
    const restarted = await render(<App runtimeClient={runtimeClient} />);
    expect(await restarted.findByTestId('welcome-entry')).toBeTruthy();
    expect(restarted.queryByRole('header', { name: 'You’re signed in' })).toBeNull();
    expect(restarted.getByTestId('real-account-session-status')).toHaveTextContent(
      /sign-out recovery is pending.*will not restore.*revocation may still be unconfirmed/i,
    );
    expect(logoutRequestCount()).toBe(1);

    await fireEvent.press(restarted.getByRole('button', { name: 'Sign in' }));
    await fireEvent.changeText(restarted.getByLabelText('Username'), 'pilot.user');
    await fireEvent.changeText(restarted.getByLabelText('Password'), 'new password');
    await fireEvent.press(restarted.getByTestId('real-account-submit'));
    expect(logoutRequestCount()).toBe(1);
    expect(restarted.getByTestId('real-account-session-status')).toHaveTextContent(
      /sign-out recovery is pending/i,
    );

    await act(async () => {
      await fireEvent.press(restarted.getByRole('button', { name: 'Retry sign out' }));
    });
    await waitFor(() => expect(secureStoreMock.token).toBeNull());
    expect(await AsyncStorage.getItem(signOutMarkerKey)).toBeNull();
    expect(logoutRequestCount()).toBe(2);
    expect(restarted.queryByTestId('real-account-session-status')).toBeNull();
    expect(await restarted.findByRole('header', { name: 'Sign in' })).toBeTruthy();
    await waitFor(() => expect(restarted.queryByTestId('real-account-session-status')).toBeNull());
    expect(logoutRequestCount()).toBe(2);
  });

  it('retains the token if confirmed revocation cannot be recorded, then retries after restart', async () => {
    secureStoreMock.token = nativeToken;
    const logoutResults = [
      () => jsonResponse(200, { signedOut: true }),
      () => jsonResponse(200, { signedOut: true }),
    ];
    globalThis.fetch = nativeAccountFetch(() => {
      const result = logoutResults.shift();
      if (!result) throw new Error('Unexpected extra logout request');
      return result();
    });
    const result = await render(<App runtimeClient={runtimeClient} />);
    expect(await result.findByRole('header', { name: 'Choose a group' })).toBeTruthy();

    const originalWrite = signOutMarkerStore.write;
    const markerWrite = jest
      .spyOn(signOutMarkerStore, 'write')
      .mockImplementation((marker) =>
        marker === 'remote-revoked'
          ? Promise.reject(new Error('AsyncStorage unavailable'))
          : originalWrite(marker),
      );
    await fireEvent.press(result.getByRole('button', { name: 'Sign out' }));

    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
    expect(result.getByTestId('real-account-session-status')).toHaveTextContent(
      /sign-out recovery is pending.*will not restore/i,
    );
    expect(secureStoreMock.token).toBe(nativeToken);
    expect(await AsyncStorage.getItem(signOutMarkerKey)).toBe('pending');
    expect(logoutRequestCount()).toBe(1);
    markerWrite.mockRestore();

    await result.unmount();
    const restarted = await render(<App runtimeClient={runtimeClient} />);
    expect(await restarted.findByTestId('welcome-entry')).toBeTruthy();
    expect(restarted.queryByRole('header', { name: 'You’re signed in' })).toBeNull();
    expect(logoutRequestCount()).toBe(1);

    await fireEvent.press(restarted.getByRole('button', { name: 'Retry sign out' }));
    await waitFor(() => expect(secureStoreMock.token).toBeNull());
    expect(await AsyncStorage.getItem(signOutMarkerKey)).toBeNull();
    expect(logoutRequestCount()).toBe(2);
    const logoutCall = (globalThis.fetch as jest.Mock).mock.calls.filter(([url]) =>
      String(url).endsWith('/auth/logout'),
    )[1] as [string, RequestInit];
    expect(new Headers(logoutCall[1].headers).get('Authorization')).toBe(`Bearer ${nativeToken}`);
  });

  it('aborts native sign-out when the recovery marker cannot be saved and keeps the account active', async () => {
    secureStoreMock.token = nativeToken;
    globalThis.fetch = nativeAccountFetch(() => jsonResponse(200, { signedOut: true }));
    const result = await render(<App runtimeClient={runtimeClient} />);
    expect(await result.findByRole('header', { name: 'Choose a group' })).toBeTruthy();

    const markerWrite = jest
      .spyOn(signOutMarkerStore, 'write')
      .mockRejectedValueOnce(new Error('AsyncStorage unavailable'));
    await fireEvent.press(result.getByRole('button', { name: 'Sign out' }));

    expect(await result.findByRole('header', { name: 'Choose a group' })).toBeTruthy();
    expect(result.getByTestId('logout-unconfirmed')).toHaveTextContent(
      /sign-out did not start.*could not save its recovery state.*still signed in/i,
    );
    expect(logoutRequestCount()).toBe(0);
    expect(secureStoreMock.token).toBe(nativeToken);
    expect(markerWrite).toHaveBeenCalledWith('pending');

    markerWrite.mockRestore();
    await fireEvent.press(result.getByRole('button', { name: 'Retry sign out' }));
    await waitFor(() => expect(secureStoreMock.token).toBeNull());
    expect(logoutRequestCount()).toBe(1);
    expect(await AsyncStorage.getItem(signOutMarkerKey)).toBeNull();
  });

  it('keeps recovery durable when marker deletion fails after confirmed logout', async () => {
    secureStoreMock.token = nativeToken;
    globalThis.fetch = nativeAccountFetch(() => jsonResponse(200, { signedOut: true }));
    const result = await render(<App runtimeClient={runtimeClient} />);
    expect(await result.findByRole('header', { name: 'Choose a group' })).toBeTruthy();

    const markerClear = jest
      .spyOn(signOutMarkerStore, 'clear')
      .mockRejectedValueOnce(new Error('AsyncStorage unavailable'));
    await fireEvent.press(result.getByRole('button', { name: 'Sign out' }));

    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
    expect(secureStoreMock.token).toBeNull();
    expect(await AsyncStorage.getItem(signOutMarkerKey)).toBe('remote-revoked');
    expect(result.getByTestId('real-account-session-status')).toHaveTextContent(
      /server confirmed sign-out.*deleted its saved sign-in.*could not clear the recovery marker/i,
    );
    markerClear.mockRestore();

    await result.unmount();
    const restarted = await render(<App runtimeClient={runtimeClient} />);
    expect(await restarted.findByTestId('welcome-entry')).toBeTruthy();
    expect(restarted.getByTestId('real-account-session-status')).toHaveTextContent(
      /server says this session has ended.*could not confirm deletion/i,
    );
    expect(logoutRequestCount()).toBe(1);

    await fireEvent.press(restarted.getByRole('button', { name: 'Retry local cleanup' }));
    expect(await AsyncStorage.getItem(signOutMarkerKey)).toBeNull();
    await waitFor(() => expect(restarted.queryByTestId('real-account-session-status')).toBeNull());
    expect(secureStoreMock.token).toBeNull();
    expect(logoutRequestCount()).toBe(1);
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

    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
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
    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
    expect(result.queryByTestId('logout-unconfirmed')).toBeNull();
  });
});

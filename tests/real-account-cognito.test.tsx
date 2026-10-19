import AsyncStorage from '@react-native-async-storage/async-storage';
import { configure, fireEvent, render, waitFor } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';
import { Platform } from 'react-native';

import App from '../App';

jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);
jest.mock('../src/chat/native-event-source', () => ({
  createRuntimeEventSource: () => ({
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    close: jest.fn(),
    onerror: null,
    onopen: null,
  }),
}));

// Full App renders (fonts, launch fade) are slow when the whole suite runs at once.
configure({ asyncUtilTimeout: 8000 });
jest.setTimeout(30_000);

const originalFetch = globalThis.fetch;
const originalPlatformOS = Platform.OS;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const runtimeClient = { baseUrl: 'https://rewind.example' } as never;
const logoutUrl =
  'https://auth.example.com/logout?client_id=abc&logout_uri=https%3A%2F%2Frewind.example';

const account = {
  id: 'cognito-account',
  username: 'cognito-sub-1',
  displayName: 'Casey Cognito',
  createdAt: '2026-10-08T00:00:00.000Z',
  updatedAt: '2026-10-08T00:00:00.000Z',
};
const group = {
  memberId: 'cognito-profile',
  group: {
    id: 'cognito-group',
    name: 'Our moments',
    role: 'owner',
    maxMembers: 4,
    timeZone: 'UTC',
  },
  cycle: {
    id: 'cognito-cycle',
    prompt: 'A small good thing',
    startsAt: '2026-10-05T00:00:00.000Z',
    endsAt: '2026-11-02T00:00:00.000Z',
    quota: { maxCount: 5, maxSeconds: 30 },
    contributionUsage: { countUsed: 0, secondsUsed: 0 },
    contributionCount: 0,
  },
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

interface ApiOptions {
  config?: { passwordSignIn: boolean; cognito: boolean } | 'error';
  session?: Record<string, unknown> | null;
  profile?: () => Response;
  logout?: () => Response;
  deleteAccount?: () => Response;
}

function useApi(options: ApiOptions = {}) {
  const fetcher = jest.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === '/auth/config') {
      if (options.config === 'error') return json(500, { error: 'unavailable' });
      return json(200, options.config ?? { passwordSignIn: true, cognito: false });
    }
    if (path === '/auth/session') {
      return options.session
        ? json(200, {
            idleExpiresAt: new Date(Date.now() + 3600000).toISOString(),
            absoluteExpiresAt: new Date(Date.now() + 86400000).toISOString(),
            ...options.session,
          })
        : json(401, { error: 'session_required' });
    }
    if (path === '/auth/profile') {
      return options.profile
        ? options.profile()
        : json(200, { account: { ...account, displayName: 'Casey' } });
    }
    if (path === '/auth/logout') {
      return options.logout ? options.logout() : json(200, { signedOut: true });
    }
    if (path === '/auth/account/delete') {
      return options.deleteAccount ? options.deleteAccount() : json(200, { deleted: true });
    }
    if (path === '/real/groups/current') return json(200, { group });
    if (path === '/real/groups') return json(200, { groups: [group] });
    if (path.endsWith('/members'))
      return json(200, { group: group.group, members: [], pendingInviteCount: 0 });
    if (path.endsWith('/reminders'))
      return json(200, { preference: { enabled: false, snoozedUntil: null, timeZone: 'UTC' } });
    if (path === '/contributions')
      return json(200, {
        cycleId: group.cycle.id,
        memberId: group.memberId,
        allowance: {
          maxCount: 5,
          maxSeconds: 30,
          countUsed: 0,
          secondsUsed: 0,
          deletionsUsed: 0,
          deletionAvailability: 'available',
        },
        entries: [],
        latestContribution: null,
        pagination: { limit: 50, hasMore: false, nextCursor: null },
      });
    if (path === '/real/blocks') return json(200, { blocked: [] });
    throw new Error(`Unexpected request: ${path}`);
  });
  globalThis.fetch = fetcher as unknown as typeof fetch;
  return fetcher;
}

function callsTo(fetcher: jest.Mock, path: string) {
  return fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === path);
}

function useWebPlatform(location: { pathname?: string; search?: string } = {}) {
  const pathname = location.pathname ?? '/';
  const search = location.search ?? '';
  const assign = jest.fn();
  const replaceState = jest.fn();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web', writable: true });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        href: `https://rewind.example${pathname}${search}`,
        origin: 'https://rewind.example',
        pathname,
        search,
        assign,
      },
      history: { state: null, replaceState },
    },
    writable: true,
  });
  return { assign, replaceState };
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
  globalThis.fetch = originalFetch;
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    value: originalPlatformOS,
    writable: true,
  });
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: unknown }).window;
});

/** The group screen re-renders as its data loads, so retry until Settings is open. */
async function openSettings(result: Awaited<ReturnType<typeof render>>) {
  await waitFor(async () => {
    if (!result.queryByTestId('real-group-sign-out')) {
      const button = result.queryByTestId('real-account-settings-button');
      if (button) await fireEvent.press(button);
    }
    expect(result.getByTestId('real-group-sign-out')).toBeTruthy();
  });
}

describe('Cognito entry screen', () => {
  it('leads with Cognito and keeps password sign-in behind a developer link', async () => {
    const { assign } = useWebPlatform();
    useApi({ config: { passwordSignIn: true, cognito: true } });
    const result = await render(<App runtimeClient={runtimeClient} />);

    expect(await result.findByTestId('cognito-sign-in')).toBeTruthy();
    expect(result.getByText('Continue with Cognito')).toBeTruthy();
    expect(result.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(result.queryByRole('button', { name: 'Create an account' })).toBeNull();

    await fireEvent.press(result.getByTestId('developer-sign-in'));
    expect(result.queryByTestId('developer-sign-in')).toBeNull();
    expect(result.getByTestId('cognito-sign-in')).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Sign in' }));
    expect(result.getByTestId('real-account-username')).toBeTruthy();
    expect(result.getByTestId('real-account-password')).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it('shows no password UI when the server offers Cognito only', async () => {
    useWebPlatform();
    useApi({ config: { passwordSignIn: false, cognito: true } });
    const result = await render(<App runtimeClient={runtimeClient} />);

    expect(await result.findByTestId('cognito-sign-in')).toBeTruthy();
    expect(result.queryByTestId('developer-sign-in')).toBeNull();
    expect(result.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(result.queryByRole('button', { name: 'Create an account' })).toBeNull();
  });

  it('is unchanged for password-only config', async () => {
    useWebPlatform();
    const fetcher = useApi({ config: { passwordSignIn: true, cognito: false } });
    const result = await render(<App runtimeClient={runtimeClient} />);

    expect(await result.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(result.getByRole('button', { name: 'Create an account' })).toBeTruthy();
    expect(result.queryByTestId('cognito-sign-in')).toBeNull();
    expect(result.queryByTestId('developer-sign-in')).toBeNull();
    expect(callsTo(fetcher, '/auth/config')).toHaveLength(1);
  });

  it('falls back to password sign-in when the config request fails', async () => {
    useWebPlatform();
    useApi({ config: 'error' });
    const result = await render(<App runtimeClient={runtimeClient} />);

    expect(await result.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(result.queryByTestId('cognito-sign-in')).toBeNull();
  });

  it('never asks for the config or offers Cognito on native', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios', writable: true });
    const fetcher = useApi({ config: { passwordSignIn: false, cognito: true } });
    const result = await render(<App runtimeClient={runtimeClient} />);

    expect(await result.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(result.getByRole('button', { name: 'Create an account' })).toBeTruthy();
    expect(result.queryByTestId('cognito-sign-in')).toBeNull();
    expect(callsTo(fetcher, '/auth/config')).toHaveLength(0);
  });

  it('starts the server-side sign-in and returns to the current path', async () => {
    const { assign } = useWebPlatform();
    useApi({ config: { passwordSignIn: false, cognito: true } });
    const result = await render(<App runtimeClient={runtimeClient} />);

    await fireEvent.press(await result.findByTestId('cognito-sign-in'));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('https://rewind.example/auth/cognito/start?return=%2F');
  });

  it('keeps a saved invitation through the Cognito round trip', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const search = `?groupId=real-group-1&code=AB12CD34&expiresAt=${encodeURIComponent(expiresAt)}`;
    const { assign } = useWebPlatform({ pathname: '/invite', search });
    useApi({ config: { passwordSignIn: true, cognito: true } });
    const result = await render(<App runtimeClient={runtimeClient} />);

    expect(await result.findByTestId('invite-sign-in-intent')).toHaveTextContent(
      'Your invitation is saved. Sign in to join the group.',
    );
    expect(result.queryByTestId('real-account-username')).toBeNull();
    await fireEvent.press(result.getByTestId('developer-sign-in'));
    expect(result.getByTestId('real-account-username')).toBeTruthy();

    await fireEvent.press(result.getByTestId('cognito-sign-in'));
    expect(assign).toHaveBeenCalledWith(
      `https://rewind.example/auth/cognito/start?return=${encodeURIComponent(`/invite${search}`)}`,
    );
  });

  it.each([
    ['cognito', "Cognito sign-in didn't complete. Try again."],
    ['cognito_denied', 'Cognito sign-in was cancelled. Try again when you are ready.'],
  ])('explains a failed return (%s) and cleans the URL', async (code, message) => {
    const { replaceState } = useWebPlatform({ pathname: '/', search: `?auth_error=${code}` });
    useApi({ config: { passwordSignIn: false, cognito: true } });
    const result = await render(<App runtimeClient={runtimeClient} />);

    expect(await result.findByTestId('real-account-session-status')).toHaveTextContent(message);
    expect(result.getByTestId('cognito-sign-in')).toBeTruthy();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });
});

describe('display name after the first Cognito sign-in', () => {
  const nameless = { account: { ...account, displayName: '' }, signInMethod: 'cognito' };

  it('asks for a name before the group experience and saves it', async () => {
    useWebPlatform();
    const fetcher = useApi({ session: nameless });
    const result = await render(<App runtimeClient={runtimeClient} />);

    expect(await result.findByText('What should we call you?')).toBeTruthy();
    expect(callsTo(fetcher, '/real/groups/current')).toHaveLength(0);
    expect(result.getByTestId('display-name-submit')).toBeDisabled();

    await fireEvent.changeText(result.getByTestId('display-name-input'), '   ');
    expect(result.getByTestId('display-name-submit')).toBeDisabled();
    await fireEvent.changeText(result.getByTestId('display-name-input'), ' Casey ');
    await fireEvent.press(result.getByTestId('display-name-submit'));

    expect(await result.findByTestId('real-group-home')).toBeTruthy();
    expect(result.queryByTestId('display-name-screen')).toBeNull();
    const [[, init]] = callsTo(fetcher, '/auth/profile');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ displayName: 'Casey' }) });
  });

  it('shows an inline error and stays when the name cannot be saved', async () => {
    useWebPlatform();
    useApi({ session: nameless, profile: () => json(500, { error: 'unavailable' }) });
    const result = await render(<App runtimeClient={runtimeClient} />);

    await fireEvent.changeText(await result.findByTestId('display-name-input'), 'Casey');
    await fireEvent.press(result.getByTestId('display-name-submit'));

    expect(await result.findByTestId('display-name-error')).toHaveTextContent(
      /We could not save your name/,
    );
    expect(result.getByTestId('display-name-screen')).toBeTruthy();
  });

  it('does not ask accounts that already have a name', async () => {
    useWebPlatform();
    useApi({ session: { account } });
    const result = await render(<App runtimeClient={runtimeClient} />);

    expect(await result.findByTestId('real-group-home')).toBeTruthy();
    expect(result.queryByTestId('display-name-screen')).toBeNull();
  });
});

describe('Cognito account lifecycle', () => {
  const cognitoSession = { account, signInMethod: 'cognito' };

  it('follows the provider sign-out URL after signing out locally', async () => {
    const { assign } = useWebPlatform();
    const fetcher = useApi({
      session: cognitoSession,
      logout: () => json(200, { signedOut: true, logoutUrl }),
    });
    const result = await render(<App runtimeClient={runtimeClient} />);

    await openSettings(result);
    await fireEvent.press(await result.findByTestId('real-group-sign-out'));
    await fireEvent.press(await result.findByTestId('real-group-sign-out-confirm'));

    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
    expect(callsTo(fetcher, '/auth/logout')).toHaveLength(1);
    expect(assign).toHaveBeenCalledWith(logoutUrl);
  });

  it('does not navigate away when sign-out has no provider URL', async () => {
    const { assign } = useWebPlatform();
    useApi({ session: { account } });
    const result = await render(<App runtimeClient={runtimeClient} />);

    await openSettings(result);
    await fireEvent.press(await result.findByTestId('real-group-sign-out'));
    await fireEvent.press(await result.findByTestId('real-group-sign-out-confirm'));

    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it('asks a Cognito account to type DELETE and sends the confirmation', async () => {
    const { assign } = useWebPlatform();
    const fetcher = useApi({
      session: cognitoSession,
      deleteAccount: () => json(200, { deleted: true, logoutUrl }),
    });
    const result = await render(<App runtimeClient={runtimeClient} />);

    await openSettings(result);
    await fireEvent.press(await result.findByTestId('real-settings-delete'));
    expect(result.queryByTestId('real-delete-password')).toBeNull();
    const confirmation = result.getByTestId('real-delete-confirmation');
    expect(result.getByTestId('real-delete-account')).toBeDisabled();
    await fireEvent.changeText(confirmation, 'delete');
    expect(result.getByTestId('real-delete-account')).toBeDisabled();
    await fireEvent.changeText(confirmation, 'DELETE');
    await fireEvent.press(result.getByTestId('real-delete-account'));
    expect(callsTo(fetcher, '/auth/account/delete')).toHaveLength(0);
    await fireEvent.press(result.getByTestId('real-delete-confirm'));

    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
    const [[, init]] = callsTo(fetcher, '/auth/account/delete');
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ confirmation: 'DELETE' }),
    });
    await waitFor(() => expect(assign).toHaveBeenCalledWith(logoutUrl));
  });

  it('keeps asking password sessions for their password', async () => {
    useWebPlatform();
    const fetcher = useApi({ session: { account, signInMethod: 'password' } });
    const result = await render(<App runtimeClient={runtimeClient} />);

    await openSettings(result);
    await fireEvent.press(await result.findByTestId('real-settings-delete'));
    expect(result.queryByTestId('real-delete-confirmation')).toBeNull();
    await fireEvent.changeText(result.getByTestId('real-delete-password'), 'a password');
    await fireEvent.press(result.getByTestId('real-delete-account'));
    await fireEvent.press(result.getByTestId('real-delete-confirm'));

    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
    const [[, init]] = callsTo(fetcher, '/auth/account/delete');
    expect(init).toMatchObject({ body: JSON.stringify({ password: 'a password' }) });
  });
});

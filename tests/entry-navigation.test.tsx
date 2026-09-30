import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';
import { Platform } from 'react-native';

import App from '../App';
import type { DemoSession, DemoSessionStore } from '../src/domain/session';
import { LocalRuntimeError, type RuntimeClient } from '../src/runtime/local-runtime-client';

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

beforeAll(() => {
  process.env.REWIND_TEST_DEMO_FIXTURE = 'false';
});

function session(overrides: Partial<DemoSession> = {}): DemoSession {
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  return {
    id: 'demo-session-test',
    accessKind: 'demo',
    actor: { memberId: 'demo-1', displayName: 'Amber', isSynthetic: true },
    groupId: 'demo-group',
    startedAt,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    invalidatedAt: null,
    ...overrides,
  };
}

function sessionStore(initial: DemoSession | null = null): DemoSessionStore {
  let saved = initial;
  return {
    load: async () => saved,
    save: async (next) => {
      saved = next;
    },
    clear: async () => {
      saved = null;
    },
  };
}

describe('first-run and session entry navigation', () => {
  it('shows only Rewind branding while the saved session is being restored', async () => {
    let finishLoad!: (value: DemoSession | null) => void;
    const store: DemoSessionStore = {
      load: () => new Promise((resolve) => (finishLoad = resolve)),
      save: async () => {},
      clear: async () => {},
    };
    const result = await render(<App sessionStore={store} />);

    expect(result.getByLabelText('Rewind')).toBeTruthy();
    expect(result.getByText('REWIND')).toBeTruthy();
    expect(result.getByText('PRIVATE MOMENTS, SHARED TOGETHER')).toBeTruthy();
    expect(result.queryByRole('button', { name: 'Create account' })).toBeNull();
    expect(result.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(result.queryByRole('button', { name: 'Try Demo' })).toBeNull();

    await act(async () => finishLoad(null));
    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
    expect(result.getByRole('button', { name: 'Create account' })).toBeTruthy();
  });

  it('shows branded welcome on a fresh install without creating Amber', async () => {
    const store = sessionStore();
    const result = await render(<App sessionStore={store} />);

    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
    expect(result.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(result.queryByRole('button', { name: 'Try Demo' })).toBeNull();
    expect(result.getAllByText('PRIVATE MOMENTS, SHARED TOGETHER')).toHaveLength(1);
    expect(result.queryByText(/sample Demo data|Welcome to Rewind/i)).toBeNull();
    expect(result.queryByRole('header', { name: 'Weekend People' })).toBeNull();
    expect(await store.load()).toBeNull();
  });

  it('opens sign-in, account registration, and Demo only through Sign in without creating a real session', async () => {
    const store = sessionStore();
    const result = await render(<App sessionStore={store} />);

    await fireEvent.press(await result.findByRole('button', { name: 'Sign in' }));
    expect(result.getByText('PRIVATE MOMENTS, SHARED TOGETHER')).toBeTruthy();
    expect(result.getByLabelText('Username')).toBeTruthy();
    expect(result.getByLabelText('Password')).toBeTruthy();
    expect(result.getByText(/password will not be sent over an insecure connection/)).toBeTruthy();
    expect(await store.load()).toBeNull();

    await fireEvent.press(result.getByTestId('sign-in-create-account'));
    expect(result.getByLabelText('Confirm password')).toBeTruthy();
    expect(await store.load()).toBeNull();
    await fireEvent.press(result.getByRole('button', { name: 'Back' }));
    await fireEvent.press(result.getByRole('button', { name: 'Sign in' }));
    expect(result.queryByRole('button', { name: 'Try Demo' })).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Try Demo' }));
    expect(result.getByRole('header', { name: 'Choose a Demo member' })).toBeTruthy();
    expect(result.getByRole('button', { name: 'Back to sign in' })).toBeTruthy();
    await fireEvent.press(
      result.getByRole('button', { name: 'Enter Demo as Amber, sample member' }),
    );

    expect(await result.findByRole('header', { name: 'Weekend People' })).toBeTruthy();
    await waitFor(async () => expect((await store.load())?.accessKind).toBe('demo'));
  });

  it('keeps Demo available from Sign in over HTTP while disabling real credentials', async () => {
    const originalPlatform = Platform.OS;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web', writable: true });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { href: 'http://rewind.example/', origin: 'http://rewind.example' } },
      writable: true,
    });

    try {
      const store = sessionStore();
      const result = await render(
        <App
          sessionStore={store}
          runtimeClient={{ baseUrl: 'http://rewind.example' } as RuntimeClient}
        />,
      );

      expect(await result.findByTestId('welcome-entry')).toBeTruthy();
      expect(result.queryByRole('button', { name: 'Try Demo' })).toBeNull();
      expect(result.queryByText(/sign-in service could not be reached/i)).toBeNull();
      expect(result.queryByText(/secure HTTPS connection/i)).toBeNull();
      await fireEvent.press(result.getByRole('button', { name: 'Sign in' }));
      expect(
        result.getByText(/password will not be sent over an insecure connection/i),
      ).toBeTruthy();
      expect(result.getByTestId('real-account-submit').props.accessibilityState?.disabled).toBe(
        true,
      );
      await fireEvent.press(result.getByRole('button', { name: 'Try Demo' }));
      expect(result.getByRole('header', { name: 'Choose a Demo member' })).toBeTruthy();
      expect(result.queryByText(/sign-in service could not be reached/i)).toBeNull();

      await fireEvent.press(result.getByRole('button', { name: 'Back to sign in' }));
      expect(result.getAllByRole('alert')).toHaveLength(1);
      expect(await store.load()).toBeNull();
    } finally {
      Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: originalPlatform,
        writable: true,
      });
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else delete (globalThis as { window?: unknown }).window;
    }
  });

  it('restores a valid saved Demo session into the app shell', async () => {
    const result = await render(<App sessionStore={sessionStore(session())} />);

    expect(await result.findByRole('header', { name: 'Weekend People' })).toBeTruthy();
    expect(result.queryByTestId('welcome-entry')).toBeNull();
  });

  it('returns an expired saved session to welcome with an expiry explanation', async () => {
    const expired = session({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const result = await render(<App sessionStore={sessionStore(expired)} />);

    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
    expect(result.queryByText(/Your saved Demo session has expired/)).toBeNull();
    await fireEvent.press(result.getByRole('button', { name: 'Sign in' }));
    expect(result.getByText(/Your saved Demo session has expired/)).toBeTruthy();
    expect(result.queryByRole('header', { name: 'Weekend People' })).toBeNull();
  });

  it('shows a readable offline state without treating a saved session as active', async () => {
    const client = {
      getDemoSession: jest
        .fn()
        .mockRejectedValue(new LocalRuntimeError('Runtime offline', undefined, 'runtime_offline')),
    } as unknown as RuntimeClient;
    const result = await render(
      <App sessionStore={sessionStore(session())} runtimeClient={client} />,
    );

    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
    expect(result.queryByLabelText('Offline status')).toBeNull();
    await fireEvent.press(result.getByRole('button', { name: 'Sign in' }));
    expect(result.getByLabelText('Offline status')).toBeTruthy();
    expect(result.getByText(/The runtime is unreachable/)).toBeTruthy();
    expect(result.queryByRole('header', { name: 'Weekend People' })).toBeNull();
  });
});

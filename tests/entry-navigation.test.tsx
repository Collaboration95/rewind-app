import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import App from '../App';
import type { DemoSession, DemoSessionStore } from '../src/domain/session';
import { LocalRuntimeError, type RuntimeClient } from '../src/runtime/local-runtime-client';

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
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
    expect(result.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(result.queryByRole('button', { name: 'Try Demo' })).toBeNull();

    await act(async () => finishLoad(null));
    expect(await result.findByRole('header', { name: 'Welcome to Rewind' })).toBeTruthy();
  });

  it('shows branded welcome on a fresh install without creating Amber', async () => {
    const store = sessionStore();
    const result = await render(<App sessionStore={store} />);

    expect(await result.findByRole('header', { name: 'Welcome to Rewind' })).toBeTruthy();
    expect(result.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(result.getByRole('button', { name: 'Try Demo' })).toBeTruthy();
    expect(result.queryByRole('header', { name: 'Weekend People' })).toBeNull();
    expect(await store.load()).toBeNull();
  });

  it('keeps Sign in truthful and creates no session until an explicit Demo choice', async () => {
    const store = sessionStore();
    const result = await render(<App sessionStore={store} />);

    await fireEvent.press(await result.findByRole('button', { name: 'Sign in' }));
    expect(
      result.getByText(/Real account sign-in is not available in this build yet/),
    ).toBeTruthy();
    expect(await store.load()).toBeNull();

    await fireEvent.press(result.getByRole('button', { name: 'Back to welcome' }));
    await fireEvent.press(result.getByRole('button', { name: 'Try Demo' }));
    expect(result.getByRole('header', { name: 'Choose a Demo member' })).toBeTruthy();
    await fireEvent.press(
      result.getByRole('button', { name: 'Enter Demo as Amber, sample member' }),
    );

    expect(await result.findByRole('header', { name: 'Weekend People' })).toBeTruthy();
    await waitFor(async () => expect((await store.load())?.accessKind).toBe('demo'));
  });

  it('restores a valid saved Demo session into the app shell', async () => {
    const result = await render(<App sessionStore={sessionStore(session())} />);

    expect(await result.findByRole('header', { name: 'Weekend People' })).toBeTruthy();
    expect(result.queryByRole('header', { name: 'Welcome to Rewind' })).toBeNull();
  });

  it('returns an expired saved session to welcome with an expiry explanation', async () => {
    const expired = session({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const result = await render(<App sessionStore={sessionStore(expired)} />);

    expect(await result.findByRole('header', { name: 'Welcome to Rewind' })).toBeTruthy();
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

    expect(await result.findByRole('header', { name: 'Welcome to Rewind' })).toBeTruthy();
    expect(result.getByLabelText('Offline status')).toBeTruthy();
    expect(result.getByText(/The runtime is unreachable/)).toBeTruthy();
    expect(result.queryByRole('header', { name: 'Weekend People' })).toBeNull();
  });
});

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';
import { AccessibilityInfo, Animated, Platform } from 'react-native';

import App from '../App';

const mockSecureStore = { read: async (): Promise<string | null> => null };

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: () => mockSecureStore.read(),
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

const secureRuntime = { baseUrl: 'https://rewind.example' };

afterEach(() => {
  mockSecureStore.read = async () => null;
  jest.restoreAllMocks();
});

let entryTransition: jest.SpyInstance;
beforeEach(() => {
  entryTransition = jest.spyOn(Animated, 'timing').mockImplementation(() => ({
    start: jest.fn(),
    stop: jest.fn(),
    reset: jest.fn(),
  }));
});

describe('first-run and session entry navigation', () => {
  it('shows the cold-launch screen for at least 600ms after fast session restoration', async () => {
    jest.useFakeTimers();
    try {
      const result = await render(<App runtimeClient={null} />);

      expect(result.getByLabelText('Rewind')).toBeTruthy();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(599);
      });
      expect(result.getByLabelText('Rewind')).toBeTruthy();

      await act(async () => {
        await jest.advanceTimersByTimeAsync(1);
      });
      expect(result.getByTestId('welcome-entry')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows only Rewind branding while the saved sign-in is being restored', async () => {
    let finishRead: ((value: string | null) => void) | undefined;
    mockSecureStore.read = () => new Promise((resolve) => (finishRead = resolve));
    const result = await render(<App runtimeClient={secureRuntime} />);
    await waitFor(() => expect(finishRead).toBeDefined());

    expect(result.getByLabelText('Rewind')).toBeTruthy();
    expect(result.getByText('Rewind')).toBeTruthy();
    expect(result.getByText('Opening…')).toBeTruthy();
    expect(result.queryByRole('button', { name: 'Create account' })).toBeNull();
    expect(result.queryByRole('button', { name: 'Sign in' })).toBeNull();

    await act(async () => finishRead?.(null));
    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
    expect(result.getByRole('button', { name: 'Create an account' })).toBeTruthy();
  });

  it('shows branded welcome on a fresh install with only account entry points', async () => {
    const result = await render(<App runtimeClient={null} />);

    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
    expect(result.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(result.getByRole('button', { name: 'Create an account' })).toBeTruthy();
    expect(
      result.getAllByText('Small moments with your people, opened together every 4 weeks.'),
    ).toHaveLength(1);
    // The synthetic Demo is gone: Welcome offers no Demo entry of any kind.
    expect(result.queryByTestId('try-demo')).toBeNull();
    expect(result.queryByText(/Demo/)).toBeNull();
    expect(result.queryByLabelText(/Demo/)).toBeNull();
  });

  it.each([false, true])(
    'animates entry changes only when reduced motion is disabled (reduce motion: %s)',
    async (reduceMotion) => {
      const reducedMotionSetting = jest
        .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
        .mockResolvedValue(reduceMotion);
      const result = await render(<App runtimeClient={null} />);
      expect(await result.findByTestId('welcome-entry')).toBeTruthy();
      await waitFor(() => expect(reducedMotionSetting).toHaveBeenCalled());
      await act(async () => {
        await Promise.resolve();
      });

      await fireEvent.press(result.getByRole('button', { name: 'Sign in' }));
      if (reduceMotion) {
        expect(entryTransition).not.toHaveBeenCalled();
      } else {
        expect(entryTransition).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ duration: 160, toValue: 0 }),
        );
      }
    },
  );

  it('opens sign-in and account registration without a Demo option', async () => {
    const result = await render(<App runtimeClient={null} />);

    await fireEvent.press(await result.findByRole('button', { name: 'Sign in' }));
    expect(result.getByRole('header', { name: 'Sign in' })).toBeTruthy();
    expect(result.queryByText(/Demo/)).toBeNull();
    expect(result.getByLabelText('Username')).toBeTruthy();
    expect(result.getByLabelText('Password')).toBeTruthy();
    expect(result.getByText(/password will not be sent over an insecure connection/)).toBeTruthy();

    await fireEvent.press(result.getByTestId('sign-in-create-account'));
    expect(result.getByLabelText('Confirm password')).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Back' }));
    expect(await result.findByTestId('welcome-entry')).toBeTruthy();
    expect(result.queryByText(/Demo/)).toBeNull();
  });

  it('disables real credentials over HTTP without a false service error', async () => {
    const originalPlatform = Platform.OS;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web', writable: true });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { href: 'http://rewind.example/', origin: 'http://rewind.example' } },
      writable: true,
    });

    try {
      const result = await render(<App runtimeClient={{ baseUrl: 'http://rewind.example' }} />);

      expect(await result.findByTestId('welcome-entry')).toBeTruthy();
      expect(result.queryByText(/sign-in service could not be reached/i)).toBeNull();
      expect(result.queryByText(/secure HTTPS connection/i)).toBeNull();
      await fireEvent.press(result.getByRole('button', { name: 'Sign in' }));
      expect(
        result.getByText(/password will not be sent over an insecure connection/i),
      ).toBeTruthy();
      expect(result.getByTestId('real-account-submit').props.accessibilityState?.disabled).toBe(
        true,
      );
      await fireEvent.press(result.getByRole('button', { name: 'Back to welcome' }));
      expect(await result.findByTestId('welcome-entry')).toBeTruthy();
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
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import App from '../App';
import type { Cycle, CycleRepository } from '../src/domain/cycles';
import { SELECTION_KEY } from '../src/data/selection-store';
import type { SelectionStore } from '../src/domain/profiles';
import { DemoProfilePicker } from '../src/profiles/DemoProfilePicker';
import { DemoProfileProvider } from '../src/profiles/DemoProfileProvider';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockStatusBar = jest.fn((_props: { style?: string }) => null);

jest.mock('expo-status-bar', () => ({
  StatusBar: (props: { style?: string }) => mockStatusBar(props),
}));

jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

beforeEach(async () => {
  await AsyncStorage.clear();
  mockStatusBar.mockClear();
});

function picker(store: SelectionStore) {
  return render(
    <DemoProfileProvider store={store}>
      <DemoProfilePicker />
    </DemoProfileProvider>,
  );
}

const TEST_NOW = Date.parse('2026-01-01T00:00:00.000Z');

function cycleFixture(overrides: Partial<Cycle> = {}): Cycle {
  return {
    id: 'demo-cycle',
    groupId: 'demo-group',
    prompt: 'What made you pause and smile?',
    startsAt: new Date(TEST_NOW - 60_000).toISOString(),
    endsAt: new Date(TEST_NOW + 2 * 60 * 60 * 1000).toISOString(),
    status: 'collecting',
    lockState: 'locked',
    quota: { maxCount: 5, maxSeconds: 30 },
    contributionUsage: { countUsed: 0, secondsUsed: 0 },
    ...overrides,
  };
}

function cycleRepository(
  result: Cycle | { kind: 'NotFound' | 'RecoverableFailure' },
): CycleRepository {
  return {
    getCurrentCycle: jest.fn().mockResolvedValue(result),
  };
}

describe('Rewind Home start screen', () => {
  it('keeps the application inside the device safe area', async () => {
    const result = await render(<App />);

    expect(result.getByTestId('application-safe-area')).toBeTruthy();
  });

  it('uses a light status bar on the dark application shell', async () => {
    await render(<App />);

    expect(mockStatusBar).toHaveBeenCalledWith({ style: 'light' });
  });

  it('shows the sample group, local-demo capsule summary, and profile picker', async () => {
    const result = await render(<App />);

    expect(result.getByRole('header', { name: 'Weekend People' })).toBeTruthy();
    expect(result.getByLabelText('Local demo data')).toBeTruthy();
    expect(result.getByRole('header', { name: 'Local demo' })).toBeTruthy();
    expect(result.getByLabelText('Current capsule. 2 days remaining.')).toBeTruthy();
    expect(result.getByLabelText('Current prompt: What made you pause and smile?')).toBeTruthy();
    expect(result.getByLabelText(/0 of 5 contributions used/)).toBeTruthy();
    await result.findByText('Current member: Amber');
  });

  it('starts on Home and makes every main area reachable', async () => {
    const result = await render(<App />);

    expect(result.getByRole('header', { name: 'Weekend People' })).toBeTruthy();

    for (const area of [
      { key: 'camera', label: 'Camera' },
      { key: 'chat', label: 'Chat' },
      { key: 'archive', label: 'Archive' },
    ]) {
      await fireEvent.press(result.getByTestId(`nav-${area.key}`));

      if (area.key === 'camera') {
        expect(await result.findByRole('header', { name: 'Add a still moment' })).toBeTruthy();
      } else {
        expect(result.getByRole('header', { name: area.label })).toBeTruthy();
      }
    }
  });

  it('provides named tabs with a visible and accessible selected state', async () => {
    const result = await render(<App />);

    expect(result.getByRole('tab', { name: 'Home', selected: true })).toBeTruthy();
    expect(result.getByText('SELECTED')).toBeTruthy();

    await fireEvent.press(result.getByRole('tab', { name: 'Chat' }));

    expect(result.getByRole('tab', { name: 'Chat', selected: true })).toBeTruthy();
    expect(result.getAllByText('SELECTED')).toHaveLength(1);
  });

  it('uses an honest permission state for Camera and unavailable states elsewhere', async () => {
    const result = await render(<App />);

    await fireEvent.press(result.getByRole('tab', { name: 'Camera' }));
    expect(await result.findByTestId('camera-capability-undecided')).toBeTruthy();

    await fireEvent.press(result.getByRole('tab', { name: 'Chat' }));
    expect(
      result.getByText('Chat is not implemented. No messages are being sent or stored.'),
    ).toBeTruthy();

    await fireEvent.press(result.getByRole('tab', { name: 'Archive' }));
    expect(
      result.getByText(
        'Archive playback is not implemented. Locked moments remain unavailable until reveal.',
      ),
    ).toBeTruthy();
  });

  it('keeps sample moments sealed and does not claim Camera is available', async () => {
    const result = await render(<App />);

    expect(result.getByLabelText('Locked demo moment 1 of 3')).toBeTruthy();
    expect(result.getByLabelText('Locked demo moment 2 of 3')).toBeTruthy();
    expect(result.getByLabelText('Locked demo moment 3 of 3')).toBeTruthy();
    expect(result.getByRole('button', { name: 'Add a moment', disabled: true })).toBeTruthy();
    expect(
      result.getByText('Camera capture stays local and starts from the Camera tab.'),
    ).toBeTruthy();
  });

  it('shows the repository-backed prompt, countdown, quota, and locked-safe state', async () => {
    const result = await render(<App />);

    expect(result.getByTestId('cycle-countdown')).toBeTruthy();
    expect(result.getByText('0 of 5 contributions')).toBeTruthy();
    expect(result.getByText(/0 of 30 seconds used/)).toBeTruthy();
    expect(result.getByLabelText(/Contributions are collecting and locked/)).toBeTruthy();
    expect(result.queryAllByRole('image')).toHaveLength(0);
    expect(result.queryByRole('button', { name: /share/i })).toBeNull();
  });

  it('uses changed seeded quota metadata from the cycle repository', async () => {
    const result = await render(
      <App
        clock={() => TEST_NOW}
        cycleRepository={cycleRepository(
          cycleFixture({
            quota: { maxCount: 9, maxSeconds: 45 },
            contributionUsage: { countUsed: 2, secondsUsed: 11 },
          }),
        )}
      />,
    );

    await result.findByText('2 of 9 contributions');
    expect(result.getByText(/11 of 45 seconds used/)).toBeTruthy();
    expect(result.getByLabelText(/2 of 9 contributions used/)).toBeTruthy();
  });

  it('reads the capsule for the selected synthetic member', async () => {
    const getCurrentCycle = jest.fn().mockResolvedValue(cycleFixture());
    const result = await render(<App cycleRepository={{ getCurrentCycle }} />);

    await result.findByTestId('capsule-ready');
    await fireEvent.press(result.getByRole('button', { name: 'Choose Clover, sample member' }));
    await waitFor(() => expect(getCurrentCycle).toHaveBeenLastCalledWith('demo-group', 'demo-3'));
  });

  it('shows an understandable loading state while the capsule is fetched', async () => {
    let resolveCycle!: (cycle: Cycle) => void;
    const repository: CycleRepository = {
      getCurrentCycle: jest.fn(
        () =>
          new Promise<Cycle>((resolve) => {
            resolveCycle = resolve;
          }),
      ),
    };
    const result = await render(<App cycleRepository={repository} />);

    expect(result.getByTestId('capsule-loading')).toBeTruthy();
    await act(async () => resolveCycle(cycleFixture()));
    await result.findByTestId('capsule-ready');
  });

  it('distinguishes an empty capsule from a recoverable failure and supports retry', async () => {
    const empty = await render(<App cycleRepository={cycleRepository({ kind: 'NotFound' })} />);
    await empty.findByTestId('capsule-empty');
    expect(empty.getByText('No active capsule')).toBeTruthy();
    await empty.unmount();

    const getCurrentCycle = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'RecoverableFailure' as const })
      .mockResolvedValueOnce(cycleFixture());
    const retryResult = await render(<App cycleRepository={{ getCurrentCycle }} />);
    await retryResult.findByTestId('capsule-error');
    await fireEvent.press(retryResult.getByRole('button', { name: 'Retry loading capsule' }));
    await retryResult.findByTestId('capsule-ready');
    expect(getCurrentCycle).toHaveBeenCalledTimes(2);
  });
});

describe('Local demo profile flow', () => {
  it('offers five accessible choices, remembers selection on relaunch, and resets cleanly', async () => {
    const result = await render(<App />);
    expect(result.getByRole('header', { name: 'Weekend People' })).toBeTruthy();
    expect(result.getByRole('header', { name: 'Local demo' })).toBeTruthy();
    await result.findByText('Current member: Amber');
    expect(result.getAllByRole('button', { name: /Choose .*sample member/ })).toHaveLength(5);
    await fireEvent.press(result.getByRole('button', { name: 'Choose Clover, sample member' }));
    expect(result.getByText('Current member: Clover')).toBeTruthy();
    expect(
      result.getByRole('button', { name: 'Choose Clover, sample member, selected' }),
    ).toBeTruthy();
    await waitFor(async () => expect(await AsyncStorage.getItem(SELECTION_KEY)).toBe('demo-3'));
    await result.unmount();
    const relaunched = await render(<App />);
    await relaunched.findByText('Current member: Clover');
    await relaunched.unmount();
    await AsyncStorage.clear();
    const reset = await render(<App />);
    await reset.findByText('Current member: Amber');
  });

  it('falls back to the default for an unknown stored actor', async () => {
    await AsyncStorage.setItem(SELECTION_KEY, 'outsider');
    const result = await render(<App />);
    await result.findByText('Current member: Amber');
  });

  it('waits for saved selection before enabling choices', async () => {
    let finishLoad!: (id: string) => void;
    const result = await picker({
      load: () =>
        new Promise((resolve) => {
          finishLoad = resolve;
        }),
      save: async () => {},
    });
    expect(result.getByText('Loading your demo profile…')).toBeTruthy();
    expect(result.queryAllByRole('button')).toHaveLength(0);
    await act(async () => finishLoad('demo-4'));
    expect(result.getByText('Current member: Dune')).toBeTruthy();
  });

  it('switches immediately but serializes writes so the latest choice wins', async () => {
    let finishFirst!: () => void;
    let savedId: string | null = null;
    const save = jest
      .fn()
      .mockImplementationOnce(
        (id: string) =>
          new Promise<void>((resolve) => {
            finishFirst = () => {
              savedId = id;
              resolve();
            };
          }),
      )
      .mockImplementation(async (id: string) => {
        savedId = id;
      });
    const result = await picker({ load: async () => null, save });
    await result.findByText('Current member: Amber');
    await fireEvent.press(result.getByRole('button', { name: 'Choose Birch, sample member' }));
    await fireEvent.press(result.getByRole('button', { name: 'Choose Echo, sample member' }));
    expect(result.getByText('Current member: Echo')).toBeTruthy();
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => finishFirst());
    await waitFor(() => expect(savedId).toBe('demo-5'));
    expect(save.mock.calls.map(([id]) => id)).toEqual(['demo-2', 'demo-5']);
  });

  it('discloses restore failure and allows saving the fallback member', async () => {
    const store = {
      load: jest.fn().mockRejectedValue(new Error('Unavailable')),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const result = await picker(store);
    await result.findByText('Current member: Amber');
    expect(result.getByRole('alert')).toBeTruthy();
    expect(result.queryByText('Your selection is remembered on this device.')).toBeNull();
    await fireEvent.press(result.getByRole('button', { name: 'Retry saving selection' }));
    await waitFor(() => expect(result.queryByRole('alert')).toBeNull());
    expect(store.save).toHaveBeenCalledWith('demo-1');
  });

  it('keeps the current actor on save failure and retries successfully', async () => {
    const store = {
      load: async () => null,
      save: jest.fn().mockRejectedValueOnce(new Error('Full')).mockResolvedValue(undefined),
    };
    const result = await picker(store);
    await result.findByText('Current member: Amber');
    await fireEvent.press(result.getByRole('button', { name: 'Choose Birch, sample member' }));
    await result.findByText('Could not save this selection. It may not be remembered next time.');
    expect(result.getByText('Current member: Birch')).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Retry saving selection' }));
    await result.findByText('Your selection is remembered on this device.');
    expect(store.save).toHaveBeenLastCalledWith('demo-2');
  });
});

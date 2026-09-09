import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import App from '../App';
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
    expect(
      result.getByLabelText('Current capsule. Reveal in 2 days. 4 of 5 members added a moment.'),
    ).toBeTruthy();
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

      expect(result.getByRole('header', { name: area.label })).toBeTruthy();
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

  it('uses honest unavailable states for unfinished areas', async () => {
    const result = await render(<App />);

    await fireEvent.press(result.getByRole('tab', { name: 'Camera' }));
    expect(
      result.getByText('Camera capture and permissions are not implemented in this Sprint 0 demo.'),
    ).toBeTruthy();

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
    expect(result.getByText('Camera is not available in this task.')).toBeTruthy();
  });

  it('shows the weekly prompt and quota', async () => {
    const result = await render(<App />);

    expect(result.getByLabelText('Weekly prompt: What made you pause and smile?')).toBeTruthy();
    expect(result.getByLabelText('Weekly quota. 2 of 5 moments used.')).toBeTruthy();
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

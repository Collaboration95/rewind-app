import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import App from '../App';
import { SELECTION_KEY } from '../src/data/selection-store';
import type { SelectionStore } from '../src/domain/profiles';
import { DemoProfilePicker } from '../src/profiles/DemoProfilePicker';
import { DemoProfileProvider } from '../src/profiles/DemoProfileProvider';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

beforeEach(async () => {
  await AsyncStorage.clear();
});

function picker(store: SelectionStore) {
  return render(
    <DemoProfileProvider store={store}>
      <DemoProfilePicker />
    </DemoProfileProvider>,
  );
}

describe('Local demo profile flow', () => {
  it('offers five accessible choices, remembers selection on relaunch, and resets cleanly', async () => {
    const result = await render(<App />);
    expect(result.getByRole('header', { name: 'Rewind' })).toBeTruthy();
    expect(result.getByRole('header', { name: 'Local demo' })).toBeTruthy();
    await result.findByText('Current member: Amber');
    expect(result.getAllByRole('button', { name: /Choose .*sample member/ })).toHaveLength(5);
    await fireEvent.press(result.getByRole('button', { name: 'Choose Clover, sample member' }));
    expect(result.getByText('Current member: Clover')).toBeTruthy();
    expect(
      result.getByRole('button', { name: 'Choose Clover, sample member', selected: true }),
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

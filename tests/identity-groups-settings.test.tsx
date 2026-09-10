import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import App from '../App';
import { LOCAL_GROUPS_STORAGE_KEY, resetLocalDemoData } from '../src/data/demo-repository';
import { DEMO_SESSION_STORAGE_KEY } from '../src/domain/session';
import { SELECTION_KEY } from '../src/data/selection-store';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

beforeEach(async () => {
  await AsyncStorage.clear();
  await resetLocalDemoData();
});

async function activeApp() {
  const result = await render(<App />);
  await result.findByRole('header', { name: 'Weekend People' });
  return result;
}

describe('local Demo access lifecycle', () => {
  it('persists an explicit session, signs out to clean entry, and can choose another actor', async () => {
    const result = await activeApp();
    expect(await AsyncStorage.getItem(DEMO_SESSION_STORAGE_KEY)).not.toBeNull();

    await fireEvent.press(result.getByRole('tab', { name: 'Settings' }));
    expect(result.getByTestId('settings-identity')).toBeTruthy();
    expect(result.getByText('Amber')).toBeTruthy();
    await fireEvent.press(result.getByTestId('sign-out'));
    await result.findByRole('header', { name: 'Choose who you are showing' });
    expect(await AsyncStorage.getItem(DEMO_SESSION_STORAGE_KEY)).toBeNull();

    await fireEvent.press(result.getByTestId('demo-entry-demo-2'));
    await result.findByRole('header', { name: 'Weekend People' });
    expect(result.getByText('Birch')).toBeTruthy();
  });
});

describe('local group creation', () => {
  it('keeps invalid drafts actionable and writes a built-in-prompt owner group atomically', async () => {
    const result = await activeApp();
    await fireEvent.press(result.getByRole('tab', { name: 'Settings' }));
    await fireEvent.press(result.getByRole('button', { name: 'Create a local group' }));

    await fireEvent.press(result.getByTestId('create-group-submit'));
    expect(result.getByText('Enter a group name.')).toBeTruthy();

    await fireEvent.changeText(result.getByTestId('group-name-input'), 'Saturday table');
    await fireEvent.press(result.getByTestId('create-group-submit'));
    await result.findByRole('header', { name: 'Saturday table' });
    expect(result.getByText('What made you pause and smile?')).toBeTruthy();
    expect(await AsyncStorage.getItem(LOCAL_GROUPS_STORAGE_KEY)).toContain('Saturday table');
    await result.unmount();
    const relaunched = await render(<App />);
    await relaunched.findByRole('header', { name: 'Saturday table' });
  });

  it('validates an overlong custom prompt before any local write', async () => {
    const result = await activeApp();
    await fireEvent.press(result.getByRole('tab', { name: 'Settings' }));
    await fireEvent.press(result.getByRole('button', { name: 'Create a local group' }));
    await fireEvent.changeText(result.getByTestId('group-name-input'), 'No partial write');
    await fireEvent.press(result.getByRole('radio', { name: 'Write a custom prompt' }));
    await fireEvent.changeText(result.getByTestId('custom-prompt-input'), 'x'.repeat(161));
    await fireEvent.press(result.getByTestId('create-group-submit'));
    expect(result.getByText('Prompt must be 160 characters or fewer.')).toBeTruthy();
    expect(await AsyncStorage.getItem(LOCAL_GROUPS_STORAGE_KEY)).toBeNull();
  });
});

describe('settings reset', () => {
  it('requires confirmation and returns to clean entry after deterministic reset', async () => {
    const result = await activeApp();
    await fireEvent.press(result.getByRole('tab', { name: 'Settings' }));
    await fireEvent.press(result.getByTestId('reset-demo-data'));
    expect(result.getByTestId('reset-confirmation')).toBeTruthy();
    expect(result.getByText(/removes the saved Demo session/)).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Keep local data' }));
    expect(result.getByTestId('settings-identity')).toBeTruthy();

    await fireEvent.press(result.getByTestId('reset-demo-data'));
    await fireEvent.press(result.getByTestId('reset-confirm-action'));
    await result.findByRole('header', { name: 'Choose who you are showing' });
    expect(await AsyncStorage.getItem(DEMO_SESSION_STORAGE_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(LOCAL_GROUPS_STORAGE_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(SELECTION_KEY)).toBeNull();
  });
});

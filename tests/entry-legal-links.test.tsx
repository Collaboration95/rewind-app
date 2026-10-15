import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import App from '../App';
import { openLegalPage } from '../src/real/safety';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);
jest.mock('../src/real/safety', () => ({
  ...jest.requireActual('../src/real/safety'),
  openLegalPage: jest.fn(),
}));

beforeEach(async () => {
  await AsyncStorage.clear();
});

it.each(['welcome', 'sign-in', 'registration'])(
  'opens Privacy and Support without authentication from %s',
  async (mode) => {
    const ui = await render(<App runtimeClient={null} />);
    await ui.findByTestId('welcome-entry');
    if (mode === 'sign-in') await fireEvent.press(ui.getByRole('button', { name: 'Sign in' }));
    if (mode === 'registration')
      await fireEvent.press(ui.getByRole('button', { name: 'Create an account' }));

    const privacy = await ui.findByTestId('entry-privacy');
    const support = ui.getByTestId('entry-support');
    expect(privacy.props.accessibilityRole).toBe('link');
    expect(support.props.accessibilityRole).toBe('link');
    await fireEvent.press(privacy);
    expect(openLegalPage).toHaveBeenLastCalledWith('/privacy');
    await fireEvent.press(support);
    expect(openLegalPage).toHaveBeenLastCalledWith('/support');
  },
);

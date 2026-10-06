import AsyncStorage from '@react-native-async-storage/async-storage';
import { render } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import App from '../App';

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

describe('Rewind application frame', () => {
  it('keeps the application inside the device safe area', async () => {
    const result = await render(<App runtimeClient={null} />);

    expect(result.getByTestId('application-safe-area')).toBeTruthy();
  });

  it('uses a dark status bar on the cream launch and Warm Glass entry screens', async () => {
    const result = await render(<App runtimeClient={null} />);

    expect(mockStatusBar).toHaveBeenCalledWith({ style: 'dark' });
    mockStatusBar.mockClear();
    await result.findByTestId('welcome-entry');
    expect(mockStatusBar).toHaveBeenCalledWith({ style: 'dark' });
  });
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, within } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import App from '../App';
import { DemoCameraPlatform } from '../src/capture/platform';
import { DEBUG_STORAGE_KEY } from '../src/debug/DebugProvider';
import { LANGUAGE_STORAGE_KEY } from '../src/i18n/LanguageProvider';

jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));

beforeEach(async () => {
  await AsyncStorage.clear();
});

async function openSettings() {
  const result = await render(<App cameraPlatform={new DemoCameraPlatform()} />);
  await result.findByText('Amber · synthetic member');
  await fireEvent.press(result.getByRole('tab', { name: 'Settings' }));
  return result;
}

async function forceState(
  result: Awaited<ReturnType<typeof openSettings>>,
  screen: string,
  state: string,
) {
  await fireEvent.press(result.getByTestId('debug-chip'));
  const sheet = await result.findByTestId('debug-sheet');
  await fireEvent.press(within(sheet).getByTestId(`debug-screen-${screen}`));
  await fireEvent.press(within(sheet).getByTestId(`debug-state-${screen}-${state}`));
  if (result.queryByTestId('debug-go-to-screen')) {
    await fireEvent.press(result.getByTestId('debug-go-to-screen'));
  } else {
    await fireEvent.press(result.getByTestId('debug-close'));
  }
}

describe('Settings debug mode', () => {
  it('stays hidden until enabled from Settings and persists the switch', async () => {
    const result = await openSettings();
    expect(result.queryByTestId('debug-chip')).toBeNull();

    await fireEvent.press(result.getByTestId('debug-mode-switch'));
    expect(await result.findByTestId('debug-chip')).toBeTruthy();
    expect(JSON.parse((await AsyncStorage.getItem(DEBUG_STORAGE_KEY)) ?? '{}').enabled).toBe(true);
  });

  it('forces Home states without changing the real capsule', async () => {
    const result = await openSettings();
    await fireEvent.press(result.getByTestId('debug-mode-switch'));

    await forceState(result, 'home', 'quota');
    expect(await result.findByTestId('home-allowance-used')).toBeTruthy();
    expect(result.getByRole('button', { name: 'Add a moment', disabled: true })).toBeTruthy();
    expect(result.getByText('0 contributions')).toBeTruthy();

    await forceState(result, 'home', 'released');
    expect(await result.findByTestId('home-reveal-released')).toBeTruthy();
    expect(result.getByRole('button', { name: 'Watch group film' })).toBeTruthy();

    await forceState(result, 'home', 'denied');
    expect(await result.findByTestId('capsule-denied')).toBeTruthy();

    await forceState(result, 'home', 'live');
    expect(await result.findByTestId('capsule-ready')).toBeTruthy();
    expect(result.getByText('5 contributions')).toBeTruthy();
  });

  it('shows a sealed fixture contribution on Video and Home, then moves through study states', async () => {
    const result = await openSettings();
    await fireEvent.press(result.getByTestId('debug-mode-switch'));

    await forceState(result, 'video', 'sealed');
    expect(await result.findByTestId('camera-contribution-status-sealed')).toBeTruthy();
    expect(result.getByText('2.0 seconds · metadata only')).toBeTruthy();

    await fireEvent.press(result.getByRole('tab', { name: 'Home' }));
    expect(await result.findByTestId('home-contribution-status-sealed')).toBeTruthy();

    await forceState(result, 'camera', 'preview');
    expect(await result.findByTestId('camera-demo-preview')).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Use this still' }));
    expect(await result.findByTestId('camera-saved')).toBeTruthy();
  });

  it('switches the visible copy to Chinese and remembers the choice', async () => {
    const result = await openSettings();
    await fireEvent.press(result.getByTestId('language-zh'));
    expect(await result.findByRole('tab', { name: '首页' })).toBeTruthy();
    expect(await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('zh');

    await fireEvent.press(result.getByRole('tab', { name: '首页' }));
    expect(await result.findByText('今天什么让你停下来笑了？')).toBeTruthy();
    expect(result.getByRole('button', { name: '记录片刻' })).toBeTruthy();
  });
});

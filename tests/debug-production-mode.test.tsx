import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Pressable, Text, View } from 'react-native';

import { DEBUG_STORAGE_KEY, DebugProvider, useDebug } from '../src/debug/DebugProvider';

jest.mock('../src/debug/build-mode', () => ({ DEBUG_BUILD_ENABLED: false }));

function Probe() {
  const debug = useDebug();
  return (
    <View>
      <Text testID="debug-state">{`${debug.enabled}:${debug.runtime}:${debug.scenarios.home ?? ''}`}</Text>
      <Pressable onPress={() => debug.setEnabled(true)} testID="enable-debug" />
    </View>
  );
}

describe('production DebugProvider', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('ignores and removes previously persisted developer state', async () => {
    await AsyncStorage.setItem(
      DEBUG_STORAGE_KEY,
      JSON.stringify({ enabled: true, runtime: 'offline', scenarios: { home: 'quota' } }),
    );

    const result = await render(
      <DebugProvider
        initialState={{ enabled: true, runtime: 'offline', scenarios: { home: 'quota' } }}
      >
        <Probe />
      </DebugProvider>,
    );

    expect(result.getByTestId('debug-state').props.children).toBe('false:live:');
    await waitFor(async () => {
      expect(await AsyncStorage.getItem(DEBUG_STORAGE_KEY)).toBeNull();
    });
    await fireEvent.press(result.getByTestId('enable-debug'));
    expect(result.getByTestId('debug-state').props.children).toBe('false:live:');
  });
});

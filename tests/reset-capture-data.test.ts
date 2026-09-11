import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { IMAGE_METADATA_KEY } from '../src/capture/metadata-store';
import { resetCaptureData } from '../src/capture/reset';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('resetCaptureData', () => {
  let mockDeleteAsync: jest.SpiedFunction<typeof FileSystem.deleteAsync>;

  beforeEach(() => {
    Object.defineProperty(FileSystem, 'cacheDirectory', {
      configurable: true,
      value: 'file:///rewind-cache/',
    });
    mockDeleteAsync = jest.spyOn(FileSystem, 'deleteAsync').mockResolvedValue();
  });

  it('clears metadata and the app-owned still cache together', async () => {
    await resetCaptureData();

    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(IMAGE_METADATA_KEY);
    expect(mockDeleteAsync).toHaveBeenCalledWith('file:///rewind-cache/rewind-stills/', {
      idempotent: true,
    });
    expect(mockDeleteAsync).toHaveBeenCalledWith('file:///rewind-cache/rewind-clips/', {
      idempotent: true,
    });
  });
});

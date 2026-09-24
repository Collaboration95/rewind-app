import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { IMAGE_METADATA_KEY } from '../src/capture/metadata-store';
import { PENDING_CLIP_METADATA_KEY } from '../src/capture/video-review';
import {
  resetCaptureData,
  resetCaptureRestartRecoveryGuard,
  runCaptureRestartRecovery,
  sweepOrphanedCaptureFiles,
} from '../src/capture/reset';

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

  it('sweeps interrupted capture media without erasing accepted still metadata', async () => {
    await sweepOrphanedCaptureFiles();

    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(PENDING_CLIP_METADATA_KEY);
    expect(AsyncStorage.removeItem).not.toHaveBeenCalledWith(IMAGE_METADATA_KEY);
    expect(mockDeleteAsync).toHaveBeenCalledWith('file:///rewind-cache/rewind-stills/', {
      idempotent: true,
    });
    expect(mockDeleteAsync).toHaveBeenCalledWith('file:///rewind-cache/rewind-clips/', {
      idempotent: true,
    });
  });

  it('runs the restart sweep once per process and can be re-armed', async () => {
    resetCaptureRestartRecoveryGuard();
    await expect(runCaptureRestartRecovery()).resolves.toBe(true);
    await expect(runCaptureRestartRecovery()).resolves.toBe(false);
    expect(AsyncStorage.removeItem).toHaveBeenCalledTimes(1);

    resetCaptureRestartRecoveryGuard();
    await expect(runCaptureRestartRecovery()).resolves.toBe(true);
  });

  it('reports a failed restart sweep and retries it on the next attempt', async () => {
    resetCaptureRestartRecoveryGuard();
    mockDeleteAsync.mockRejectedValueOnce(new Error('cache unavailable'));
    await expect(runCaptureRestartRecovery()).resolves.toBe(false);
    await expect(runCaptureRestartRecovery()).resolves.toBe(true);
  });
});

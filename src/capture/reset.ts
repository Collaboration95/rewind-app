import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { IMAGE_METADATA_KEY } from './metadata-store';
import { WebCaptureFileStore } from './file-store';

const CAPTURE_CACHE_FOLDER = 'rewind-stills';

/**
 * Remove every app-owned still capture artifact during a local Demo reset.
 * Durable metadata intentionally has no URI, so reset owns the cache folder
 * directly instead of trying to recover paths from metadata.
 */
export async function resetCaptureData(): Promise<void> {
  WebCaptureFileStore.resetAll();
  const operations: Promise<void>[] = [AsyncStorage.removeItem(IMAGE_METADATA_KEY)];
  const cacheDirectory = FileSystem.cacheDirectory;
  if (cacheDirectory) {
    operations.push(
      FileSystem.deleteAsync(`${cacheDirectory}${CAPTURE_CACHE_FOLDER}/`, {
        idempotent: true,
      }),
    );
  }
  const results = await Promise.allSettled(operations);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) {
    throw failure.reason instanceof Error
      ? failure.reason
      : new Error('Local camera files could not be completely reset.');
  }
}

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { IMAGE_METADATA_KEY } from './metadata-store';
import { WebCaptureFileStore } from './file-store';
import { PENDING_CLIP_METADATA_KEY } from './video-review';

const CAPTURE_CACHE_FOLDERS = ['rewind-stills', 'rewind-clips'] as const;

/**
 * Remove every app-owned capture artifact during a local Demo reset. Durable
 * metadata intentionally has no URI, so reset owns the cache folders directly
 * instead of trying to recover paths from metadata.
 */
export async function resetCaptureData(): Promise<void> {
  WebCaptureFileStore.resetAll();
  const operations: Promise<void>[] = [
    AsyncStorage.removeItem(IMAGE_METADATA_KEY),
    AsyncStorage.removeItem(PENDING_CLIP_METADATA_KEY),
  ];
  const cacheDirectory = FileSystem.cacheDirectory;
  if (cacheDirectory) {
    operations.push(
      ...CAPTURE_CACHE_FOLDERS.map((folder) =>
        FileSystem.deleteAsync(`${cacheDirectory}${folder}/`, { idempotent: true }),
      ),
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

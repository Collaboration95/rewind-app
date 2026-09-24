import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { IMAGE_METADATA_KEY } from './metadata-store';
import { WebCaptureFileStore } from './file-store';
import { PENDING_CLIP_METADATA_KEY } from './video-review';

const CAPTURE_CACHE_FOLDERS = ['rewind-stills', 'rewind-clips'] as const;
const CONTRIBUTION_STATUS_STORAGE_KEY = '@rewind/contribution-status-v1';

/**
 * Sign-out removes recovery metadata owned by that Demo session while leaving
 * statuses for any other saved session scope intact.
 */
export async function clearContributionStatusForSession(sessionId: string): Promise<void> {
  const raw = await AsyncStorage.getItem(CONTRIBUTION_STATUS_STORAGE_KEY);
  if (!raw) return;

  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      await AsyncStorage.removeItem(CONTRIBUTION_STATUS_STORAGE_KEY);
      return;
    }
    parsed = value as Record<string, unknown>;
  } catch {
    await AsyncStorage.removeItem(CONTRIBUTION_STATUS_STORAGE_KEY);
    return;
  }

  const prefix = `${sessionId}:`;
  let changed = false;
  for (const key of Object.keys(parsed)) {
    if (!key.startsWith(prefix)) continue;
    delete parsed[key];
    changed = true;
  }
  if (!changed) return;
  if (Object.keys(parsed).length === 0)
    await AsyncStorage.removeItem(CONTRIBUTION_STATUS_STORAGE_KEY);
  else await AsyncStorage.setItem(CONTRIBUTION_STATUS_STORAGE_KEY, JSON.stringify(parsed));
}

/**
 * Delete app-owned capture cache folders and the pending-clip records that
 * pointed into them. Accepted still metadata deliberately has no URI, so it
 * survives a sweep: only transient media is removed.
 */
export async function sweepOrphanedCaptureFiles(): Promise<void> {
  WebCaptureFileStore.resetAll();
  const operations: Promise<void>[] = [AsyncStorage.removeItem(PENDING_CLIP_METADATA_KEY)];
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
      : new Error('Interrupted capture files could not be cleared.');
  }
}

let restartRecoveryRan = false;

/**
 * Run the restart sweep at most once per process. Native capture blobs from a
 * previous process cannot be reached by any live session, so the first capture
 * route mount after a cold start reclaims them. Later mounts are no-ops so a
 * route change never deletes a clip that the current session still owns.
 */
export async function runCaptureRestartRecovery(): Promise<boolean> {
  if (restartRecoveryRan) return false;
  restartRecoveryRan = true;
  try {
    await sweepOrphanedCaptureFiles();
  } catch {
    // Recovery is best effort. A failed sweep must not block capture, and the
    // next cold start retries it.
    restartRecoveryRan = false;
    return false;
  }
  return true;
}

/** Test seam: re-arm the once-per-process restart recovery. */
export function resetCaptureRestartRecoveryGuard(): void {
  restartRecoveryRan = false;
}

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
    AsyncStorage.removeItem(CONTRIBUTION_STATUS_STORAGE_KEY),
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

import * as FileSystem from 'expo-file-system/legacy';

import {
  CaptureFileLifecycleError,
  type CaptureFileStore,
  type ManagedImageFile,
  type PlatformStillImage,
} from './contracts';

const CACHE_FOLDER = 'rewind-stills';

/**
 * Expo's camera writes native captures to a temporary URI. This adapter makes
 * an app-owned cache copy and verifies it before the capture can be accepted.
 * The legacy import is intentional: it is the stable SDK 57 API while the
 * newer File/Directory API is still evolving across Expo SDKs.
 */
export class ExpoCaptureFileStore implements CaptureFileStore {
  async copyToManagedCache(image: PlatformStillImage, imageId: string): Promise<ManagedImageFile> {
    const cacheDirectory = FileSystem.cacheDirectory;
    if (!cacheDirectory) {
      throw new CaptureFileLifecycleError('The app cache is unavailable on this platform.');
    }

    if (!/^[a-z0-9_-]+$/i.test(imageId)) {
      throw new CaptureFileLifecycleError('The capture identifier is invalid.');
    }

    const folder = `${cacheDirectory}${CACHE_FOLDER}/`;
    const destination = `${folder}${imageId}.${image.format}`;

    try {
      await FileSystem.makeDirectoryAsync(folder, { intermediates: true });
      if (image.sourceUri.startsWith('data:') || image.base64) {
        const encoded = image.base64 ?? image.sourceUri;
        const separator = encoded.indexOf(',');
        const payload = separator >= 0 ? encoded.slice(separator + 1) : encoded;
        await FileSystem.writeAsStringAsync(destination, payload, {
          encoding: FileSystem.EncodingType.Base64,
        });
      } else {
        await FileSystem.copyAsync({ from: image.sourceUri, to: destination });
      }

      const info = await FileSystem.getInfoAsync(destination);
      if (!info.exists || info.isDirectory || info.size <= 0) {
        await FileSystem.deleteAsync(destination, { idempotent: true });
        throw new CaptureFileLifecycleError(
          'The captured image could not be verified in app storage.',
        );
      }

      return { uri: destination, byteLength: info.size };
    } catch (error) {
      await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => undefined);
      if (error instanceof CaptureFileLifecycleError) throw error;
      throw new CaptureFileLifecycleError(
        'The captured image could not be copied into app storage. Try taking it again.',
      );
    }
  }

  async exists(uri: string): Promise<boolean> {
    try {
      const info = await FileSystem.getInfoAsync(uri);
      return info.exists && !info.isDirectory && info.size > 0;
    } catch {
      return false;
    }
  }

  async remove(uri: string): Promise<void> {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  }
}

/** A deterministic file port for tests and the honest simulator demo. */
export class InMemoryCaptureFileStore implements CaptureFileStore {
  private readonly files = new Map<string, number>();

  async copyToManagedCache(image: PlatformStillImage, imageId: string): Promise<ManagedImageFile> {
    const uri = `memory://rewind-stills/${imageId}.${image.format}`;
    const byteLength = image.base64 ? Math.max(1, Math.ceil((image.base64.length * 3) / 4)) : 1;
    this.files.set(uri, byteLength);
    return { uri, byteLength };
  }

  async exists(uri: string): Promise<boolean> {
    return this.files.has(uri);
  }

  async remove(uri: string): Promise<void> {
    this.files.delete(uri);
  }

  has(uri: string): boolean {
    return this.files.has(uri);
  }

  get size(): number {
    return this.files.size;
  }
}

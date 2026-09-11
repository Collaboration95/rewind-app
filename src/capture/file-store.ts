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

/**
 * Browser-local file store. Expo FileSystem's legacy web shim has no cache
 * directory, so browser captures use Blob URLs owned by this store instead.
 * The URL is transient (like the native cache copy); durable metadata never
 * contains it.
 */
export class WebCaptureFileStore implements CaptureFileStore {
  private static readonly instances = new Set<WebCaptureFileStore>();
  private readonly files = new Map<string, Blob>();

  constructor() {
    WebCaptureFileStore.instances.add(this);
  }

  static resetAll(): void {
    for (const instance of WebCaptureFileStore.instances) instance.clear();
  }

  async copyToManagedCache(image: PlatformStillImage, imageId: string): Promise<ManagedImageFile> {
    if (!/^[a-z0-9_-]+$/i.test(imageId)) {
      throw new CaptureFileLifecycleError('The capture identifier is invalid.');
    }

    try {
      const mimeType = image.format === 'jpg' ? 'image/jpeg' : 'image/png';
      const blob = await this.toBlob(image, mimeType);
      if (blob.size <= 0) throw new Error('The browser returned an empty image.');
      let uri = `webblob://rewind-stills/${imageId}.${image.format}`;
      try {
        if (typeof URL.createObjectURL === 'function') uri = URL.createObjectURL(blob);
      } catch {
        // Some test/webview runtimes expose URL but not Blob URL support.
        // The in-store fallback remains a real, verifiable browser blob.
      }
      this.files.set(uri, blob);
      return { uri, byteLength: blob.size };
    } catch (error) {
      if (error instanceof CaptureFileLifecycleError) throw error;
      throw new CaptureFileLifecycleError(
        'The captured image could not be saved in browser storage. Try taking it again.',
      );
    }
  }

  async exists(uri: string): Promise<boolean> {
    return this.files.has(uri) && (this.files.get(uri)?.size ?? 0) > 0;
  }

  async remove(uri: string): Promise<void> {
    if (!this.files.delete(uri)) return;
    if (uri.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(uri);
    }
  }

  private async toBlob(image: PlatformStillImage, mimeType: string): Promise<Blob> {
    const encoded = image.base64 ?? image.sourceUri;
    if (image.base64 || encoded.startsWith('data:')) {
      const payload = encoded.includes(',') ? encoded.slice(encoded.indexOf(',') + 1) : encoded;
      const binary =
        typeof atob === 'function'
          ? atob(payload)
          : ((
              globalThis as typeof globalThis & {
                Buffer?: { from(value: string, encoding: string): { toString(): string } };
              }
            ).Buffer?.from(payload, 'base64').toString() ?? '');
      if (!binary) throw new Error('The browser returned an invalid image encoding.');
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new Blob([bytes], { type: mimeType });
    }
    const response = await fetch(image.sourceUri);
    if (!response.ok) throw new Error('The browser capture URL could not be read.');
    return response.blob();
  }

  private clear(): void {
    for (const uri of this.files.keys()) {
      if (uri.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(uri);
      }
    }
    this.files.clear();
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

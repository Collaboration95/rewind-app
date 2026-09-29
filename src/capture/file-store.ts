import * as FileSystem from 'expo-file-system/legacy';

import {
  CaptureFileLifecycleError,
  type CaptureFileStore,
  type ManagedImageFile,
  type PlatformStillImage,
} from './contracts';

const PERSISTENT_FOLDER = 'rewind-stills';

/**
 * Expo's camera writes native captures to a temporary URI. This adapter makes
 * an app-owned cache copy and verifies it before the capture can be accepted.
 * The legacy import is intentional: it is the stable SDK 57 API while the
 * newer File/Directory API is still evolving across Expo SDKs.
 */
export class ExpoCaptureFileStore implements CaptureFileStore {
  async copyToManagedCache(image: PlatformStillImage, imageId: string): Promise<ManagedImageFile> {
    const documentDirectory = FileSystem.documentDirectory;
    if (!documentDirectory) {
      throw new CaptureFileLifecycleError('App storage is unavailable on this platform.');
    }

    if (!/^[a-z0-9_-]+$/i.test(imageId)) {
      throw new CaptureFileLifecycleError('The capture identifier is invalid.');
    }

    const folder = `${documentDirectory}${PERSISTENT_FOLDER}/`;
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

  async readAsBase64(uri: string): Promise<string> {
    return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  }

  async resolveManagedFile(
    imageId: string,
    format: 'jpg' | 'png',
  ): Promise<ManagedImageFile | null> {
    const directory = FileSystem.documentDirectory;
    if (!directory || !/^[a-z0-9_-]+$/i.test(imageId)) return null;
    const uri = `${directory}${PERSISTENT_FOLDER}/${imageId}.${format}`;
    const info = await FileSystem.getInfoAsync(uri).catch(() => null);
    return info?.exists && !info.isDirectory && info.size > 0
      ? { uri, byteLength: info.size }
      : null;
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
  private static readonly pendingById = new Map<string, { uri: string; byteLength: number }>();
  private static readonly imageIdByUri = new Map<string, string>();
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
      await this.writePersisted(imageId, blob);
      let uri = `webblob://rewind-stills/${imageId}.${image.format}`;
      try {
        if (typeof URL.createObjectURL === 'function') uri = URL.createObjectURL(blob);
      } catch {
        // Some test/webview runtimes expose URL but not Blob URL support.
        // The in-store fallback remains a real, verifiable browser blob.
      }
      this.files.set(uri, blob);
      WebCaptureFileStore.pendingById.set(imageId, { uri, byteLength: blob.size });
      WebCaptureFileStore.imageIdByUri.set(uri, imageId);
      return { uri, byteLength: blob.size };
    } catch (error) {
      if (error instanceof CaptureFileLifecycleError) throw error;
      throw new CaptureFileLifecycleError(
        'The captured image could not be saved in browser storage. Try taking it again.',
      );
    }
  }

  async exists(uri: string): Promise<boolean> {
    return (this.files.get(uri)?.size ?? 0) > 0;
  }

  async readAsBase64(uri: string): Promise<string> {
    const blob = this.files.get(uri);
    if (!blob) throw new CaptureFileLifecycleError('The captured photo is no longer available.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  async resolveManagedFile(
    imageId: string,
    format: 'jpg' | 'png',
  ): Promise<ManagedImageFile | null> {
    const persisted = WebCaptureFileStore.pendingById.get(imageId);
    if (persisted && this.files.has(persisted.uri)) return persisted;
    const file =
      (persisted
        ? [...WebCaptureFileStore.instances]
            .map((instance) => instance.files.get(persisted.uri))
            .find((candidate): candidate is Blob => Boolean(candidate))
        : null) ?? (await this.readPersisted(imageId));
    if (!file) return null;
    const uri = URL.createObjectURL(file);
    this.files.set(uri, file);
    const managed = { uri, byteLength: file.size };
    WebCaptureFileStore.pendingById.set(imageId, managed);
    WebCaptureFileStore.imageIdByUri.set(uri, imageId);
    return managed;
  }

  async remove(uri: string): Promise<void> {
    if (!this.files.delete(uri)) return;
    const imageId = WebCaptureFileStore.imageIdByUri.get(uri);
    WebCaptureFileStore.imageIdByUri.delete(uri);
    if (imageId) {
      WebCaptureFileStore.pendingById.delete(imageId);
      await this.deletePersisted(imageId);
    }
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

  static async clearPersistent(): Promise<void> {
    const database = await this.openDatabase();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('photos', 'readwrite');
      transaction.objectStore('photos').clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  private static openDatabase(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('rewind-capture', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('photos');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private async writePersisted(id: string, blob: Blob): Promise<void> {
    const database = await WebCaptureFileStore.openDatabase();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('photos', 'readwrite');
      transaction.objectStore('photos').put(blob, id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  private async readPersisted(id: string): Promise<Blob | null> {
    const database = await WebCaptureFileStore.openDatabase();
    if (!database) return null;
    return new Promise((resolve, reject) => {
      const request = database.transaction('photos').objectStore('photos').get(id);
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
      request.onerror = () => reject(request.error);
    });
  }

  private async deletePersisted(id: string): Promise<void> {
    const database = await WebCaptureFileStore.openDatabase();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('photos', 'readwrite');
      transaction.objectStore('photos').delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  private clear(): void {
    for (const uri of this.files.keys()) {
      if (uri.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(uri);
      }
    }
    this.files.clear();
    WebCaptureFileStore.pendingById.clear();
  }
}

/** A deterministic file port for tests and the honest simulator demo. */
export class InMemoryCaptureFileStore implements CaptureFileStore {
  private readonly files = new Map<string, { byteLength: number; base64: string }>();

  async copyToManagedCache(image: PlatformStillImage, imageId: string): Promise<ManagedImageFile> {
    const uri = `memory://rewind-stills/${imageId}.${image.format}`;
    const byteLength = image.base64 ? Math.max(1, Math.ceil((image.base64.length * 3) / 4)) : 1;
    this.files.set(uri, { byteLength, base64: image.base64 ?? 'AQID' });
    return { uri, byteLength };
  }

  async exists(uri: string): Promise<boolean> {
    return this.files.has(uri);
  }

  async readAsBase64(uri: string): Promise<string> {
    const image = this.files.get(uri);
    if (!image) throw new CaptureFileLifecycleError('The captured photo is no longer available.');
    return image.base64;
  }

  async resolveManagedFile(
    imageId: string,
    format: 'jpg' | 'png',
  ): Promise<ManagedImageFile | null> {
    const uri = `memory://rewind-stills/${imageId}.${format}`;
    const file = this.files.get(uri);
    return file ? { uri, byteLength: file.byteLength } : null;
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

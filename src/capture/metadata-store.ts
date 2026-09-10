import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ImageMetadata, ImageMetadataStore } from './contracts';

export const IMAGE_METADATA_KEY = '@rewind/capture-metadata-v1';

function isImageMetadata(value: unknown): value is ImageMetadata {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ImageMetadata> & { uri?: unknown; previewUri?: unknown };
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.capturedAt === 'string' &&
    (candidate.format === 'jpg' || candidate.format === 'png') &&
    (candidate.mimeType === 'image/jpeg' || candidate.mimeType === 'image/png') &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    typeof candidate.byteLength === 'number' &&
    (candidate.source === 'camera' || candidate.source === 'demo-fixture') &&
    !('uri' in candidate) &&
    !('previewUri' in candidate)
  );
}

/** Stores capture metadata only; no local URI or thumbnail is serialized. */
export class AsyncStorageImageMetadataStore implements ImageMetadataStore {
  async save(metadata: ImageMetadata): Promise<void> {
    const current = await this.list();
    const next = [...current.filter((item) => item.id !== metadata.id), { ...metadata }];
    await AsyncStorage.setItem(IMAGE_METADATA_KEY, JSON.stringify(next));
  }

  async remove(id: string): Promise<void> {
    const next = (await this.list()).filter((item) => item.id !== id);
    if (next.length === 0) {
      await AsyncStorage.removeItem(IMAGE_METADATA_KEY);
    } else {
      await AsyncStorage.setItem(IMAGE_METADATA_KEY, JSON.stringify(next));
    }
  }

  async list(): Promise<readonly ImageMetadata[]> {
    const raw = await AsyncStorage.getItem(IMAGE_METADATA_KEY);
    if (!raw) return [];

    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter(isImageMetadata).map((item) => ({ ...item }))
        : [];
    } catch {
      return [];
    }
  }

  async clear(): Promise<void> {
    await AsyncStorage.removeItem(IMAGE_METADATA_KEY);
  }
}

export class InMemoryImageMetadataStore implements ImageMetadataStore {
  private readonly records = new Map<string, ImageMetadata>();

  async save(metadata: ImageMetadata): Promise<void> {
    this.records.set(metadata.id, { ...metadata });
  }

  async remove(id: string): Promise<void> {
    this.records.delete(id);
  }

  async list(): Promise<readonly ImageMetadata[]> {
    return [...this.records.values()].map((item) => ({ ...item }));
  }

  async clear(): Promise<void> {
    this.records.clear();
  }
}

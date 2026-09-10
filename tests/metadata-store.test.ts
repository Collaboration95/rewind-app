import AsyncStorage from '@react-native-async-storage/async-storage';

import { AsyncStorageImageMetadataStore, IMAGE_METADATA_KEY } from '../src/capture/metadata-store';
import type { ImageMetadata } from '../src/capture/contracts';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const metadata: ImageMetadata = {
  byteLength: 123,
  capturedAt: '2026-09-10T00:00:00.000Z',
  format: 'jpg',
  height: 900,
  id: 'capture-metadata',
  mimeType: 'image/jpeg',
  source: 'camera',
  width: 1200,
};

describe('AsyncStorageImageMetadataStore', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('stores metadata without any file URI or preview reference', async () => {
    const store = new AsyncStorageImageMetadataStore();
    await store.save(metadata);

    expect(await store.list()).toEqual([metadata]);
    const raw = await AsyncStorage.getItem(IMAGE_METADATA_KEY);
    expect(raw).toContain('capture-metadata');
    expect(raw).not.toContain('file://');
    expect(raw).not.toContain('previewUri');
    expect(raw).not.toContain('uri');
  });

  it('ignores malformed or URI-bearing records during restore', async () => {
    await AsyncStorage.setItem(
      IMAGE_METADATA_KEY,
      JSON.stringify([{ ...metadata, uri: 'file://private.jpg' }, metadata]),
    );
    const store = new AsyncStorageImageMetadataStore();

    expect(await store.list()).toEqual([metadata]);
    await store.remove(metadata.id);
    expect(await AsyncStorage.getItem(IMAGE_METADATA_KEY)).toBeNull();
  });
});

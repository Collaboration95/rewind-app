import AsyncStorage from '@react-native-async-storage/async-storage';

import { AsyncStorageImageMetadataStore, IMAGE_METADATA_KEY } from '../src/capture/metadata-store';
import { InMemoryCaptureFileStore } from '../src/capture/file-store';
import { StillImageCaptureSession } from '../src/capture/still-image-session';
import type { CameraPlatform, ImageMetadata } from '../src/capture/contracts';

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

  it('round-trips file-fallback metadata through the production AsyncStorage store', async () => {
    const store = new AsyncStorageImageMetadataStore();
    const fileMetadata = { ...metadata, id: 'selected-file', source: 'file' as const };

    await store.save(fileMetadata);

    expect(await new AsyncStorageImageMetadataStore().list()).toEqual([fileMetadata]);
  });

  it('persists an accepted file fallback through the real capture-session/store boundary', async () => {
    const platform: CameraPlatform = {
      captureStill: jest.fn().mockResolvedValue({
        format: 'png',
        height: 1280,
        source: 'file',
        sourceUri: 'memory://selected-image.png',
        width: 720,
      }),
      getCapabilities: jest.fn(),
      getPermissions: jest.fn(),
      kind: 'expo',
      openSettings: jest.fn(),
      requestPermissions: jest.fn(),
      supportsLivePreview: false,
    };
    const store = new AsyncStorageImageMetadataStore();
    const session = new StillImageCaptureSession({
      createId: () => 'file-session',
      fileStore: new InMemoryCaptureFileStore(),
      metadataStore: store,
      now: () => new Date('2026-09-10T00:00:00.000Z'),
      platform,
    });

    await session.capture();
    await session.accept();

    expect(await new AsyncStorageImageMetadataStore().list()).toEqual([
      expect.objectContaining({
        format: 'png',
        id: 'file-session',
        mimeType: 'image/png',
        source: 'file',
      }),
    ]);
    expect(await AsyncStorage.getItem(IMAGE_METADATA_KEY)).not.toContain('memory://');
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

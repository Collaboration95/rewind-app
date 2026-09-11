import { InMemoryCaptureFileStore, InMemoryImageMetadataStore } from '../src/capture';
import type { CameraPlatform, PlatformStillImage } from '../src/capture/contracts';
import { StillImageCaptureSession } from '../src/capture/still-image-session';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const fixture: PlatformStillImage = {
  sourceUri: 'fixture://still',
  format: 'jpg',
  height: 900,
  source: 'demo-fixture',
  width: 1200,
};

function platform(overrides: Partial<CameraPlatform> = {}): CameraPlatform {
  return {
    captureStill: jest.fn().mockResolvedValue(fixture),
    getCapabilities: jest.fn().mockResolvedValue({ camera: 'supported', microphone: 'supported' }),
    getPermissions: jest.fn().mockResolvedValue({ camera: 'granted', microphone: 'granted' }),
    kind: 'demo',
    openSettings: jest.fn().mockResolvedValue(undefined),
    requestPermissions: jest.fn().mockResolvedValue({ camera: 'granted', microphone: 'granted' }),
    supportsLivePreview: false,
    ...overrides,
  };
}

describe('still image session lifecycle', () => {
  it('verifies the managed copy before preview and persists metadata without a URI', async () => {
    const files = new InMemoryCaptureFileStore();
    const metadata = new InMemoryImageMetadataStore();
    const session = new StillImageCaptureSession({
      createId: () => 'capture-1',
      fileStore: files,
      metadataStore: metadata,
      now: () => new Date('2026-09-10T00:00:00.000Z'),
      platform: platform(),
    });

    const preview = await session.capture();
    expect(preview.previewUri).toBe('memory://rewind-stills/capture-1.jpg');
    expect(files.has(preview.previewUri)).toBe(true);
    expect(await metadata.list()).toEqual([]);

    const persisted = await session.accept();
    expect(persisted.metadata).toMatchObject({
      byteLength: 1,
      capturedAt: '2026-09-10T00:00:00.000Z',
      id: 'capture-1',
      source: 'demo-fixture',
    });
    expect(persisted.metadata).not.toHaveProperty('uri');
    expect(await metadata.list()).toEqual([persisted.metadata]);
  });

  it.each([
    ['retake', 1],
    ['discard', 0],
    ['reset', 0],
  ] as const)(
    'cleans files and applies metadata semantics on %s',
    async (operation, expectedMetadataCount) => {
      const files = new InMemoryCaptureFileStore();
      const metadata = new InMemoryImageMetadataStore();
      const session = new StillImageCaptureSession({
        createId: () => 'capture-cleanup',
        fileStore: files,
        metadataStore: metadata,
        platform: platform(),
      });
      const preview = await session.capture();
      await session.accept();
      await session[operation]();

      expect(files.size).toBe(0);
      expect(await metadata.list()).toHaveLength(expectedMetadataCount);
      expect(session.getActivePreview()).toBeNull();
      expect(preview.metadata.id).toBe('capture-cleanup');
    },
  );

  it('clears metadata from prior accepted captures on an explicit reset', async () => {
    const metadata = new InMemoryImageMetadataStore();
    await metadata.save({
      byteLength: 1,
      capturedAt: '2026-09-10T00:00:00.000Z',
      format: 'jpg',
      height: 1,
      id: 'prior-capture',
      mimeType: 'image/jpeg',
      source: 'camera',
      width: 1,
    });
    const session = new StillImageCaptureSession({
      createId: () => 'capture-reset',
      fileStore: new InMemoryCaptureFileStore(),
      metadataStore: metadata,
      platform: platform(),
    });

    await session.reset();

    expect(await metadata.list()).toEqual([]);
  });

  it('retains accepted metadata across route disposal while releasing the preview file', async () => {
    const files = new InMemoryCaptureFileStore();
    const metadata = new InMemoryImageMetadataStore();
    const session = new StillImageCaptureSession({
      createId: () => 'capture-dispose',
      fileStore: files,
      metadataStore: metadata,
      platform: platform(),
    });
    const preview = await session.capture();
    await session.accept();

    await session.dispose();

    expect(files.has(preview.previewUri)).toBe(false);
    expect(await metadata.list()).toHaveLength(1);
  });

  it('removes a managed file when verification fails', async () => {
    const files = new InMemoryCaptureFileStore();
    const remove = jest.spyOn(files, 'remove');
    jest.spyOn(files, 'exists').mockResolvedValue(false);
    const session = new StillImageCaptureSession({
      createId: () => 'capture-unverified',
      fileStore: files,
      metadataStore: new InMemoryImageMetadataStore(),
      platform: platform(),
    });

    await expect(session.capture()).rejects.toThrow('could not be verified');
    expect(remove).toHaveBeenCalledWith('memory://rewind-stills/capture-unverified.jpg');
    expect(session.getActivePreview()).toBeNull();
  });

  it('cleans a verified file when metadata writing fails', async () => {
    const files = new InMemoryCaptureFileStore();
    const metadata = new InMemoryImageMetadataStore();
    jest.spyOn(metadata, 'save').mockRejectedValue(new Error('storage full'));
    const session = new StillImageCaptureSession({
      createId: () => 'capture-write-failure',
      fileStore: files,
      metadataStore: metadata,
      platform: platform(),
    });
    const preview = await session.capture();

    await expect(session.accept()).rejects.toThrow('metadata could not be saved');
    expect(files.has(preview.previewUri)).toBe(false);
    expect(session.getActivePreview()).toBeNull();
  });
});

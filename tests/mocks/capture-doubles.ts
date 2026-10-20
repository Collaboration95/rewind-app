/**
 * Minimal capture test doubles that implement the ports in
 * src/capture/contracts.ts and src/capture/video-recording.ts directly, so
 * characterisation tests do not depend on the demo/fixture platform or on the
 * in-memory stores that ship in src/capture.
 */
import {
  CaptureFileLifecycleError,
  type CameraPlatform,
  type CapabilitySnapshot,
  type CaptureFileStore,
  type ImageMetadata,
  type ImageMetadataStore,
  type ManagedImageFile,
  type PermissionSnapshot,
  type PlatformStillImage,
} from '../../src/capture/contracts';
import type { RecordedClip } from '../../src/domain/video';
import type { VideoRecordingPlatform } from '../../src/capture/video-recording';

/** Keeps managed stills in a map keyed by a `memory://` URI. */
export class MemoryFileStore implements CaptureFileStore {
  private readonly files = new Map<string, { byteLength: number; base64: string }>();

  constructor(private readonly options: { byteLength?: number } = {}) {}

  async copyToManagedCache(image: PlatformStillImage, imageId: string): Promise<ManagedImageFile> {
    const uri = `memory://stills/${imageId}.${image.format}`;
    const base64 = image.base64 ?? 'AQID';
    const byteLength = this.options.byteLength ?? Math.ceil((base64.length * 3) / 4);
    this.files.set(uri, { byteLength, base64 });
    return { uri, byteLength };
  }

  async exists(uri: string): Promise<boolean> {
    return this.files.has(uri);
  }

  async readAsBase64(uri: string): Promise<string> {
    const file = this.files.get(uri);
    if (!file) throw new CaptureFileLifecycleError('The captured photo is no longer available.');
    return file.base64;
  }

  async resolveManagedFile(
    imageId: string,
    format: 'jpg' | 'png',
  ): Promise<ManagedImageFile | null> {
    const uri = `memory://stills/${imageId}.${format}`;
    const file = this.files.get(uri);
    return file ? { uri, byteLength: file.byteLength } : null;
  }

  async remove(uri: string): Promise<void> {
    this.files.delete(uri);
  }

  get size(): number {
    return this.files.size;
  }

  get uris(): string[] {
    return [...this.files.keys()];
  }
}

export class MemoryMetadataStore implements ImageMetadataStore {
  private readonly records = new Map<string, ImageMetadata>();

  async save(metadata: ImageMetadata): Promise<void> {
    this.records.set(metadata.id, { ...metadata });
  }

  async remove(id: string): Promise<void> {
    this.records.delete(id);
  }

  async list(): Promise<readonly ImageMetadata[]> {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  async clear(): Promise<void> {
    this.records.clear();
  }
}

export const GRANTED: PermissionSnapshot = { camera: 'granted', microphone: 'granted' };
export const SUPPORTED: CapabilitySnapshot = { camera: 'supported', microphone: 'supported' };

export const STILL: PlatformStillImage = {
  sourceUri: 'file://shot.jpg',
  format: 'jpg',
  width: 1200,
  height: 900,
  source: 'camera',
};

/** A real-device-shaped still platform (kind "expo") with every call observable. */
/** Overrides are intentionally loose so a test can pass `jest.fn(async () => ({ camera: 'denied', … }))`. */
type Overrides = Record<string, unknown>;

export function createStillPlatform(overrides: Overrides = {}) {
  return {
    kind: 'expo',
    supportsLivePreview: false,
    getCapabilities: jest.fn(async () => SUPPORTED),
    getPermissions: jest.fn(async () => GRANTED),
    requestPermissions: jest.fn(async () => GRANTED),
    openSettings: jest.fn(async () => undefined),
    captureStill: jest.fn(async () => ({ ...STILL })),
    ...overrides,
  } as unknown as CameraPlatform & {
    getCapabilities: jest.Mock;
    getPermissions: jest.Mock;
    requestPermissions: jest.Mock;
    openSettings: jest.Mock;
    captureStill: jest.Mock;
  };
}

export const CLIP: RecordedClip = {
  sourceUri: 'file://clip.mp4',
  format: 'mp4',
  mimeType: 'video/mp4',
  width: 720,
  height: 1280,
  durationSeconds: 8,
  hasAudio: true,
  byteLength: 2048,
  source: 'camera',
};

/** A real-device-shaped video platform: still ports plus recordClip/stop/cancel. */
export function createVideoPlatform(
  permissions: PermissionSnapshot = GRANTED,
  overrides: Overrides = {},
) {
  return {
    kind: 'expo',
    supportsLivePreview: true,
    getCapabilities: jest.fn(async () => SUPPORTED),
    getPermissions: jest.fn(async () => permissions),
    requestPermissions: jest.fn(async () => permissions),
    openSettings: jest.fn(async () => undefined),
    captureStill: jest.fn(),
    recordClip: jest.fn(async () => ({ ...CLIP })),
    stopRecording: jest.fn(),
    cancelRecording: jest.fn(),
    ...overrides,
  } as unknown as CameraPlatform &
    VideoRecordingPlatform & {
      getCapabilities: jest.Mock;
      getPermissions: jest.Mock;
      requestPermissions: jest.Mock;
      openSettings: jest.Mock;
      recordClip: jest.Mock;
      stopRecording: jest.Mock;
      cancelRecording: jest.Mock;
    };
}

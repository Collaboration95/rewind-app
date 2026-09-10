/**
 * Framework-independent boundary for still-image capture.
 *
 * The UI and session orchestration code depends on these ports rather than on
 * Expo, React Native, or a filesystem implementation. A native adapter can
 * therefore be replaced by a deterministic fixture in tests or by another
 * platform adapter in a future client.
 */

export type DeviceCapability = 'supported' | 'unsupported' | 'undecided';

export type PermissionState = 'granted' | 'denied' | 'blocked' | 'undetermined';

export interface CapabilitySnapshot {
  camera: DeviceCapability;
  microphone: DeviceCapability;
}

export interface PermissionSnapshot {
  camera: PermissionState;
  microphone: PermissionState;
}

export type StillImageSource = 'camera' | 'demo-fixture';

export interface PlatformStillImage {
  sourceUri: string;
  format: 'jpg' | 'png';
  width: number;
  height: number;
  /**
   * Web camera implementations may expose the data URI instead of a local
   * file URI. Native adapters should leave this undefined.
   */
  base64?: string;
  source: StillImageSource;
}

export interface ManagedImageFile {
  /** A transient app-managed URI used only by the active preview. */
  uri: string;
  byteLength: number;
}

export interface ImageMetadata {
  id: string;
  capturedAt: string;
  format: 'jpg' | 'png';
  mimeType: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  byteLength: number;
  source: StillImageSource;
}

/**
 * Metadata deliberately has no URI. Keeping this type separate from the
 * active preview is the privacy boundary that prevents local file paths from
 * becoming durable application data.
 */
export interface ImageMetadataStore {
  save(metadata: ImageMetadata): Promise<void>;
  remove(id: string): Promise<void>;
  list(): Promise<readonly ImageMetadata[]>;
  clear(): Promise<void>;
}

export interface CaptureFileStore {
  copyToManagedCache(image: PlatformStillImage, imageId: string): Promise<ManagedImageFile>;
  exists(uri: string): Promise<boolean>;
  remove(uri: string): Promise<void>;
}

export interface CameraViewHandle {
  takePictureAsync(options?: {
    quality?: number;
    base64?: boolean;
    skipProcessing?: boolean;
    shutterSound?: boolean;
  }): Promise<{
    uri: string;
    width: number;
    height: number;
    format: 'jpg' | 'png';
    base64?: string;
  }>;
}

export interface CameraPlatform {
  readonly kind: 'expo' | 'demo';
  readonly supportsLivePreview: boolean;

  getCapabilities(): Promise<CapabilitySnapshot>;
  getPermissions(): Promise<PermissionSnapshot>;
  requestPermissions(): Promise<PermissionSnapshot>;
  openSettings(): Promise<void>;
  captureStill(): Promise<PlatformStillImage>;
}

export interface ActiveStillImage {
  /** Transient URI; never write this value to metadata storage. */
  previewUri: string;
  metadata: ImageMetadata;
}

export interface PersistedStillImage {
  metadata: ImageMetadata;
}

export class CaptureCapabilityError extends Error {
  readonly code = 'capability';

  constructor(message: string) {
    super(message);
    this.name = 'CaptureCapabilityError';
  }
}

export class CapturePermissionError extends Error {
  readonly code = 'permission';

  constructor(message: string) {
    super(message);
    this.name = 'CapturePermissionError';
  }
}

export class CaptureFileLifecycleError extends Error {
  readonly code = 'file-lifecycle';

  constructor(message: string) {
    super(message);
    this.name = 'CaptureFileLifecycleError';
  }
}

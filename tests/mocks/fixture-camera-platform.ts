import type {
  CameraPlatform,
  CapabilitySnapshot,
  PermissionSnapshot,
  PlatformStillImage,
} from '../../src/capture/contracts';

// Moved from src/capture/platform.ts (the former DemoCameraPlatform), which
// production no longer uses.
export interface FixtureCameraPlatformOptions {
  capabilities?: CapabilitySnapshot;
  permissions?: PermissionSnapshot;
  fixture?: PlatformStillImage;
}

/** A still-only camera with fixed capabilities, permissions and image. */
export class FixtureCameraPlatform implements CameraPlatform {
  readonly supportsLivePreview = false;
  readonly supportsVideoRecording = false;
  private readonly capabilities: CapabilitySnapshot;
  private readonly permissions: PermissionSnapshot;
  private readonly fixture: PlatformStillImage;

  constructor(options: FixtureCameraPlatformOptions = {}) {
    this.capabilities = options.capabilities ?? { camera: 'supported', microphone: 'supported' };
    this.permissions = options.permissions ?? { camera: 'granted', microphone: 'granted' };
    this.fixture = options.fixture ?? {
      sourceUri: 'fixture://rewind-still',
      format: 'jpg',
      height: 900,
      source: 'camera',
      width: 1200,
    };
  }

  async getCapabilities(): Promise<CapabilitySnapshot> {
    return { ...this.capabilities };
  }

  async getPermissions(): Promise<PermissionSnapshot> {
    return { ...this.permissions };
  }

  async getVideoPermissions(): Promise<PermissionSnapshot> {
    return { ...this.permissions };
  }

  async requestPermissions(): Promise<PermissionSnapshot> {
    return { ...this.permissions };
  }

  async requestVideoPermissions(): Promise<PermissionSnapshot> {
    return { ...this.permissions };
  }

  async openSettings(): Promise<void> {
    // There are no device settings for a fixture adapter.
  }

  async captureStill(): Promise<PlatformStillImage> {
    return { ...this.fixture };
  }
}

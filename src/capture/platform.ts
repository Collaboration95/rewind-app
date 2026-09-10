import { Platform, Linking } from 'react-native';
import { Camera, CameraView, type CameraCapturedPicture } from 'expo-camera';
import * as Device from 'expo-device';

import type {
  CameraPlatform,
  CameraViewHandle,
  CapabilitySnapshot,
  PermissionSnapshot,
  PermissionState,
  PlatformStillImage,
} from './contracts';

export function permissionState(response: {
  status: string;
  canAskAgain?: boolean;
}): PermissionState {
  if (response.status === 'granted') return 'granted';
  if (response.status === 'undetermined') return 'undetermined';
  if (response.status === 'denied') return response.canAskAgain === false ? 'blocked' : 'denied';
  return 'undetermined';
}

export interface ExpoCameraPlatformOptions {
  getCameraRef: () => CameraViewHandle | null;
  /** Allows deterministic capability responses for simulator/device probes. */
  capabilityProbe?: () => Promise<CapabilitySnapshot>;
}

/** Expo SDK 57 adapter. No Expo or React Native types cross the capture port. */
export class ExpoCameraPlatform implements CameraPlatform {
  readonly kind = 'expo' as const;
  readonly supportsLivePreview = true;

  constructor(private readonly options: ExpoCameraPlatformOptions) {}

  async getCapabilities(): Promise<CapabilitySnapshot> {
    if (this.options.capabilityProbe) return this.options.capabilityProbe();

    try {
      const cameraAvailable = await CameraView.isAvailableAsync();
      // Expo does not expose a microphone-capability probe. On native, a real
      // device is the supported recording target; simulator capture stays an
      // explicit unsupported state. On web, ask the browser capability API.
      const microphoneAvailable =
        Platform.OS === 'web'
          ? typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
          : Device.isDevice;

      return {
        camera: cameraAvailable && microphoneAvailable ? 'supported' : 'unsupported',
        microphone: microphoneAvailable ? 'supported' : 'unsupported',
      };
    } catch {
      return { camera: 'undecided', microphone: 'undecided' };
    }
  }

  async getPermissions(): Promise<PermissionSnapshot> {
    const [camera, microphone] = await Promise.all([
      Camera.getCameraPermissionsAsync(),
      Camera.getMicrophonePermissionsAsync(),
    ]);
    return {
      camera: permissionState(camera),
      microphone: permissionState(microphone),
    };
  }

  async requestPermissions(): Promise<PermissionSnapshot> {
    const [camera, microphone] = await Promise.all([
      Camera.requestCameraPermissionsAsync(),
      Camera.requestMicrophonePermissionsAsync(),
    ]);
    return {
      camera: permissionState(camera),
      microphone: permissionState(microphone),
    };
  }

  async openSettings(): Promise<void> {
    if (Platform.OS === 'web') {
      throw new Error('Camera settings are managed by the browser address bar.');
    }
    await Linking.openSettings();
  }

  async captureStill(): Promise<PlatformStillImage> {
    const camera = this.options.getCameraRef();
    if (!camera) throw new Error('The camera preview is not ready. Try again.');

    const picture: CameraCapturedPicture = await camera.takePictureAsync({
      base64: Platform.OS === 'web',
      quality: 0.85,
      shutterSound: true,
      skipProcessing: false,
    });
    return {
      sourceUri: picture.uri,
      base64: picture.base64,
      format: picture.format,
      height: picture.height,
      source: 'camera',
      width: picture.width,
    };
  }
}

export interface DemoCameraPlatformOptions {
  capabilities?: CapabilitySnapshot;
  permissions?: PermissionSnapshot;
  fixture?: PlatformStillImage;
}

/**
 * Explicit simulator-safe fixture adapter. It never claims that a real image
 * came from a camera; the screen labels its preview as a simulator demo.
 */
export class DemoCameraPlatform implements CameraPlatform {
  readonly kind = 'demo' as const;
  readonly supportsLivePreview = false;
  private readonly capabilities: CapabilitySnapshot;
  private readonly permissions: PermissionSnapshot;
  private readonly fixture: PlatformStillImage;

  constructor(options: DemoCameraPlatformOptions = {}) {
    this.capabilities = options.capabilities ?? { camera: 'supported', microphone: 'supported' };
    this.permissions = options.permissions ?? { camera: 'granted', microphone: 'granted' };
    this.fixture = options.fixture ?? {
      sourceUri: 'fixture://rewind-demo-still',
      format: 'jpg',
      height: 900,
      source: 'demo-fixture',
      width: 1200,
    };
  }

  async getCapabilities(): Promise<CapabilitySnapshot> {
    return { ...this.capabilities };
  }

  async getPermissions(): Promise<PermissionSnapshot> {
    return { ...this.permissions };
  }

  async requestPermissions(): Promise<PermissionSnapshot> {
    return { ...this.permissions };
  }

  async openSettings(): Promise<void> {
    // There are no device settings for a fixture adapter.
  }

  async captureStill(): Promise<PlatformStillImage> {
    return { ...this.fixture };
  }
}

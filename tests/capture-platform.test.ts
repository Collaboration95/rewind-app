import { Platform } from 'react-native';
import { Camera, CameraView } from 'expo-camera';
import * as FileSystem from 'expo-file-system/legacy';
import { PermissionStatus } from 'expo-modules-core';
import { ExpoCameraPlatform, permissionState } from '../src/capture/platform';
import type { CameraViewHandle } from '../src/capture/contracts';
import { MAX_CLIP_DURATION_SECONDS } from '../src/domain/video';

jest.mock('expo-camera', () => ({
  Camera: {
    getCameraPermissionsAsync: jest.fn(),
    getMicrophonePermissionsAsync: jest.fn(),
    requestCameraPermissionsAsync: jest.fn(),
    requestMicrophonePermissionsAsync: jest.fn(),
  },
  // Native Expo Camera surfaces do not register the web-only availability
  // probe. The adapter must still reach the permission/device decision.
  CameraView: {},
}));

jest.mock('expo-device', () => ({ isDevice: true }));

jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(),
}));

function cameraHandle(overrides: Partial<CameraViewHandle> = {}): CameraViewHandle {
  return {
    takePictureAsync: jest.fn().mockResolvedValue({
      format: 'jpg',
      height: 1280,
      uri: 'file://capture.jpg',
      width: 720,
    }),
    ...overrides,
  };
}

describe('Expo permission normalization', () => {
  it.each([
    [{ status: 'granted' }, 'granted'],
    [{ status: 'undetermined' }, 'undetermined'],
    [{ status: 'denied', canAskAgain: true }, 'denied'],
    [{ status: 'denied', canAskAgain: false }, 'blocked'],
  ])('maps %o to %s', (response, expected) => {
    expect(permissionState(response)).toBe(expected);
  });
});

it('treats a missing native availability probe as available on a physical device', async () => {
  const platform = new ExpoCameraPlatform({ getCameraRef: () => null });
  await expect(platform.getCapabilities()).resolves.toEqual({
    camera: 'supported',
    microphone: 'supported',
  });
});

describe('Expo camera adapter contract', () => {
  it('uses an injected capability probe and preserves its device matrix', async () => {
    const capabilityProbe = jest.fn().mockResolvedValue({
      camera: 'unsupported',
      microphone: 'supported',
    });
    const platform = new ExpoCameraPlatform({ getCameraRef: () => null, capabilityProbe });

    await expect(platform.getCapabilities()).resolves.toEqual({
      camera: 'unsupported',
      microphone: 'supported',
    });
    expect(capabilityProbe).toHaveBeenCalledTimes(1);
  });

  it('preserves failures from an injected capability probe', async () => {
    const nativeFailure = new Error('probe unavailable');
    const platform = new ExpoCameraPlatform({
      getCameraRef: () => null,
      capabilityProbe: jest.fn().mockRejectedValue(nativeFailure),
    });

    await expect(platform.getCapabilities()).rejects.toBe(nativeFailure);
  });

  it('falls back to undecided capabilities when the native probe fails', async () => {
    const cameraView = CameraView as typeof CameraView & {
      isAvailableAsync?: () => Promise<boolean>;
    };
    const previousProbe = cameraView.isAvailableAsync;
    cameraView.isAvailableAsync = jest.fn().mockRejectedValue(new Error('probe unavailable'));
    try {
      const platform = new ExpoCameraPlatform({ getCameraRef: () => null });
      await expect(platform.getCapabilities()).resolves.toEqual({
        camera: 'undecided',
        microphone: 'undecided',
      });
    } finally {
      cameraView.isAvailableAsync = previousProbe;
    }
  });

  it('maps Expo permission responses for both read and request operations', async () => {
    const getCameraPermissionsAsync = jest.mocked(Camera.getCameraPermissionsAsync);
    const getMicrophonePermissionsAsync = jest.mocked(Camera.getMicrophonePermissionsAsync);
    const requestCameraPermissionsAsync = jest.mocked(Camera.requestCameraPermissionsAsync);
    const requestMicrophonePermissionsAsync = jest.mocked(Camera.requestMicrophonePermissionsAsync);
    getCameraPermissionsAsync.mockResolvedValue({
      canAskAgain: false,
      expires: 'never',
      granted: false,
      status: PermissionStatus.DENIED,
    });
    getMicrophonePermissionsAsync.mockResolvedValue({
      canAskAgain: true,
      expires: 'never',
      granted: false,
      status: PermissionStatus.DENIED,
    });
    requestCameraPermissionsAsync.mockResolvedValue({
      canAskAgain: true,
      expires: 'never',
      granted: true,
      status: PermissionStatus.GRANTED,
    });
    requestMicrophonePermissionsAsync.mockResolvedValue({
      canAskAgain: true,
      expires: 'never',
      granted: false,
      status: PermissionStatus.UNDETERMINED,
    });
    const platform = new ExpoCameraPlatform({ getCameraRef: () => null });

    await expect(platform.getPermissions()).resolves.toEqual({
      camera: 'blocked',
      microphone: 'denied',
    });
    await expect(platform.requestPermissions()).resolves.toEqual({
      camera: 'granted',
      microphone: 'undetermined',
    });
    expect(getCameraPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(getMicrophonePermissionsAsync).toHaveBeenCalledTimes(1);
    expect(requestCameraPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(requestMicrophonePermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('preserves native permission errors for callers to handle', async () => {
    const nativeFailure = new Error('permission service unavailable');
    jest.mocked(Camera.getCameraPermissionsAsync).mockRejectedValue(nativeFailure);
    const platform = new ExpoCameraPlatform({ getCameraRef: () => null });

    await expect(platform.getPermissions()).rejects.toBe(nativeFailure);
  });

  it('maps a still capture and forwards the adapter capture options', async () => {
    const camera = cameraHandle({
      takePictureAsync: jest.fn().mockResolvedValue({
        base64: 'encoded-image',
        format: 'png',
        height: 900,
        uri: 'file://capture.png',
        width: 600,
      }),
    });
    const platform = new ExpoCameraPlatform({ getCameraRef: () => camera });

    await expect(platform.captureStill()).resolves.toEqual({
      base64: 'encoded-image',
      format: 'png',
      height: 900,
      source: 'camera',
      sourceUri: 'file://capture.png',
      width: 600,
    });
    expect(camera.takePictureAsync).toHaveBeenCalledWith({
      base64: Platform.OS === 'web',
      quality: 0.85,
      shutterSound: true,
      skipProcessing: false,
    });
  });

  it('rejects still capture when the preview is not ready and preserves camera errors', async () => {
    const unavailable = new ExpoCameraPlatform({ getCameraRef: () => null });
    await expect(unavailable.captureStill()).rejects.toThrow(
      'The camera preview is not ready. Try again.',
    );

    const nativeFailure = new Error('native still capture failed');
    const camera = cameraHandle({
      takePictureAsync: jest.fn().mockRejectedValue(nativeFailure),
    });
    const platform = new ExpoCameraPlatform({ getCameraRef: () => camera });
    await expect(platform.captureStill()).rejects.toBe(nativeFailure);
  });

  it('maps video recording options and clamps a native duration above the 15-second limit', async () => {
    const recordAsync = jest.fn().mockResolvedValue({
      duration: MAX_CLIP_DURATION_SECONDS + 4,
      height: 1080,
      uri: 'file://capture.mp4',
      width: 1920,
    });
    const camera = cameraHandle({ recordAsync });
    const getInfoAsync = jest.mocked(FileSystem.getInfoAsync);
    getInfoAsync.mockResolvedValue({
      exists: true,
      isDirectory: false,
      modificationTime: 1,
      size: 42_000,
      uri: 'file://capture.mp4',
    });
    const platform = new ExpoCameraPlatform({ getCameraRef: () => camera });

    await expect(platform.recordClip()).resolves.toEqual({
      byteLength: 42_000,
      durationSeconds: MAX_CLIP_DURATION_SECONDS,
      format: 'mp4',
      hasAudio: true,
      height: 1080,
      source: 'camera',
      sourceUri: 'file://capture.mp4',
      width: 1920,
    });
    expect(recordAsync).toHaveBeenCalledWith({
      maxDuration: MAX_CLIP_DURATION_SECONDS,
      mute: false,
      quality: '480p',
    });
    expect(getInfoAsync).toHaveBeenCalledWith('file://capture.mp4');
  });

  it('honors a shorter requested duration while preserving the adapter contract', async () => {
    const recordAsync = jest.fn().mockResolvedValue({
      duration: 9,
      uri: 'file://short.mp4',
    });
    const camera = cameraHandle({ recordAsync });
    jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({
      exists: false,
      isDirectory: false,
      uri: 'file://short.mp4',
    });
    const platform = new ExpoCameraPlatform({ getCameraRef: () => camera });

    await expect(platform.recordClip(10)).resolves.toMatchObject({
      byteLength: undefined,
      durationSeconds: 9,
      format: 'mp4',
      hasAudio: true,
      height: 1280,
      source: 'camera',
      sourceUri: 'file://short.mp4',
      width: 720,
    });
    expect(recordAsync).toHaveBeenCalledWith({ maxDuration: 10, mute: false, quality: '480p' });
  });

  it('marks Expo video recording unsupported on web and never calls recordAsync', async () => {
    const platformOs = jest.replaceProperty(Platform, 'OS', 'web');
    try {
      const recordAsync = jest.fn();
      const camera = cameraHandle({ recordAsync });
      const platform = new ExpoCameraPlatform({ getCameraRef: () => camera });

      expect(platform.supportsVideoRecording).toBe(false);
      await expect(platform.recordClip()).rejects.toThrow(
        'Video recording is not supported on the web platform.',
      );
      expect(recordAsync).not.toHaveBeenCalled();
    } finally {
      platformOs.restore();
    }
  });

  it.each([
    [
      'without a camera preview',
      () => new ExpoCameraPlatform({ getCameraRef: () => null }),
      'The camera recorder is not ready. Try again.',
    ],
    [
      'without a recorder',
      () => new ExpoCameraPlatform({ getCameraRef: () => cameraHandle() }),
      'The camera recorder is not ready. Try again.',
    ],
  ])('reports recording setup errors %s', async (_label, createPlatform, message) => {
    await expect(createPlatform().recordClip()).rejects.toThrow(message);
  });

  it('reports a recording cancelled by Expo and preserves native recording failures', async () => {
    const cancelled = cameraHandle({ recordAsync: jest.fn().mockResolvedValue(undefined) });
    const cancelledPlatform = new ExpoCameraPlatform({ getCameraRef: () => cancelled });
    await expect(cancelledPlatform.recordClip()).rejects.toThrow(
      'The recording was cancelled before a clip was saved.',
    );

    const nativeFailure = new Error('native video capture failed');
    const failed = cameraHandle({ recordAsync: jest.fn().mockRejectedValue(nativeFailure) });
    const failedPlatform = new ExpoCameraPlatform({ getCameraRef: () => failed });
    await expect(failedPlatform.recordClip()).rejects.toBe(nativeFailure);
  });

  it('delegates stop and cancel to the active Expo camera recorder', () => {
    const stopRecording = jest.fn();
    const camera = cameraHandle({ stopRecording });
    const platform = new ExpoCameraPlatform({ getCameraRef: () => camera });

    platform.stopRecording();
    platform.cancelRecording();

    expect(stopRecording).toHaveBeenCalledTimes(2);
  });

  it('treats stop and cancel as safe no-ops when the camera ref or native method is absent', () => {
    const platform = new ExpoCameraPlatform({ getCameraRef: () => null });
    expect(() => platform.stopRecording()).not.toThrow();
    expect(() => platform.cancelRecording()).not.toThrow();

    const camera = cameraHandle();
    const activePlatform = new ExpoCameraPlatform({ getCameraRef: () => camera });
    expect(() => activePlatform.stopRecording()).not.toThrow();
    expect(() => activePlatform.cancelRecording()).not.toThrow();
  });
});

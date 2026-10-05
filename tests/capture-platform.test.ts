import { Platform } from 'react-native';
import { Camera, CameraView } from 'expo-camera';
import * as FileSystem from 'expo-file-system/legacy';
import { PermissionStatus } from 'expo-modules-core';
import {
  ExpoCameraPlatform,
  permissionState,
  removeManagedRecordedClip,
  VIDEO_CACHE_FOLDER,
} from '../src/capture/platform';
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
  copyAsync: jest.fn(),
  deleteAsync: jest.fn(),
  getInfoAsync: jest.fn(),
  makeDirectoryAsync: jest.fn(),
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
  it('detects secure MP4 browser recording without opening the camera before a user action', async () => {
    const platformOs = jest.replaceProperty(Platform, 'OS', 'web');
    try {
      const getUserMedia = jest.fn();
      const mediaRecorder = class {
        static isTypeSupported = jest.fn(() => true);
      } as unknown as typeof MediaRecorder;
      const platform = new ExpoCameraPlatform({
        browserMediaDevices: { getUserMedia },
        browserMediaRecorder: mediaRecorder,
        browserPermissionReader: jest.fn().mockResolvedValue({
          camera: 'undetermined',
          microphone: 'undetermined',
        }),
        browserSecureContext: () => true,
        getCameraRef: () => null,
      });

      await expect(platform.getCapabilities()).resolves.toEqual({
        camera: 'supported',
        microphone: 'supported',
      });
      await expect(platform.getVideoPermissions()).resolves.toEqual({
        camera: 'undetermined',
        microphone: 'undetermined',
      });
      expect(getUserMedia).not.toHaveBeenCalled();
    } finally {
      platformOs.restore();
    }
  });

  it.each([
    [false, 'HTTPS'],
    [true, 'MP4 format'],
  ])('explains a browser recording limitation when secure=%s', async (secure, expected) => {
    const platformOs = jest.replaceProperty(Platform, 'OS', 'web');
    try {
      const mediaRecorder = class {
        static isTypeSupported = jest.fn(() => false);
      } as unknown as typeof MediaRecorder;
      const platform = new ExpoCameraPlatform({
        browserMediaDevices: { getUserMedia: jest.fn() },
        browserMediaRecorder: mediaRecorder,
        browserSecureContext: () => secure,
        getCameraRef: () => null,
      });

      await expect(platform.getCapabilities()).resolves.toEqual({
        camera: 'unsupported',
        microphone: 'unsupported',
      });
      expect(platform.getVideoCaptureUnavailableReason()).toContain(expected);
    } finally {
      platformOs.restore();
    }
  });

  it('turns a browser permission refusal into an explicit denied state', async () => {
    const platformOs = jest.replaceProperty(Platform, 'OS', 'web');
    try {
      const platform = new ExpoCameraPlatform({
        browserMediaDevices: {
          getUserMedia: jest
            .fn()
            .mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError')),
        },
        browserMediaRecorder: class {
          static isTypeSupported = jest.fn(() => true);
        } as unknown as typeof MediaRecorder,
        browserSecureContext: () => true,
        getCameraRef: () => null,
      });

      await expect(platform.requestVideoPermissions()).resolves.toEqual({
        camera: 'denied',
        microphone: 'denied',
      });
    } finally {
      platformOs.restore();
    }
  });

  it('records an MP4 from the granted browser stream, caps at 15 seconds, and releases tracks', async () => {
    const platformOs = jest.replaceProperty(Platform, 'OS', 'web');
    jest.useFakeTimers();
    const previousCreateObjectUrl = URL.createObjectURL;
    const previousRevokeObjectUrl = URL.revokeObjectURL;
    URL.createObjectURL = jest.fn(() => 'blob:recorded-clip');
    URL.revokeObjectURL = jest.fn();
    let markRecorderStarted: () => void = () => undefined;
    const recorderStarted = new Promise<void>((resolve) => {
      markRecorderStarted = resolve;
    });
    class BrowserRecorder {
      static isTypeSupported = jest.fn(() => true);
      mimeType = 'video/mp4';
      state: RecordingState = 'inactive';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onstop: (() => void) | null = null;

      start() {
        this.state = 'recording';
        markRecorderStarted();
      }

      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({
          data: new Blob(['mp4-bytes'], { type: 'video/mp4' }),
        } as BlobEvent);
        this.onstop?.();
      }
    }
    const stopTrack = jest.fn();
    const audioTrack = { readyState: 'live', stop: stopTrack } as unknown as MediaStreamTrack;
    const videoTrack = { readyState: 'live', stop: stopTrack } as unknown as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack, videoTrack],
      getVideoTracks: () => [videoTrack],
    } as unknown as MediaStream;
    const getUserMedia = jest.fn().mockResolvedValue(stream);
    const containerReader = jest.fn().mockResolvedValue({
      hasAudio: true,
      hasVideo: true,
      isMp4: true,
    });
    const metadataReader = jest.fn().mockResolvedValue({
      durationSeconds: 4,
      hasAudio: true,
      height: 1280,
      width: 720,
    });
    const platform = new ExpoCameraPlatform({
      browserMediaDevices: { getUserMedia },
      browserMediaRecorder: BrowserRecorder as unknown as typeof MediaRecorder,
      browserSecureContext: () => true,
      browserVideoContainerReader: containerReader,
      browserVideoMetadataReader: metadataReader,
      getCameraRef: () => null,
    });

    try {
      await expect(platform.requestVideoPermissions()).resolves.toEqual({
        camera: 'granted',
        microphone: 'granted',
      });
      const pendingClip = platform.recordClip(30);
      await recorderStarted;
      await jest.advanceTimersByTimeAsync(MAX_CLIP_DURATION_SECONDS * 1000);
      await expect(pendingClip).resolves.toMatchObject({
        byteLength: expect.any(Number),
        durationSeconds: 4,
        format: 'mp4',
        hasAudio: true,
        height: 1280,
        mimeType: 'video/mp4',
        source: 'camera',
        sourceUri: 'blob:recorded-clip',
        width: 720,
      });
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(stopTrack).toHaveBeenCalledTimes(2);
      expect(containerReader).toHaveBeenCalledTimes(1);
      expect(metadataReader).toHaveBeenCalledWith('blob:recorded-clip');
    } finally {
      platform.releaseVideoCapture();
      URL.createObjectURL = previousCreateObjectUrl;
      URL.revokeObjectURL = previousRevokeObjectUrl;
      jest.useRealTimers();
      platformOs.restore();
    }
  });

  it.each([
    [
      'missing video dimensions',
      { durationSeconds: 4, hasAudio: true, height: 0, width: 1280 },
      'no usable video',
    ],
    [
      'duration limit',
      { durationSeconds: 15.1, hasAudio: true, height: 1280, width: 720 },
      '15 seconds or shorter',
    ],
  ])(
    'rejects a browser capture for %s and releases its stream and local bytes',
    async (_label, metadata, expected) => {
      const platformOs = jest.replaceProperty(Platform, 'OS', 'web');
      const previousCreate = URL.createObjectURL;
      const previousRevoke = URL.revokeObjectURL;
      const revokeObjectURL = jest.fn();
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: jest.fn(() => 'blob:rejected-recording'),
      });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
      let markStarted!: () => void;
      const recordingStarted = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      class BrowserRecorder {
        static isTypeSupported = jest.fn(() => true);
        mimeType = 'video/mp4';
        state: RecordingState = 'inactive';
        ondataavailable: ((event: BlobEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onstop: (() => void) | null = null;

        start() {
          this.state = 'recording';
          markStarted();
        }

        stop() {
          this.state = 'inactive';
          this.ondataavailable?.({
            data: new Blob(['recorded-bytes'], { type: 'video/mp4' }),
          } as BlobEvent);
          this.onstop?.();
        }
      }
      const stopAudio = jest.fn();
      const stopVideo = jest.fn();
      const audioTrack = { readyState: 'live', stop: stopAudio } as unknown as MediaStreamTrack;
      const videoTrack = { readyState: 'live', stop: stopVideo } as unknown as MediaStreamTrack;
      const stream = {
        getAudioTracks: () => [audioTrack],
        getTracks: () => [audioTrack, videoTrack],
        getVideoTracks: () => [videoTrack],
      } as unknown as MediaStream;
      const platform = new ExpoCameraPlatform({
        browserMediaDevices: { getUserMedia: jest.fn().mockResolvedValue(stream) },
        browserMediaRecorder: BrowserRecorder as unknown as typeof MediaRecorder,
        browserSecureContext: () => true,
        browserVideoContainerReader: jest
          .fn()
          .mockResolvedValue({ hasAudio: true, hasVideo: true, isMp4: true }),
        browserVideoMetadataReader: jest.fn().mockResolvedValue(metadata),
        getCameraRef: () => null,
      });

      try {
        const pendingClip = platform.recordClip();
        await recordingStarted;
        platform.stopRecording();
        await expect(pendingClip).rejects.toThrow(expected);
        expect(stopAudio).toHaveBeenCalledTimes(1);
        expect(stopVideo).toHaveBeenCalledTimes(1);
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:rejected-recording');
        expect(platform.getVideoPreviewStream()).toBeNull();
      } finally {
        platform.releaseVideoCapture();
        Object.defineProperty(URL, 'createObjectURL', {
          configurable: true,
          value: previousCreate,
        });
        Object.defineProperty(URL, 'revokeObjectURL', {
          configurable: true,
          value: previousRevoke,
        });
        platformOs.restore();
      }
    },
  );

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

  it('does not call the web-only availability probe on native devices', async () => {
    const cameraView = CameraView as typeof CameraView & {
      isAvailableAsync?: () => Promise<boolean>;
    };
    const previousProbe = cameraView.isAvailableAsync;
    const probe = jest.fn().mockRejectedValue(new Error('probe unavailable'));
    cameraView.isAvailableAsync = probe;
    try {
      const platform = new ExpoCameraPlatform({ getCameraRef: () => null });
      await expect(platform.getCapabilities()).resolves.toEqual({
        camera: 'supported',
        microphone: 'supported',
      });
      if (Platform.OS !== 'web') expect(probe).not.toHaveBeenCalled();
    } finally {
      cameraView.isAvailableAsync = previousProbe;
    }
  });

  it('requests video permissions serially, opening the microphone prompt after camera resolves', async () => {
    let resolveCamera!: (
      value: Awaited<ReturnType<typeof Camera.requestCameraPermissionsAsync>>,
    ) => void;
    const order: string[] = [];
    jest.mocked(Camera.requestCameraPermissionsAsync).mockImplementation(
      () =>
        new Promise((resolve) => {
          order.push('camera-open');
          resolveCamera = (value) => {
            order.push('camera-resolved');
            resolve(value);
          };
        }),
    );
    jest.mocked(Camera.requestMicrophonePermissionsAsync).mockImplementation(async () => {
      order.push('microphone-open');
      return {
        canAskAgain: true,
        expires: 'never',
        granted: true,
        status: PermissionStatus.GRANTED,
      };
    });
    const platform = new ExpoCameraPlatform({ getCameraRef: () => null });

    const request = platform.requestVideoPermissions();
    await Promise.resolve();
    expect(order).toEqual(['camera-open']);
    expect(Camera.requestMicrophonePermissionsAsync).not.toHaveBeenCalled();
    resolveCamera({
      canAskAgain: true,
      expires: 'never',
      granted: true,
      status: PermissionStatus.GRANTED,
    });
    await expect(request).resolves.toEqual({ camera: 'granted', microphone: 'granted' });
    expect(order).toEqual(['camera-open', 'camera-resolved', 'microphone-open']);
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
      microphone: 'denied',
    });
    expect(getCameraPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(getMicrophonePermissionsAsync).toHaveBeenCalledTimes(2);
    expect(requestCameraPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(requestMicrophonePermissionsAsync).not.toHaveBeenCalled();
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

  it('retries a still capture while the browser camera has no frame yet (#401)', async () => {
    const warmingUp = new Error(
      'HTMLVideoElement does not have enough camera data to construct an image yet.',
    );
    const camera = cameraHandle({
      takePictureAsync: jest
        .fn()
        .mockRejectedValueOnce(warmingUp)
        .mockRejectedValueOnce(warmingUp)
        .mockResolvedValue({ format: 'jpg', height: 1280, uri: 'blob:still', width: 720 }),
    });
    const wait = jest.fn().mockResolvedValue(undefined);
    const platform = new ExpoCameraPlatform({ getCameraRef: () => camera, wait });

    await expect(platform.captureStill()).resolves.toMatchObject({ sourceUri: 'blob:still' });
    expect(camera.takePictureAsync).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);

    const neverReady = cameraHandle({ takePictureAsync: jest.fn().mockRejectedValue(warmingUp) });
    const stuck = new ExpoCameraPlatform({ getCameraRef: () => neverReady, wait });
    await expect(stuck.captureStill()).rejects.toThrow(
      'The camera is still starting. Wait a moment, then take the photo again.',
    );
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
      mimeType: 'video/mp4',
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
      mimeType: 'video/mp4',
      hasAudio: true,
      height: 1280,
      source: 'camera',
      sourceUri: 'file://short.mp4',
      width: 720,
    });
    expect(recordAsync).toHaveBeenCalledWith({ maxDuration: 10, mute: false, quality: '480p' });
  });

  it('moves native video into the app-owned cache and can remove it', async () => {
    Object.defineProperty(FileSystem, 'cacheDirectory', {
      configurable: true,
      value: 'file:///rewind-cache/',
    });
    const copyAsync = jest.mocked(FileSystem.copyAsync);
    const deleteAsync = jest.mocked(FileSystem.deleteAsync);
    const makeDirectoryAsync = jest.mocked(FileSystem.makeDirectoryAsync);
    const getInfoAsync = jest.mocked(FileSystem.getInfoAsync);
    const recordAsync = jest.fn().mockResolvedValue({
      duration: 4,
      uri: 'file://temporary.mp4',
    });
    copyAsync.mockResolvedValue(undefined);
    makeDirectoryAsync.mockResolvedValue(undefined);
    getInfoAsync.mockResolvedValue({
      exists: true,
      isDirectory: false,
      modificationTime: 1,
      size: 42_000,
      uri: 'file:///rewind-cache/rewind-clips/clip.mp4',
    });
    const platform = new ExpoCameraPlatform({ getCameraRef: () => cameraHandle({ recordAsync }) });

    const clip = await platform.recordClip();
    expect(clip.sourceUri).toMatch(new RegExp(`/rewind-cache/${VIDEO_CACHE_FOLDER}/clip-`));
    expect(copyAsync).toHaveBeenCalledWith({ from: 'file://temporary.mp4', to: clip.sourceUri });
    expect(deleteAsync).toHaveBeenCalledWith('file://temporary.mp4', { idempotent: true });

    await removeManagedRecordedClip(clip.sourceUri);
    expect(deleteAsync).toHaveBeenCalledWith(clip.sourceUri, { idempotent: true });
    Object.defineProperty(FileSystem, 'cacheDirectory', { configurable: true, value: undefined });
  });

  it('marks Expo video recording unsupported on web and never calls recordAsync', async () => {
    const platformOs = jest.replaceProperty(Platform, 'OS', 'web');
    try {
      const recordAsync = jest.fn();
      const camera = cameraHandle({ recordAsync });
      const platform = new ExpoCameraPlatform({ getCameraRef: () => camera });

      expect(platform.supportsVideoRecording).toBe(false);
      await expect(platform.recordClip()).rejects.toThrow(/HTTPS|browser|MP4/);
      expect(recordAsync).not.toHaveBeenCalled();
    } finally {
      platformOs.restore();
    }
  });

  it('accepts only a verified portrait MP4 fallback and preserves its true metadata', async () => {
    const file = { size: 42_000, type: 'video/mp4' } as File;
    const platform = new ExpoCameraPlatform({
      browserFilePicker: jest.fn().mockResolvedValue(file),
      browserObjectUrlFactory: jest.fn().mockReturnValue('blob:verified-video'),
      browserVideoContainerReader: jest.fn().mockResolvedValue({
        hasAudio: true,
        hasVideo: true,
        isMp4: true,
      }),
      browserVideoMetadataReader: jest.fn().mockResolvedValue({
        durationSeconds: 12.75,
        hasAudio: true,
        height: 1280,
        width: 720,
      }),
      getCameraRef: () => null,
    });

    await expect(platform.pickVideoFile()).resolves.toEqual({
      byteLength: 42_000,
      durationSeconds: 12.75,
      format: 'mp4',
      hasAudio: true,
      height: 1280,
      mimeType: 'video/mp4',
      source: 'file',
      sourceUri: 'blob:verified-video',
      width: 720,
    });
  });

  it('uses the phone camera sheet on web for photos and videos (option 2)', async () => {
    const platformOs = jest.replaceProperty(Platform, 'OS', 'web');
    try {
      const picker = jest
        .fn()
        .mockResolvedValueOnce({ size: 3_000_000, type: 'image/jpeg' } as File)
        .mockResolvedValueOnce({ size: 9_000_000, type: 'video/quicktime' } as File)
        .mockResolvedValueOnce({ size: 60 * 1024 * 1024, type: 'video/quicktime' } as File);
      const platform = new ExpoCameraPlatform({
        browserSystemCamera: true,
        browserFilePicker: picker,
        browserImageDimensionsReader: jest.fn().mockResolvedValue({ height: 4032, width: 3024 }),
        browserObjectUrlFactory: jest.fn().mockReturnValue('blob:camera'),
        browserVideoContainerReader: jest
          .fn()
          .mockResolvedValue({ hasAudio: true, hasVideo: true, isMp4: true }),
        browserVideoMetadataReader: jest
          .fn()
          .mockResolvedValue({ durationSeconds: 6, hasAudio: true, height: 1080, width: 1920 }),
        getCameraRef: () => null,
      });

      expect(platform.fileFallbackIsCamera).toBe(true);
      expect(platform.supportsLivePreview).toBe(false);
      expect(platform.supportsVideoRecording).toBe(false);
      await expect(platform.getCapabilities()).resolves.toEqual({
        camera: 'unsupported',
        microphone: 'unsupported',
      });

      await expect(platform.pickStillFile()).resolves.toMatchObject({
        height: 4032,
        source: 'camera',
        width: 3024,
      });
      expect(picker).toHaveBeenNthCalledWith(1, 'image/jpeg,image/png', 'environment');

      // A landscape camera recording is accepted; the film letterboxes it.
      await expect(platform.pickVideoFile()).resolves.toMatchObject({
        height: 1080,
        source: 'camera',
        width: 1920,
      });
      expect(picker).toHaveBeenNthCalledWith(2, 'video/*', 'environment');

      await expect(platform.pickVideoFile()).rejects.toThrow('over 50 MB');
    } finally {
      platformOs.restore();
    }
  });

  it('rejects non-blob preview schemes before assigning a video source', async () => {
    const createElement = jest.fn();
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement },
    });
    const platform = new ExpoCameraPlatform({
      browserFilePicker: jest.fn().mockResolvedValue({ size: 42_000, type: 'video/mp4' } as File),
      browserObjectUrlFactory: jest.fn().mockReturnValue('javascript:alert(1)'),
      browserVideoContainerReader: jest.fn().mockResolvedValue({
        hasAudio: true,
        hasVideo: true,
        isMp4: true,
      }),
      getCameraRef: () => null,
    });

    try {
      await expect(platform.pickVideoFile()).rejects.toThrow(
        'The selected video preview must use a local blob URL.',
      );
      expect(createElement).not.toHaveBeenCalled();
    } finally {
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
      else Reflect.deleteProperty(globalThis, 'document');
    }
  });

  it('uses a blob URL for browser video metadata and keeps the local preview working', async () => {
    let assignedSource = '';
    const video = {
      audioTracks: [{ kind: 'audio' }],
      duration: 4,
      videoHeight: 1280,
      onloadedmetadata: null as (() => void) | null,
      onerror: null as (() => void) | null,
      preload: '',
      set src(value: string) {
        assignedSource = value;
        queueMicrotask(() => video.onloadedmetadata?.());
      },
      videoWidth: 720,
    };
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: jest.fn().mockReturnValue(video) },
    });
    const platform = new ExpoCameraPlatform({
      browserFilePicker: jest.fn().mockResolvedValue({ size: 42_000, type: 'video/mp4' } as File),
      browserObjectUrlFactory: jest.fn().mockReturnValue('blob:https://rewind.example/clip-1'),
      browserVideoContainerReader: jest.fn().mockResolvedValue({
        hasAudio: true,
        hasVideo: true,
        isMp4: true,
      }),
      getCameraRef: () => null,
    });

    try {
      await expect(platform.pickVideoFile()).resolves.toMatchObject({
        durationSeconds: 4,
        source: 'file',
        sourceUri: 'blob:https://rewind.example/clip-1',
      });
      expect(assignedSource).toBe('blob:https://rewind.example/clip-1');
    } finally {
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
      else Reflect.deleteProperty(globalThis, 'document');
    }
  });

  it('rejects a non-MP4 browser fallback before creating an object URL', async () => {
    const createObjectUrl = jest.fn();
    const platform = new ExpoCameraPlatform({
      browserFilePicker: jest.fn().mockResolvedValue({ size: 42_000, type: 'video/webm' } as File),
      browserObjectUrlFactory: createObjectUrl,
      browserVideoContainerReader: jest.fn().mockResolvedValue({
        hasAudio: false,
        hasVideo: false,
        isMp4: false,
      }),
      getCameraRef: () => null,
    });

    await expect(platform.pickVideoFile()).rejects.toThrow('Choose an MP4 video file.');
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it.each([
    [
      'longer than 15 seconds',
      { durationSeconds: 15.01, hasAudio: true, height: 1280, width: 720 },
      '15 seconds or shorter',
    ],
    [
      'without video dimensions',
      { durationSeconds: 10, hasAudio: true, height: 0, width: 1280 },
      'Choose an MP4 video',
    ],
    [
      'without audio',
      { durationSeconds: 10, hasAudio: false, height: 1280, width: 720 },
      'audio track',
    ],
  ] as const)(
    'rejects a browser MP4 %s and releases its URL',
    async (_label, metadata, message) => {
      const previousRevoke = URL.revokeObjectURL;
      const revokeObjectURL = jest.fn();
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
      const platform = new ExpoCameraPlatform({
        browserFilePicker: jest.fn().mockResolvedValue({ size: 42_000, type: 'video/mp4' } as File),
        browserObjectUrlFactory: jest.fn().mockReturnValue('blob:invalid-video'),
        browserVideoContainerReader: jest.fn().mockResolvedValue({
          hasAudio: metadata.hasAudio,
          hasVideo: true,
          isMp4: true,
        }),
        browserVideoMetadataReader: jest.fn().mockResolvedValue(metadata),
        getCameraRef: () => null,
      });

      try {
        await expect(platform.pickVideoFile()).rejects.toThrow(message);
        expect(revokeObjectURL).toHaveBeenCalledTimes(1);
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:invalid-video');
      } finally {
        Object.defineProperty(URL, 'revokeObjectURL', {
          configurable: true,
          value: previousRevoke,
        });
      }
    },
  );

  it('accepts a sound track when Chromium has not decoded audio at loadedmetadata', async () => {
    const platform = new ExpoCameraPlatform({
      browserFilePicker: jest.fn().mockResolvedValue({ size: 42_000, type: 'video/mp4' } as File),
      browserObjectUrlFactory: jest.fn().mockReturnValue('blob:chromium-audio'),
      browserVideoContainerReader: jest.fn().mockResolvedValue({
        hasAudio: true,
        hasVideo: true,
        isMp4: true,
      }),
      browserVideoMetadataReader: jest.fn().mockResolvedValue({
        durationSeconds: 2.25,
        hasAudio: null,
        height: 1280,
        width: 720,
      }),
      getCameraRef: () => null,
    });

    await expect(platform.pickVideoFile()).resolves.toMatchObject({
      durationSeconds: 2.25,
      hasAudio: true,
      height: 1280,
      source: 'file',
      width: 720,
    });
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

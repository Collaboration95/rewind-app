import { Platform, Linking } from 'react-native';
import { Camera, CameraView, type CameraCapturedPicture } from 'expo-camera';
import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';

import type {
  CameraPlatform,
  CameraViewHandle,
  CapabilitySnapshot,
  PermissionSnapshot,
  PermissionState,
  PlatformStillImage,
} from './contracts';
import type { RecordedClip } from '../domain/video';

export const VIDEO_CACHE_FOLDER = 'rewind-clips';
const MAX_LIBRARY_VIDEO_SECONDS = 15;

type BrowserVideoElement = HTMLVideoElement & {
  audioTracks?: { length: number };
  mozHasAudio?: boolean;
  webkitAudioDecodedByteCount?: number;
};

export interface BrowserVideoMetadata {
  durationSeconds: number;
  hasAudio: boolean | null;
  height: number;
  width: number;
}

export interface BrowserVideoContainerMetadata {
  hasAudio: boolean;
  hasVideo: boolean;
  isMp4: boolean;
}

interface Mp4Box {
  dataStart: number;
  end: number;
  type: string;
}

const MP4_BRANDS = new Set([
  'avc1',
  'cmfc',
  'dash',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'isom',
  'M4A ',
  'M4V ',
  'mp41',
  'mp42',
  'MSNV',
]);

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/**
 * Parse ISO BMFF boxes without trusting a filename or File.type. The parser
 * intentionally validates boundaries and the MP4 ftyp/moov/track structure;
 * the browser still owns codec playback and FFprobe remains the upload
 * authority on the server.
 */
function parseMp4Boxes(bytes: Uint8Array, start: number, end: number): Mp4Box[] | null {
  if (start < 0 || end > bytes.byteLength || start > end) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset < end) {
    if (end - offset < 8) return null;
    const size32 = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, 4);
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (end - offset < 16) return null;
      size = view.getUint32(offset + 8) * 0x1_0000_0000 + view.getUint32(offset + 12);
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > end) return null;
    boxes.push({ dataStart: offset + headerSize, end: offset + size, type });
    offset += size;
  }
  return boxes;
}

function childBoxes(bytes: Uint8Array, box: Mp4Box): Mp4Box[] | null {
  return parseMp4Boxes(bytes, box.dataStart, box.end);
}

function sampleDescriptionExists(bytes: Uint8Array, stsd: Mp4Box): boolean {
  // FullBox version/flags plus entry_count precede the sample entries.
  if (stsd.end - stsd.dataStart < 8) return false;
  const entries = parseMp4Boxes(bytes, stsd.dataStart + 8, stsd.end);
  return entries !== null && entries.length > 0;
}

function parseMp4Container(bytes: Uint8Array): BrowserVideoContainerMetadata {
  const invalid = { hasAudio: false, hasVideo: false, isMp4: false };
  if (bytes.byteLength < 16) return invalid;

  const topLevel = parseMp4Boxes(bytes, 0, bytes.byteLength);
  const fileType = topLevel?.find((box) => box.type === 'ftyp');
  const movie = topLevel?.find((box) => box.type === 'moov');
  if (!topLevel || !fileType || !movie || fileType.end - fileType.dataStart < 8) return invalid;

  const brands = [ascii(bytes, fileType.dataStart, 4)];
  for (let offset = fileType.dataStart + 8; offset + 4 <= fileType.end; offset += 4) {
    brands.push(ascii(bytes, offset, 4));
  }
  if (!brands.some((brand) => MP4_BRANDS.has(brand))) return invalid;

  const movieChildren = childBoxes(bytes, movie);
  if (!movieChildren) return invalid;
  let hasAudio = false;
  let hasVideo = false;
  for (const track of movieChildren.filter((box) => box.type === 'trak')) {
    const trackChildren = childBoxes(bytes, track);
    const media = trackChildren?.find((box) => box.type === 'mdia');
    const mediaChildren = media ? childBoxes(bytes, media) : null;
    const handler = mediaChildren?.find((box) => box.type === 'hdlr');
    const mediaInfo = mediaChildren?.find((box) => box.type === 'minf');
    const mediaInfoChildren = mediaInfo ? childBoxes(bytes, mediaInfo) : null;
    const sampleTable = mediaInfoChildren?.find((box) => box.type === 'stbl');
    const sampleTableChildren = sampleTable ? childBoxes(bytes, sampleTable) : null;
    const sampleDescription = sampleTableChildren?.find((box) => box.type === 'stsd');
    if (!handler || handler.end - handler.dataStart < 12 || !sampleDescription) continue;
    if (!sampleDescriptionExists(bytes, sampleDescription)) continue;
    const handlerType = ascii(bytes, handler.dataStart + 8, 4);
    if (handlerType === 'soun') hasAudio = true;
    if (handlerType === 'vide') hasVideo = true;
  }

  return { hasAudio, hasVideo, isMp4: hasVideo };
}

async function readMp4Container(file: File): Promise<BrowserVideoContainerMetadata> {
  if (typeof file.arrayBuffer !== 'function') {
    throw new Error('This browser cannot inspect the selected video.');
  }
  return parseMp4Container(new Uint8Array(await file.arrayBuffer()));
}

async function chooseBrowserFile(accept: string): Promise<File> {
  if (Platform.OS !== 'web' || typeof document === 'undefined') {
    throw new Error('File fallback is available in a browser only.');
  }
  return new Promise<File>((resolve, reject) => {
    const input = document.createElement('input');
    input.accept = accept;
    input.type = 'file';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) resolve(file);
      else reject(new Error('No file was selected.'));
    };
    input.click();
  });
}

function createBrowserObjectUrl(file: File): string {
  if (typeof URL.createObjectURL !== 'function') {
    throw new Error('This browser cannot open a local file fallback.');
  }
  return URL.createObjectURL(file);
}

async function readImageDimensions(uri: string): Promise<{ height: number; width: number }> {
  if (typeof Image === 'undefined') {
    throw new Error('This browser cannot inspect the selected image.');
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ height: image.naturalHeight, width: image.naturalWidth });
    image.onerror = () => reject(new Error('The selected image could not be opened.'));
    image.src = uri;
  });
}

async function readVideoMetadata(uri: string): Promise<BrowserVideoMetadata> {
  let protocol: string;
  try {
    protocol = new URL(uri).protocol;
  } catch {
    throw new Error('The selected video preview must use a local blob URL.');
  }
  if (protocol !== 'blob:') {
    throw new Error('The selected video preview must use a local blob URL.');
  }
  if (typeof document === 'undefined') {
    throw new Error('This browser cannot inspect the selected video.');
  }
  return new Promise((resolve, reject) => {
    const video = document.createElement('video') as BrowserVideoElement;
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const durationSeconds = Number.isFinite(video.duration) ? video.duration : 0;
      const hasAudio = video.audioTracks
        ? video.audioTracks.length > 0
        : typeof video.mozHasAudio === 'boolean'
          ? video.mozHasAudio
          : typeof video.webkitAudioDecodedByteCount === 'number' &&
              video.webkitAudioDecodedByteCount > 0
            ? true
            : null;
      if (durationSeconds <= 0) {
        reject(new Error('The selected video has no usable duration.'));
        return;
      }
      resolve({
        durationSeconds,
        hasAudio,
        height: video.videoHeight,
        width: video.videoWidth,
      });
    };
    video.onerror = () => reject(new Error('The selected video could not be opened.'));
    video.src = uri;
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof btoa === 'function') return btoa(binary);
  const buffer = (
    globalThis as typeof globalThis & {
      Buffer?: { from(value: Uint8Array): { toString(encoding: string): string } };
    }
  ).Buffer;
  if (buffer) return buffer.from(bytes).toString('base64');
  throw new Error('This browser cannot read the selected file.');
}

function managedVideoId(): string {
  return `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function moveVideoToManagedCache(sourceUri: string): Promise<{
  uri: string;
  byteLength?: number;
}> {
  const cacheDirectory = FileSystem.cacheDirectory;
  if (!cacheDirectory) {
    const info = await FileSystem.getInfoAsync(sourceUri);
    return {
      uri: sourceUri,
      byteLength: info.exists && !info.isDirectory ? info.size : undefined,
    };
  }

  const folder = `${cacheDirectory}${VIDEO_CACHE_FOLDER}/`;
  const destination = `${folder}${managedVideoId()}.mp4`;
  try {
    await FileSystem.makeDirectoryAsync(folder, { intermediates: true });
    await FileSystem.copyAsync({ from: sourceUri, to: destination });
    const info = await FileSystem.getInfoAsync(destination);
    if (!info.exists || info.isDirectory || info.size <= 0) {
      throw new Error('The recorded video is empty.');
    }
    if (sourceUri !== destination) {
      await FileSystem.deleteAsync(sourceUri, { idempotent: true });
    }
    return { uri: destination, byteLength: info.size };
  } catch (error) {
    await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => undefined);
    if (error instanceof Error && error.message === 'The recorded video is empty.') throw error;
    throw new Error(
      'The recorded video could not be saved in app storage. Try recording it again.',
    );
  }
}

export async function removeManagedRecordedClip(uri: string): Promise<void> {
  const cacheDirectory = FileSystem.cacheDirectory;
  if (uri.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(uri);
    return;
  }
  if (!cacheDirectory || !uri.startsWith(`${cacheDirectory}${VIDEO_CACHE_FOLDER}/`)) return;
  await FileSystem.deleteAsync(uri, { idempotent: true });
}

/** Read a managed capture only for the server-owned binary upload boundary. */
export async function readManagedRecordedClipBase64(uri: string): Promise<string> {
  const cacheDirectory = FileSystem.cacheDirectory;
  if (uri.startsWith('blob:')) {
    const response = await fetch(uri);
    if (!response.ok) throw new Error('The selected clip is no longer available.');
    return bytesToBase64(new Uint8Array(await response.arrayBuffer()));
  }
  if (!cacheDirectory || !uri.startsWith(`${cacheDirectory}${VIDEO_CACHE_FOLDER}/`)) {
    throw new Error('The captured clip is no longer available in local storage.');
  }
  return FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

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
  /** Browser media seams keep file validation deterministic in adapter tests. */
  browserFilePicker?: (accept: string) => Promise<File>;
  browserImageDimensionsReader?: (uri: string) => Promise<{ height: number; width: number }>;
  browserObjectUrlFactory?: (file: File) => string;
  browserVideoContainerReader?: (file: File) => Promise<BrowserVideoContainerMetadata>;
  browserVideoMetadataReader?: (uri: string) => Promise<BrowserVideoMetadata>;
  /** Native photo-library seam; resolves null when the person cancels. */
  libraryVideoPicker?: () => Promise<LibraryVideoAsset | null>;
}

/** The subset of an Expo Image Picker video asset the adapter relies on. */
export interface LibraryVideoAsset {
  uri: string;
  width: number;
  height: number;
  /** Milliseconds, as reported by Expo Image Picker. */
  duration?: number | null;
  fileSize?: number;
}

async function launchLibraryVideoPicker(): Promise<LibraryVideoAsset | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    allowsEditing: false,
    mediaTypes: ['videos'],
    // Ask iOS for a widely decodable (H.264) representation of HEVC videos.
    preferredAssetRepresentationMode:
      ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    quality: 1,
  });
  if (result.canceled || !result.assets?.[0]) return null;
  const asset = result.assets[0];
  return {
    duration: asset.duration,
    fileSize: asset.fileSize,
    height: asset.height,
    uri: asset.uri,
    width: asset.width,
  };
}

async function webCameraAvailable(): Promise<boolean> {
  const probe = (CameraView as typeof CameraView & { isAvailableAsync?: () => Promise<boolean> })
    .isAvailableAsync;
  return typeof probe === 'function' ? probe.call(CameraView) : true;
}

/** Expo SDK 57 adapter. No Expo or React Native types cross the capture port. */
export class ExpoCameraPlatform implements CameraPlatform {
  readonly kind = 'expo' as const;
  readonly supportsLivePreview = true;
  readonly supportsVideoRecording = Platform.OS !== 'web';
  readonly supportsFileFallback = Platform.OS === 'web';
  readonly supportsLibraryVideo = Platform.OS !== 'web';

  constructor(private readonly options: ExpoCameraPlatformOptions) {}

  async getCapabilities(): Promise<CapabilitySnapshot> {
    if (this.options.capabilityProbe) return this.options.capabilityProbe();

    try {
      // `CameraView.isAvailableAsync` always exists as a static method, but
      // Expo Camera only registers its native side on web. On iOS/Android it
      // throws UnavailabilityError, so calling it there would report every
      // physical phone as "temporarily unavailable" and never reach the
      // permission prompt. Native availability is the device boundary.
      const cameraAvailable =
        Platform.OS === 'web'
          ? typeof navigator !== 'undefined' &&
            Boolean(navigator.mediaDevices?.getUserMedia) &&
            (await webCameraAvailable())
          : Device.isDevice;
      // Expo does not expose a microphone-capability probe. On native, a real
      // device is the supported recording target; simulator capture stays an
      // explicit unsupported state. On web, ask the browser capability API.
      const microphoneAvailable =
        Platform.OS === 'web'
          ? typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
          : Device.isDevice;

      return {
        camera: cameraAvailable ? 'supported' : 'unsupported',
        microphone: microphoneAvailable ? 'supported' : 'unsupported',
      };
    } catch {
      return { camera: 'undecided', microphone: 'undecided' };
    }
  }

  async getCameraPermission(): Promise<PermissionState> {
    return permissionState(await Camera.getCameraPermissionsAsync());
  }

  async requestCameraPermission(): Promise<PermissionState> {
    return permissionState(await Camera.requestCameraPermissionsAsync());
  }

  async getVideoPermissions(): Promise<PermissionSnapshot> {
    const [camera, microphone] = await Promise.all([
      Camera.getCameraPermissionsAsync(),
      Camera.getMicrophonePermissionsAsync(),
    ]);
    return {
      camera: permissionState(camera),
      microphone: permissionState(microphone),
    };
  }

  async requestVideoPermissions(): Promise<PermissionSnapshot> {
    // Ask one at a time: Android rejects a second runtime-permission request
    // while the first system dialog is still open, and iOS queues them anyway.
    const camera = await Camera.requestCameraPermissionsAsync();
    const microphone = await Camera.requestMicrophonePermissionsAsync();
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

  async pickStillFile(): Promise<PlatformStillImage> {
    const file = await (this.options.browserFilePicker ?? chooseBrowserFile)(
      '.jpg,.jpeg,.png,image/jpeg,image/png',
    );
    if (file.type !== 'image/jpeg' && file.type !== 'image/png') {
      throw new Error('Choose a JPEG or PNG image file.');
    }
    const sourceUri = (this.options.browserObjectUrlFactory ?? createBrowserObjectUrl)(file);
    try {
      const dimensions = await (this.options.browserImageDimensionsReader ?? readImageDimensions)(
        sourceUri,
      );
      return {
        format: file.type === 'image/png' ? 'png' : 'jpg',
        height: dimensions.height,
        source: 'file',
        sourceUri,
        width: dimensions.width,
      };
    } catch (error) {
      if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(sourceUri);
      throw error;
    }
  }

  async pickVideoFile(): Promise<RecordedClip> {
    const file = await (this.options.browserFilePicker ?? chooseBrowserFile)('.mp4,video/mp4');
    const container = await (this.options.browserVideoContainerReader ?? readMp4Container)(file);
    if (!container.isMp4 || !container.hasVideo) {
      throw new Error('Choose an MP4 video file.');
    }
    const sourceUri = (this.options.browserObjectUrlFactory ?? createBrowserObjectUrl)(file);
    try {
      const metadata = await (this.options.browserVideoMetadataReader ?? readVideoMetadata)(
        sourceUri,
      );
      if (metadata.durationSeconds > 15) {
        throw new Error('Choose an MP4 video that is 15 seconds or shorter.');
      }
      if (
        !Number.isInteger(metadata.width) ||
        !Number.isInteger(metadata.height) ||
        metadata.width <= 0 ||
        metadata.height <= 0 ||
        metadata.width >= metadata.height
      ) {
        throw new Error('Choose a portrait MP4 video.');
      }
      // Chromium's webkitAudioDecodedByteCount is a post-decode counter and
      // is commonly zero at loadedmetadata. Treat null as unknown here and
      // use the actual MP4 sound track as the local signal. The staged upload
      // is still verified authoritatively by server-side FFprobe.
      const hasAudio = container.hasAudio && metadata.hasAudio !== false;
      if (!hasAudio) {
        throw new Error('Choose an MP4 video that includes an audio track readable by the server.');
      }
      return {
        byteLength: file.size,
        durationSeconds: metadata.durationSeconds,
        format: 'mp4',
        hasAudio: true,
        height: metadata.height,
        mimeType: 'video/mp4',
        source: 'file',
        sourceUri,
        width: metadata.width,
      };
    } catch (error) {
      if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(sourceUri);
      throw error;
    }
  }

  /**
   * Choose an existing phone video of 15 seconds or less. Duration and the
   * displayed (rotation-aware) orientation are checked here; the server still
   * verifies the container and audio track before the clip is accepted.
   */
  async pickLibraryVideo(): Promise<RecordedClip | null> {
    if (!this.supportsLibraryVideo) {
      throw new Error('Choosing a phone video is only available on iOS and Android.');
    }
    const asset = await (this.options.libraryVideoPicker ?? launchLibraryVideoPicker)();
    if (!asset) return null;
    const durationSeconds = asset.duration ? asset.duration / 1000 : Number.NaN;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error('The video length could not be read. Choose another video.');
    }
    // Library durations can overshoot a 15-second recording by a few frames.
    if (durationSeconds > MAX_LIBRARY_VIDEO_SECONDS) {
      throw new Error('Choose a video that is 15 seconds or shorter.');
    }
    const width = Math.round(asset.width);
    const height = Math.round(asset.height);
    if (!(width > 0 && height > 0) || width >= height) {
      throw new Error('Choose a portrait video.');
    }
    const managed = await moveVideoToManagedCache(asset.uri);
    return {
      byteLength: managed.byteLength ?? asset.fileSize,
      durationSeconds,
      format: 'mp4',
      // Picker assets do not report audio; the server rejects silent clips.
      hasAudio: true,
      height,
      mimeType: 'video/mp4',
      source: 'file',
      sourceUri: managed.uri,
      width,
    };
  }

  async recordClip(maxDurationSeconds = 15): Promise<RecordedClip> {
    if (!this.supportsVideoRecording) {
      throw new Error('Video recording is not supported on the web platform.');
    }
    const camera = this.options.getCameraRef();
    if (!camera?.recordAsync) throw new Error('The camera recorder is not ready. Try again.');
    const startedAt = Date.now();
    const video = await camera.recordAsync({
      maxDuration: maxDurationSeconds,
      mute: false,
      quality: '480p',
    });
    if (!video) throw new Error('The recording was cancelled before a clip was saved.');
    const managed = await moveVideoToManagedCache(video.uri);
    const measuredDuration = (Date.now() - startedAt) / 1000;
    return {
      sourceUri: managed.uri,
      format: 'mp4',
      mimeType: 'video/mp4',
      width: video.width ?? 720,
      height: video.height ?? 1280,
      durationSeconds: Math.min(maxDurationSeconds, video.duration ?? measuredDuration),
      hasAudio: true,
      byteLength: managed.byteLength,
      source: 'camera',
    };
  }

  stopRecording(): void {
    this.options.getCameraRef()?.stopRecording?.();
  }

  cancelRecording(): void {
    this.options.getCameraRef()?.stopRecording?.();
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
  readonly supportsVideoRecording = false;
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

  async getCameraPermission(): Promise<PermissionState> {
    return this.permissions.camera;
  }

  async requestCameraPermission(): Promise<PermissionState> {
    return this.permissions.camera;
  }

  async getVideoPermissions(): Promise<PermissionSnapshot> {
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

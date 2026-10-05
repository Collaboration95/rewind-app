import { Platform, Linking } from 'react-native';
import { Camera, type CameraCapturedPicture } from 'expo-camera';
import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system/legacy';

import type {
  CameraPlatform,
  CameraViewHandle,
  CapabilitySnapshot,
  PermissionSnapshot,
  PermissionState,
  PlatformStillImage,
} from './contracts';
import type { RecordedClip } from '../domain/video';
import { MAX_CLIP_BYTES } from './clip-uploader';

export const VIDEO_CACHE_FOLDER = 'rewind-clips';

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
  // iPhone camera recordings are QuickTime; the server verifies and re-encodes.
  'qt  ',
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

async function readMp4Container(file: Blob): Promise<BrowserVideoContainerMetadata> {
  if (typeof file.arrayBuffer !== 'function') {
    throw new Error('This browser cannot inspect the selected video.');
  }
  return parseMp4Container(new Uint8Array(await file.arrayBuffer()));
}

/** The person closed the file chooser or camera sheet without choosing anything. */
export class CaptureCancelledError extends Error {
  constructor() {
    super('Nothing was captured.');
    this.name = 'CaptureCancelledError';
  }
}

export function isCaptureCancelled(error: unknown): boolean {
  return error instanceof CaptureCancelledError;
}

async function chooseBrowserFile(accept: string, capture?: 'environment'): Promise<File> {
  if (Platform.OS !== 'web' || typeof document === 'undefined') {
    throw new Error('File fallback is available in a browser only.');
  }
  return new Promise<File>((resolve, reject) => {
    const input = document.createElement('input');
    input.accept = accept;
    input.type = 'file';
    // On phones this opens the system camera directly, without the library.
    if (capture) input.setAttribute('capture', capture);
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) resolve(file);
      else reject(new CaptureCancelledError());
    };
    // Safari 16.4+ and current Chromium report a dismissed chooser or camera.
    input.addEventListener('cancel', () => reject(new CaptureCancelledError()));
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

export const VIDEO_METADATA_TIMEOUT_MS = 10_000;

export async function readVideoMetadata(
  uri: string,
  signal?: AbortSignal,
): Promise<BrowserVideoMetadata> {
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
    let settled = false;
    let recoveringDuration = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', fail);
      video.onloadedmetadata = null;
      video.ondurationchange = null;
      video.ontimeupdate = null;
      video.onerror = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("This video couldn't be read. Try recording again."));
    };
    const read = () => {
      if (settled) return;
      if (video.duration === Infinity) {
        // Streaming MediaRecorder files may only reveal their duration after
        // seeking past the final frame. Keep this recovery under the same deadline.
        if (!recoveringDuration) {
          recoveringDuration = true;
          try {
            video.currentTime = 1e101;
          } catch {
            fail();
          }
        }
        return;
      }
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        fail();
        return;
      }
      const metadata = {
        durationSeconds: video.duration,
        hasAudio: video.audioTracks
          ? video.audioTracks.length > 0
          : typeof video.mozHasAudio === 'boolean'
            ? video.mozHasAudio
            : typeof video.webkitAudioDecodedByteCount === 'number' &&
                video.webkitAudioDecodedByteCount > 0
              ? true
              : null,
        height: video.videoHeight,
        width: video.videoWidth,
      };
      settled = true;
      cleanup();
      resolve(metadata);
    };
    const timer = setTimeout(fail, VIDEO_METADATA_TIMEOUT_MS);
    video.preload = 'metadata';
    video.onloadedmetadata = read;
    video.ondurationchange = () => {
      if (recoveringDuration) read();
    };
    video.ontimeupdate = () => {
      if (recoveringDuration) read();
    };
    video.onerror = fail;
    signal?.addEventListener('abort', fail, { once: true });
    if (signal?.aborted) fail();
    else video.src = uri;
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
export async function readManagedRecordedClipBase64(
  uri: string,
  signal?: AbortSignal,
): Promise<string> {
  const cacheDirectory = FileSystem.cacheDirectory;
  if (uri.startsWith('blob:')) {
    const response = await fetch(uri, { signal });
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

/** The uploadable MP4 MediaRecorder type this browser supports, if any. */
export function supportedMp4Type(MediaRecorderConstructor: typeof MediaRecorder): string | null {
  return (
    [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
      'video/mp4',
    ].find((type) => MediaRecorderConstructor.isTypeSupported(type)) ?? null
  );
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
  browserFilePicker?: (accept: string, capture?: 'environment') => Promise<File>;
  /**
   * Web only: take photos and videos with the phone's own camera sheet (full
   * native quality and orientation) instead of an in-page viewfinder.
   */
  browserSystemCamera?: boolean;
  browserImageDimensionsReader?: (uri: string) => Promise<{ height: number; width: number }>;
  browserObjectUrlFactory?: (file: File) => string;
  browserVideoContainerReader?: (file: File) => Promise<BrowserVideoContainerMetadata>;
  browserVideoMetadataReader?: (uri: string) => Promise<BrowserVideoMetadata>;
  browserMediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
  browserMediaRecorder?: typeof MediaRecorder;
  browserSecureContext?: () => boolean;
  browserPermissionReader?: () => Promise<PermissionSnapshot>;
  /** Waits between still-capture attempts while a browser camera warms up. */
  wait?: (milliseconds: number) => Promise<void>;
  /** Web only: the live preview <video> expo-camera renders inside CameraView. */
  browserPreviewVideo?: () => HTMLVideoElement | null;
}

// iPhone Safari can report the camera ready before its video element holds a
// frame; expo-camera then throws this error. Retry briefly instead of failing.
const CAMERA_WARMUP_RETRIES = 10;
const CAMERA_WARMUP_DELAY_MS = 200;

function isCameraWarmingUp(error: unknown): boolean {
  return error instanceof Error && /enough camera data/i.test(error.message);
}

const HAVE_ENOUGH_DATA = 4;
const CAMERA_FRAME_TIMEOUT_MS = 3000;

function findBrowserPreviewVideo(): HTMLVideoElement | null {
  // expo-camera renders its preview as <video autoplay playsinline muted>.
  return globalThis.document?.querySelector?.<HTMLVideoElement>('video[playsinline]') ?? null;
}

/**
 * expo-camera's web takePicture demands readyState === HAVE_ENOUGH_DATA.
 * iPhone Safari can fire onCameraReady (and pause the preview after a
 * background/foreground) before that, so wait for a frame, nudging a paused
 * preview to play. Resolves after a bounded timeout; the retry loop remains.
 */
function waitForVideoFrame(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  if (video.readyState >= HAVE_ENOUGH_DATA) return Promise.resolve();
  if (video.paused) void video.play?.()?.catch?.(() => undefined);
  return new Promise((resolve) => {
    const events = ['loadeddata', 'canplay', 'canplaythrough', 'playing'] as const;
    const done = () => {
      clearTimeout(timer);
      for (const name of events) video.removeEventListener(name, check);
      resolve();
    };
    const check = () => {
      if (video.readyState >= HAVE_ENOUGH_DATA) done();
    };
    const timer = setTimeout(done, timeoutMs);
    for (const name of events) video.addEventListener(name, check);
  });
}

/** Expo SDK 57 adapter. No Expo or React Native types cross the capture port. */
export class ExpoCameraPlatform implements CameraPlatform {
  readonly kind = 'expo' as const;
  get supportsLivePreview(): boolean {
    return !this.fileFallbackIsCamera;
  }
  get supportsVideoRecording(): boolean {
    if (this.fileFallbackIsCamera) return false;
    return Platform.OS !== 'web' || this.browserRecordingSupport().supported;
  }
  readonly supportsFileFallback = Platform.OS === 'web';
  get fileFallbackIsCamera(): boolean {
    return Platform.OS === 'web' && this.options.browserSystemCamera === true;
  }
  private browserStream: MediaStream | null = null;
  private browserRecorder: MediaRecorder | null = null;
  private browserChunks: BlobPart[] = [];
  private browserRecordingTimer: ReturnType<typeof setTimeout> | null = null;
  private browserRecordingCancelled = false;

  private browserRecordingSupport(): { supported: boolean; reason: string | null } {
    if (Platform.OS !== 'web') return { supported: true, reason: null };
    const mediaDevices = this.options.browserMediaDevices ?? globalThis.navigator?.mediaDevices;
    const MediaRecorderConstructor = this.options.browserMediaRecorder ?? globalThis.MediaRecorder;
    const secureContext = this.options.browserSecureContext?.() ?? globalThis.isSecureContext;
    if (!secureContext) {
      return {
        supported: false,
        reason:
          'Camera and microphone capture requires HTTPS (or localhost). Open the secure Rewind address to record.',
      };
    }
    if (!mediaDevices?.getUserMedia) {
      return {
        supported: false,
        reason: 'This browser does not provide camera and microphone capture.',
      };
    }
    if (
      !MediaRecorderConstructor ||
      typeof MediaRecorderConstructor.isTypeSupported !== 'function'
    ) {
      return {
        supported: false,
        reason: 'This browser cannot record a video file. Choose an MP4 video instead.',
      };
    }
    if (!this.supportedMp4Type(MediaRecorderConstructor)) {
      return {
        supported: false,
        reason:
          'This browser cannot record the MP4 format required for upload. Choose an MP4 video instead.',
      };
    }
    return { supported: true, reason: null };
  }

  private supportedMp4Type(MediaRecorderConstructor: typeof MediaRecorder): string | null {
    return supportedMp4Type(MediaRecorderConstructor);
  }

  getVideoPreviewStream(): MediaStream | null {
    return this.browserStream;
  }

  getVideoCaptureUnavailableReason(): string | null {
    if (this.fileFallbackIsCamera) return null;
    return this.browserRecordingSupport().reason;
  }

  releaseVideoCapture(): void {
    if (this.browserRecordingTimer) clearTimeout(this.browserRecordingTimer);
    this.browserRecordingTimer = null;
    if (this.browserRecorder && this.browserRecorder.state !== 'inactive') {
      this.browserRecordingCancelled = true;
      this.browserRecorder.stop();
    }
    this.browserStream?.getTracks().forEach((track) => track.stop());
    this.browserStream = null;
  }

  private async acquireBrowserStream(): Promise<MediaStream> {
    if (this.browserStream?.getTracks().some((track) => track.readyState === 'live')) {
      return this.browserStream;
    }
    const support = this.browserRecordingSupport();
    if (!support.supported) throw new Error(support.reason ?? 'Video recording is unavailable.');
    const mediaDevices = this.options.browserMediaDevices ?? globalThis.navigator?.mediaDevices;
    if (!mediaDevices) throw new Error('Camera and microphone capture is unavailable.');
    const stream = await mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode: { ideal: 'environment' },
        // Ask for 1080p; the browser picks the closest supported size and
        // rotates frames to match how the phone is held.
        frameRate: { ideal: 30 },
        height: { ideal: 1080 },
        width: { ideal: 1920 },
      },
    });
    if (!stream.getAudioTracks().length || !stream.getVideoTracks().length) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('Both camera video and microphone audio are required to record.');
    }
    this.releaseVideoCapture();
    this.browserStream = stream;
    return stream;
  }

  private async recordBrowserClip(maxDurationSeconds: number): Promise<RecordedClip> {
    const support = this.browserRecordingSupport();
    const MediaRecorderConstructor = this.options.browserMediaRecorder ?? globalThis.MediaRecorder;
    const mimeType = MediaRecorderConstructor && this.supportedMp4Type(MediaRecorderConstructor);
    if (!support.supported || !MediaRecorderConstructor || !mimeType) {
      throw new Error(support.reason ?? 'This browser cannot record an uploadable MP4 video.');
    }
    const stream = await this.acquireBrowserStream();
    // Safari's default bitrate is low; 8 Mbps keeps 1080p sharp (about 15 MB
    // for 15 seconds, within the 50 MB clip limit).
    const recorder = new MediaRecorderConstructor(stream, {
      audioBitsPerSecond: 128_000,
      mimeType,
      videoBitsPerSecond: 8_000_000,
    });
    this.browserRecorder = recorder;
    this.browserChunks = [];
    this.browserRecordingCancelled = false;
    const durationLimit = Math.min(15, Math.max(1, maxDurationSeconds));

    return new Promise<RecordedClip>((resolve, reject) => {
      const finish = async () => {
        if (this.browserRecordingTimer) clearTimeout(this.browserRecordingTimer);
        this.browserRecordingTimer = null;
        const cancelled = this.browserRecordingCancelled;
        this.browserRecorder = null;
        this.releaseVideoCapture();
        if (cancelled) {
          reject(new Error('The recording was cancelled.'));
          return;
        }
        const blob = new Blob(this.browserChunks, { type: recorder.mimeType || mimeType });
        this.browserChunks = [];
        if (!blob.size || !blob.type.toLowerCase().startsWith('video/mp4')) {
          reject(
            new Error(
              'This browser did not produce a usable MP4 recording. Choose an MP4 video instead.',
            ),
          );
          return;
        }
        const sourceUri = URL.createObjectURL(blob);
        try {
          const container = await (this.options.browserVideoContainerReader ?? readMp4Container)(
            blob as File,
          );
          if (!container.isMp4 || !container.hasVideo || !container.hasAudio) {
            throw new Error(
              'The browser recording must contain MP4 video and microphone audio. Try another browser or choose an MP4 video.',
            );
          }
          const metadata = await (this.options.browserVideoMetadataReader ?? readVideoMetadata)(
            sourceUri,
          );
          if (metadata.durationSeconds > durationLimit || metadata.durationSeconds > 15) {
            throw new Error('Recordings must be 15 seconds or shorter.');
          }
          // Portrait and landscape are both accepted; the film letterboxes
          // landscape clips. iPhone recordings may also store landscape
          // frames with a rotation flag, so frame shape is not orientation.
          if (
            !Number.isInteger(metadata.width) ||
            !Number.isInteger(metadata.height) ||
            metadata.width <= 0 ||
            metadata.height <= 0
          ) {
            throw new Error('The browser recording has no usable video. Try recording again.');
          }
          resolve({
            byteLength: blob.size,
            durationSeconds: metadata.durationSeconds,
            format: 'mp4',
            hasAudio: true,
            height: metadata.height,
            mimeType: 'video/mp4',
            source: 'camera',
            sourceUri,
            width: metadata.width,
          });
        } catch (error) {
          URL.revokeObjectURL(sourceUri);
          reject(error);
        }
      };

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.browserChunks.push(event.data);
      };
      recorder.onerror = () => {
        this.releaseVideoCapture();
        this.browserRecorder = null;
        reject(
          new Error(
            'The browser could not finish recording. Check camera/microphone access and try again.',
          ),
        );
      };
      recorder.onstop = () => void finish();
      try {
        recorder.start(250);
        this.browserRecordingTimer = setTimeout(() => this.stopRecording(), durationLimit * 1000);
      } catch (error) {
        this.browserRecorder = null;
        this.releaseVideoCapture();
        reject(
          error instanceof Error ? error : new Error('The browser could not start recording.'),
        );
      }
    });
  }

  constructor(private readonly options: ExpoCameraPlatformOptions) {}

  async getCapabilities(): Promise<CapabilitySnapshot> {
    if (this.options.capabilityProbe) return this.options.capabilityProbe();

    if (Platform.OS === 'web') {
      // The system camera sheet replaces the in-page camera; the screens then
      // offer it through their single fallback action.
      if (this.fileFallbackIsCamera) return { camera: 'unsupported', microphone: 'unsupported' };
      const supported = this.browserRecordingSupport().supported;
      return {
        camera: supported ? 'supported' : 'unsupported',
        microphone: supported ? 'supported' : 'unsupported',
      };
    }

    try {
      // Expo does not expose a microphone-capability probe. On native, a real
      // device is the supported recording target; simulator capture stays an
      // explicit unsupported state.
      const cameraAvailable = Device.isDevice;
      const microphoneAvailable = Device.isDevice;

      return {
        camera: cameraAvailable ? 'supported' : 'unsupported',
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
    const camera = await Camera.requestCameraPermissionsAsync();
    const microphone = await Camera.getMicrophonePermissionsAsync();
    return {
      camera: permissionState(camera),
      microphone: permissionState(microphone),
    };
  }

  async getVideoPermissions(): Promise<PermissionSnapshot> {
    if (Platform.OS === 'web') {
      if (this.options.browserPermissionReader) return this.options.browserPermissionReader();
      if (this.browserStream?.getTracks().some((track) => track.readyState === 'live')) {
        return { camera: 'granted', microphone: 'granted' };
      }
      const permissions = globalThis.navigator?.permissions;
      if (!permissions?.query) {
        return { camera: 'undetermined', microphone: 'undetermined' };
      }
      const read = async (name: 'camera' | 'microphone'): Promise<PermissionState> => {
        try {
          const status = await permissions.query({ name } as PermissionDescriptor);
          return status.state === 'granted'
            ? 'granted'
            : status.state === 'denied'
              ? 'denied'
              : 'undetermined';
        } catch {
          return 'undetermined';
        }
      };
      const [camera, microphone] = await Promise.all([read('camera'), read('microphone')]);
      return { camera, microphone };
    }
    const [camera, microphone] = await Promise.all([
      Camera.getCameraPermissionsAsync(),
      Camera.getMicrophonePermissionsAsync(),
    ]);
    return { camera: permissionState(camera), microphone: permissionState(microphone) };
  }

  async requestVideoPermissions(): Promise<PermissionSnapshot> {
    if (Platform.OS === 'web') {
      try {
        await this.acquireBrowserStream();
        return { camera: 'granted', microphone: 'granted' };
      } catch (error) {
        if (
          error instanceof Error &&
          ['NotAllowedError', 'PermissionDeniedError'].includes(error.name)
        ) {
          return { camera: 'denied', microphone: 'denied' };
        }
        throw error;
      }
    }
    // Native permission prompts must be opened serially. A phone may reject
    // or queue the microphone request while the camera dialog is still open.
    const camera = await Camera.requestCameraPermissionsAsync();
    const microphone =
      camera.status === 'granted'
        ? await Camera.requestMicrophonePermissionsAsync()
        : await Camera.getMicrophonePermissionsAsync();
    return { camera: permissionState(camera), microphone: permissionState(microphone) };
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
    const video = (this.options.browserPreviewVideo ?? findBrowserPreviewVideo)();
    if (video) await waitForVideoFrame(video, CAMERA_FRAME_TIMEOUT_MS);

    const wait =
      this.options.wait ??
      ((milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds)));
    let picture: CameraCapturedPicture | null = null;
    for (let attempt = 0; !picture; attempt += 1) {
      try {
        picture = await camera.takePictureAsync({
          base64: Platform.OS === 'web',
          quality: 0.85,
          shutterSound: true,
          skipProcessing: false,
        });
      } catch (error) {
        if (!isCameraWarmingUp(error)) throw error;
        if (attempt >= CAMERA_WARMUP_RETRIES) {
          throw new Error(
            'The camera is still starting. Wait a moment, then take the photo again.',
          );
        }
        await wait(CAMERA_WARMUP_DELAY_MS);
      }
    }
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
    const camera = this.fileFallbackIsCamera;
    const file = await (this.options.browserFilePicker ?? chooseBrowserFile)(
      camera ? 'image/jpeg,image/png' : '.jpg,.jpeg,.png,image/jpeg,image/png',
      camera ? 'environment' : undefined,
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
        source: camera ? 'camera' : 'file',
        sourceUri,
        width: dimensions.width,
      };
    } catch (error) {
      if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(sourceUri);
      throw error;
    }
  }

  async pickVideoFile(): Promise<RecordedClip> {
    const camera = this.fileFallbackIsCamera;
    const file = await (this.options.browserFilePicker ?? chooseBrowserFile)(
      camera ? 'video/*' : '.mp4,video/mp4',
      camera ? 'environment' : undefined,
    );
    if (camera && file.size > MAX_CLIP_BYTES) {
      throw new Error(
        'This video is over 50 MB. Record a shorter clip, or set the camera to 1080p in Settings.',
      );
    }
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
        throw new Error(
          camera
            ? 'Videos can be up to 15 seconds. Record a shorter clip.'
            : 'Choose an MP4 video that is 15 seconds or shorter.',
        );
      }
      if (
        !Number.isInteger(metadata.width) ||
        !Number.isInteger(metadata.height) ||
        metadata.width <= 0 ||
        metadata.height <= 0
      ) {
        throw new Error('Choose an MP4 video.');
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
        source: camera ? 'camera' : 'file',
        sourceUri,
        width: metadata.width,
      };
    } catch (error) {
      if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(sourceUri);
      throw error;
    }
  }

  async recordClip(maxDurationSeconds = 15): Promise<RecordedClip> {
    if (Platform.OS === 'web') return this.recordBrowserClip(maxDurationSeconds);
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
    if (this.browserRecorder && this.browserRecorder.state !== 'inactive') {
      this.browserRecorder.stop();
      return;
    }
    this.options.getCameraRef()?.stopRecording?.();
  }

  cancelRecording(): void {
    if (this.browserRecorder && this.browserRecorder.state !== 'inactive') {
      this.browserRecordingCancelled = true;
      this.browserRecorder.stop();
      return;
    }
    if (Platform.OS === 'web') {
      this.releaseVideoCapture();
      return;
    }
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

import type { CaptureMode } from '../domain/video';
import { readVideoMetadata, supportedMp4Type } from './platform';
import {
  createRandom,
  drawRetroFrame,
  fillNoise,
  fitWithin,
  NOISE_TILE_SIZE,
  seedFromString,
} from './retro-looks';

/**
 * Browser adapter that applies a retro look on this device before upload.
 * Photos are graded on a canvas; videos are re-encoded in real time by
 * playing the trimmed segment into a canvas and recording it with its audio
 * (routed through Web Audio, because Safari lacks `HTMLMediaElement.captureStream`).
 * Every DOM API is touched only when a function is called, so importing this
 * module on native is harmless.
 */

export const MAX_RETRO_PHOTO_EDGE = 2160;
/** Stay safely under the 15-second limit after recorder start-up latency. */
export const MAX_RETRO_VIDEO_SECONDS = 14.8;
/** Opening and seeking a local clip should take seconds, not minutes. */
const INIT_TIMEOUT_MS = 20_000;

export class RetroProcessingError extends Error {
  constructor(
    message: string,
    readonly cancelled = false,
  ) {
    super(message);
    this.name = 'RetroProcessingError';
  }
}

export interface RetroPhotoResult {
  base64: string;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  byteLength: number;
}

export interface RetroVideoResult {
  sourceUri: string;
  byteLength: number;
  durationSeconds: number;
  width: number;
  height: number;
}

type AudioContextConstructor = typeof AudioContext;

function audioContextConstructor(): AudioContextConstructor | undefined {
  const scope = globalThis as typeof globalThis & { webkitAudioContext?: AudioContextConstructor };
  return scope.AudioContext ?? scope.webkitAudioContext;
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new RetroProcessingError('This browser cannot draw the retro look.');
  return ctx;
}

function noiseTile(random: () => number): HTMLCanvasElement {
  const canvas = makeCanvas(NOISE_TILE_SIZE, NOISE_TILE_SIZE);
  const ctx = context2d(canvas);
  const image = ctx.createImageData(NOISE_TILE_SIZE, NOISE_TILE_SIZE);
  fillNoise(image.data, random);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function supportsFilter(ctx: CanvasRenderingContext2D): boolean {
  return typeof (ctx as { filter?: unknown }).filter === 'string';
}

function releaseCanvas(canvas: HTMLCanvasElement | null) {
  // Safari keeps canvas backing stores alive until they are shrunk.
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result);
      resolve(value.slice(value.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new RetroProcessingError('The retro photo could not be read.'));
    reader.readAsDataURL(blob);
  });
}

async function loadImage(base64: string, mimeType: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = `data:${mimeType};base64,${base64}`;
  try {
    await image.decode();
  } catch {
    if (!image.complete || !image.naturalWidth) {
      throw new RetroProcessingError('The photo could not be opened to apply the retro look.');
    }
  }
  return image;
}

/** Grade a still photo; deterministic for the same seed so a retry sends identical bytes. */
export async function applyRetroLookToPhoto(input: {
  base64: string;
  mimeType: string;
  mode: CaptureMode;
  capturedAt: Date;
  seed: string;
}): Promise<RetroPhotoResult> {
  if (typeof document === 'undefined') {
    throw new RetroProcessingError('This browser cannot apply the retro look.');
  }
  const image = await loadImage(input.base64, input.mimeType);
  const size = fitWithin(image.naturalWidth, image.naturalHeight, MAX_RETRO_PHOTO_EDGE);
  const random = createRandom(seedFromString(`${input.seed}|${input.mode}`));
  let canvas: HTMLCanvasElement | null = null;
  let scratch: HTMLCanvasElement | null = null;
  try {
    canvas = makeCanvas(size.width, size.height);
    const ctx = context2d(canvas);
    scratch = input.mode === 'vhs' ? makeCanvas(size.width, size.height) : null;
    drawRetroFrame(ctx, image, input.mode, {
      ...size,
      time: 0,
      random,
      capturedAt: input.capturedAt,
      supportsFilter: supportsFilter(ctx),
      moving: false,
      noise: noiseTile(random),
      scratch: scratch ? context2d(scratch) : null,
    });
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas!.toBlob(resolve, 'image/jpeg', 0.9),
    );
    if (!blob?.size) throw new RetroProcessingError('The retro photo could not be encoded.');
    return {
      base64: await blobToBase64(blob),
      mimeType: 'image/jpeg',
      width: size.width,
      height: size.height,
      byteLength: blob.size,
    };
  } finally {
    releaseCanvas(canvas);
    releaseCanvas(scratch);
  }
}

/** Whether this browser can re-encode a video with a retro look. */
export function canProcessRetroVideo(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function' &&
    typeof MediaStream !== 'undefined' &&
    Boolean(audioContextConstructor()) &&
    typeof globalThis.MediaRecorder !== 'undefined' &&
    typeof MediaRecorder.isTypeSupported === 'function' &&
    Boolean(supportedMp4Type(MediaRecorder))
  );
}

function waitFor(target: HTMLMediaElement, event: 'loadedmetadata' | 'seeked'): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      target.removeEventListener(event, done);
      target.removeEventListener('error', failed);
      resolve();
    };
    const failed = () => {
      target.removeEventListener(event, done);
      target.removeEventListener('error', failed);
      reject(new RetroProcessingError('The clip could not be opened to apply the retro look.'));
    };
    target.addEventListener(event, done);
    target.addEventListener('error', failed);
  });
}

/**
 * Re-encode `[startSeconds, endSeconds]` of a local clip with the chosen look.
 * Call it directly from the tap handler: the audio context and first play()
 * are started synchronously so iPhone Safari treats them as user-initiated.
 */
export function applyRetroLookToVideo(
  input: {
    sourceUri: string;
    startSeconds: number;
    endSeconds: number;
    mode: CaptureMode;
    capturedAt: Date;
  },
  options: { signal?: AbortSignal; onProgress?: (percent: number) => void } = {},
): Promise<RetroVideoResult> {
  const AudioContextCtor = audioContextConstructor();
  const mimeType =
    typeof globalThis.MediaRecorder === 'undefined' ? null : supportedMp4Type(MediaRecorder);
  if (!canProcessRetroVideo() || !AudioContextCtor || !mimeType) {
    return Promise.reject(
      new RetroProcessingError('This browser cannot apply the retro look to video.'),
    );
  }
  if (options.signal?.aborted) {
    return Promise.reject(new RetroProcessingError('The retro look was cancelled.', true));
  }

  const audio = new AudioContextCtor();
  void audio.resume().catch(() => undefined);
  const video = document.createElement('video');
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.preload = 'auto';
  video.muted = false;
  // Kept in the document (not display:none) so mobile Safari keeps decoding.
  Object.assign(video.style, {
    height: '2px',
    left: '0',
    opacity: '0',
    pointerEvents: 'none',
    position: 'fixed',
    top: '0',
    width: '2px',
  });
  video.src = input.sourceUri;
  document.body.appendChild(video);
  // Route the clip's audio into the recording only; nothing plays aloud.
  const audioSource = audio.createMediaElementSource(video);
  const audioOut = audio.createMediaStreamDestination();
  audioSource.connect(audioOut);
  const unlocked = video.play().then(
    () => video.pause(),
    () => undefined,
  );

  let canvas: HTMLCanvasElement | null = null;
  let scratch: HTMLCanvasElement | null = null;
  let stream: MediaStream | null = null;
  const cleanup = () => {
    clearTimeout(initTimer);
    options.signal?.removeEventListener('abort', onInitAbort);
    stream?.getTracks().forEach((track) => track.stop());
    audioOut.stream.getTracks().forEach((track) => track.stop());
    try {
      audioSource.disconnect();
    } catch {
      // Already disconnected.
    }
    void audio.close().catch(() => undefined);
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
    releaseCanvas(canvas);
    releaseCanvas(scratch);
  };

  // Opening and seeking the clip can stall; keep those waits cancellable and
  // bounded so a stuck decoder never strands processing or its resources.
  let stopInit: (error: RetroProcessingError) => void = () => undefined;
  const initStopped = new Promise<never>((_resolve, reject) => {
    stopInit = reject;
  });
  initStopped.catch(() => undefined);
  const onInitAbort = () =>
    stopInit(new RetroProcessingError('The retro look was cancelled.', true));
  options.signal?.addEventListener('abort', onInitAbort);
  const initTimer = setTimeout(
    () =>
      stopInit(new RetroProcessingError('The clip could not be opened to apply the retro look.')),
    INIT_TIMEOUT_MS,
  );
  const initStep = <T>(step: Promise<T>): Promise<T> => Promise.race([step, initStopped]);

  const run = async (): Promise<RetroVideoResult> => {
    await initStep(unlocked);
    if (video.readyState < 1) await initStep(waitFor(video, 'loadedmetadata'));
    const start = Math.max(0, input.startSeconds);
    const end = Math.min(input.endSeconds, start + MAX_RETRO_VIDEO_SECONDS);
    if (!(end - start >= 0.5)) {
      throw new RetroProcessingError('Keep at least half a second in the clip.');
    }
    if (Math.abs(video.currentTime - start) > 0.001) {
      const seeked = waitFor(video, 'seeked');
      video.currentTime = start;
      await initStep(seeked);
    }
    clearTimeout(initTimer);
    options.signal?.removeEventListener('abort', onInitAbort);
    if (options.signal?.aborted)
      throw new RetroProcessingError('The retro look was cancelled.', true);
    const size = fitWithin(video.videoWidth, video.videoHeight, 1920, 1080);
    canvas = makeCanvas(size.width, size.height);
    const ctx = context2d(canvas);
    scratch = input.mode === 'vhs' ? makeCanvas(size.width, size.height) : null;
    const scratchCtx = scratch ? context2d(scratch) : null;
    const random = createRandom(seedFromString(`${input.sourceUri}|${input.mode}`));
    const noise = noiseTile(random);
    const filter = supportsFilter(ctx);
    const draw = (time: number) =>
      drawRetroFrame(ctx, video, input.mode, {
        ...size,
        time,
        random,
        capturedAt: input.capturedAt,
        supportsFilter: filter,
        moving: true,
        noise,
        scratch: scratchCtx,
      });
    draw(0);
    stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(
      new MediaStream([...stream.getVideoTracks(), ...audioOut.stream.getAudioTracks()]),
      { audioBitsPerSecond: 128_000, mimeType, videoBitsPerSecond: 8_000_000 },
    );
    const chunks: Blob[] = [];

    return new Promise<RetroVideoResult>((resolve, reject) => {
      let settled = false;
      let frame = 0;
      const timer = setTimeout(
        () => fail(new RetroProcessingError('Applying the retro look took too long.')),
        (end - start) * 3000 + 15_000,
      );
      const detach = () => {
        clearTimeout(timer);
        cancelAnimationFrame(frame);
        options.signal?.removeEventListener('abort', onAbort);
        document.removeEventListener('visibilitychange', onVisibility);
        video.removeEventListener('ended', finish);
        video.removeEventListener('error', onError);
      };
      const fail = (error: RetroProcessingError) => {
        if (settled) return;
        settled = true;
        detach();
        recorder.ondataavailable = null;
        recorder.onstop = null;
        try {
          if (recorder.state !== 'inactive') recorder.stop();
        } catch {
          // The recorder already stopped.
        }
        video.pause();
        reject(error);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        detach();
        video.pause();
        recorder.stop();
      };
      const onAbort = () => fail(new RetroProcessingError('The retro look was cancelled.', true));
      const onVisibility = () => {
        if (document.hidden) {
          fail(
            new RetroProcessingError(
              'Keep Rewind open while the retro look is applied, then try again.',
            ),
          );
        }
      };
      const onError = () =>
        fail(new RetroProcessingError('The clip could not be played to apply the retro look.'));
      options.signal?.addEventListener('abort', onAbort);
      document.addEventListener('visibilitychange', onVisibility);
      video.addEventListener('ended', finish);
      video.addEventListener('error', onError);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () =>
        fail(new RetroProcessingError('The browser could not record the retro clip.'));
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
        if (!blob.size || !blob.type.toLowerCase().startsWith('video/mp4')) {
          reject(new RetroProcessingError('The browser did not produce a usable retro MP4.'));
          return;
        }
        const sourceUri = URL.createObjectURL(blob);
        readVideoMetadata(sourceUri, options.signal).then(
          (metadata) =>
            resolve({
              sourceUri,
              byteLength: blob.size,
              durationSeconds: metadata.durationSeconds,
              width: size.width,
              height: size.height,
            }),
          () => {
            URL.revokeObjectURL(sourceUri);
            reject(new RetroProcessingError('The retro clip could not be verified.'));
          },
        );
      };

      const loop = () => {
        if (settled) return;
        const elapsed = video.currentTime - start;
        draw(Math.max(0, elapsed));
        options.onProgress?.(
          Math.max(0, Math.min(99, Math.round((elapsed / (end - start)) * 100))),
        );
        if (video.currentTime >= end) {
          finish();
          return;
        }
        frame = requestAnimationFrame(loop);
      };
      try {
        recorder.start(250);
      } catch {
        fail(new RetroProcessingError('The browser could not start recording the retro clip.'));
        return;
      }
      video.play().then(
        () => {
          frame = requestAnimationFrame(loop);
        },
        () =>
          fail(
            new RetroProcessingError(
              'The clip could not be played to apply the retro look. Tap Upload again.',
            ),
          ),
      );
    });
  };

  return run().finally(cleanup);
}

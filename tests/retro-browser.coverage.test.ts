import type { CaptureMode } from '../src/domain/video';
import {
  applyRetroLookToPhoto,
  applyRetroLookToVideo,
  canProcessRetroVideo,
  MAX_RETRO_PHOTO_EDGE,
  MAX_RETRO_VIDEO_SECONDS,
  RetroProcessingError,
} from '../src/capture/retro-browser';
import { readVideoMetadata, supportedMp4Type } from '../src/capture/platform';
import { drawRetroFrame } from '../src/capture/retro-looks';

jest.mock('../src/capture/platform', () => ({
  readVideoMetadata: jest.fn(),
  supportedMp4Type: jest.fn(),
}));
jest.mock('../src/capture/retro-looks', () => ({
  ...jest.requireActual('../src/capture/retro-looks'),
  drawRetroFrame: jest.fn(),
}));

const MP4 = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2';
const draw = drawRetroFrame as jest.Mock;
const supportedType = supportedMp4Type as jest.Mock;
const metadata = readVideoMetadata as jest.Mock;
const capturedAt = new Date(2026, 9, 4, 15, 7, 9);

const flush = async (rounds = 30) => {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
};

interface FakeContext {
  filter?: string;
  createImageData: (width: number, height: number) => { data: Uint8ClampedArray };
  putImageData: jest.Mock;
}

function makeContext(withFilter = true): FakeContext {
  const ctx: FakeContext = {
    createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: jest.fn(),
  };
  if (withFilter) ctx.filter = 'none';
  return ctx;
}

type Listener = () => void;

function makeVideo() {
  const listeners = new Map<string, Set<Listener>>();
  let currentTime = 0;
  const video = {
    readyState: 4,
    videoWidth: 1280,
    videoHeight: 720,
    style: {} as Record<string, string>,
    playsInline: false,
    preload: '',
    muted: true,
    src: '',
    seekStalls: false,
    play: jest.fn(() => Promise.resolve()),
    pause: jest.fn(),
    load: jest.fn(),
    remove: jest.fn(),
    setAttribute: jest.fn(),
    removeAttribute: jest.fn(),
    addEventListener: jest.fn((name: string, listener: Listener) => {
      listeners.set(name, (listeners.get(name) ?? new Set()).add(listener));
    }),
    removeEventListener: jest.fn((name: string, listener: Listener) => {
      listeners.get(name)?.delete(listener);
    }),
    dispatch(name: string) {
      [...(listeners.get(name) ?? [])].forEach((listener) => listener());
    },
    listenerCount: (name: string) => listeners.get(name)?.size ?? 0,
    setTime(value: number) {
      currentTime = value;
    },
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
      if (!video.seekStalls) void Promise.resolve().then(() => video.dispatch('seeked'));
    },
  };
  return video;
}

/** Fakes the browser surface that retro-browser touches, and restores it afterwards. */
function installBrowser() {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const define = (name: string, value: unknown) => {
    if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const remove = (name: string) => {
    if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Reflect.deleteProperty(globalThis, name);
  };

  const videoTrack = { kind: 'video', stop: jest.fn() };
  const audioTrack = { kind: 'audio', stop: jest.fn() };
  const audioSource = { connect: jest.fn(), disconnect: jest.fn() };
  const audioDestination = {
    stream: { getTracks: () => [audioTrack], getAudioTracks: () => [audioTrack] },
  };
  const env = {
    canvases: [] as FakeCanvas[],
    video: makeVideo(),
    documentListeners: new Map<string, Set<Listener>>(),
    hidden: false,
    contextFor: (_index: number): FakeContext | null => makeContext(),
    photoBlob: new Blob(['jpeg-bytes'], { type: 'image/jpeg' }) as Blob | null,
    imageSize: { width: 4000, height: 3000 },
    imageComplete: false,
    decode: () => Promise.resolve(),
    readerFails: false,
    recorder: null as FakeRecorder | null,
    startThrows: false,
    finalBytes: 'mp4-bytes' as string | null,
    recorderMimeType: MP4,
    videoTrack,
    audioTrack,
    captureStream: jest.fn(),
    frames: new Map<number, () => void>(),
    nextFrame: 1,
    audio: {
      resume: jest.fn(() => Promise.resolve()),
      close: jest.fn(() => Promise.resolve()),
      source: audioSource,
      destination: audioDestination,
      createMediaElementSource: jest.fn(() => audioSource),
      createMediaStreamDestination: jest.fn(() => audioDestination),
    },
    AudioContext: undefined as unknown as jest.Mock,
    runFrame() {
      const [id, callback] = [...env.frames.entries()][0] ?? [];
      if (id === undefined || !callback) throw new Error('no animation frame is pending');
      env.frames.delete(id);
      callback();
    },
    restore() {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };

  class FakeCanvas {
    width = 0;
    height = 0;
    context: FakeContext | null;
    constructor() {
      this.context = env.contextFor(env.canvases.length);
      env.canvases.push(this);
    }
    getContext() {
      return this.context;
    }
    toBlob(callback: (blob: Blob | null) => void) {
      callback(env.photoBlob);
    }
    captureStream(fps: number) {
      env.captureStream(fps);
      return {
        getVideoTracks: () => [videoTrack],
        getTracks: () => [videoTrack],
      };
    }
  }

  class FakeMediaStream {
    constructor(readonly tracks: unknown[]) {}
    getTracks() {
      return this.tracks;
    }
  }

  class FakeRecorder {
    static isTypeSupported = jest.fn(() => true);
    state = 'inactive';
    mimeType = env.recorderMimeType;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(
      readonly stream: FakeMediaStream,
      readonly options: Record<string, unknown>,
    ) {
      env.recorder = this;
    }
    start = jest.fn((_timeslice: number) => {
      if (env.startThrows) throw new Error('recorder refused');
      this.state = 'recording';
    });
    stop = jest.fn(() => {
      this.state = 'inactive';
      void Promise.resolve().then(() => {
        if (env.finalBytes !== null) this.ondataavailable?.({ data: new Blob([env.finalBytes]) });
        this.onstop?.();
      });
    });
  }

  class FakeImage {
    src = '';
    get naturalWidth() {
      return env.imageSize.width;
    }
    get naturalHeight() {
      return env.imageSize.height;
    }
    get complete() {
      return env.imageComplete;
    }
    decode() {
      return env.decode();
    }
  }

  class FakeFileReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(blob: Blob) {
      if (env.readerFails) {
        void Promise.resolve().then(() => this.onerror?.());
        return;
      }
      void blob.arrayBuffer().then((buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
        this.onload?.();
      });
    }
  }

  env.AudioContext = jest.fn(function AudioContext() {
    return env.audio;
  });

  define('document', {
    body: { appendChild: jest.fn() },
    createElement: jest.fn((tag: string) => (tag === 'video' ? env.video : new FakeCanvas())),
    addEventListener: jest.fn((name: string, listener: Listener) => {
      env.documentListeners.set(name, (env.documentListeners.get(name) ?? new Set()).add(listener));
    }),
    removeEventListener: jest.fn((name: string, listener: Listener) => {
      env.documentListeners.get(name)?.delete(listener);
    }),
    get hidden() {
      return env.hidden;
    },
  });
  define('HTMLCanvasElement', FakeCanvas);
  define('MediaStream', FakeMediaStream);
  define('MediaRecorder', FakeRecorder);
  define('AudioContext', env.AudioContext);
  remove('webkitAudioContext');
  define('Image', FakeImage);
  define('FileReader', FakeFileReader);
  define('requestAnimationFrame', (callback: () => void) => {
    const id = env.nextFrame++;
    env.frames.set(id, callback);
    return id;
  });
  define('cancelAnimationFrame', (id: number) => {
    env.frames.delete(id);
  });
  jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:retro-result');
  jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

  return { env, FakeCanvas, FakeRecorder, define, remove };
}

type Browser = ReturnType<typeof installBrowser>;
let browser: Browser;
let env: Browser['env'];

beforeEach(() => {
  supportedType.mockReturnValue(MP4);
  metadata.mockResolvedValue({ durationSeconds: 4.5 });
  browser = installBrowser();
  env = browser.env;
});

afterEach(() => {
  env.restore();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('applyRetroLookToPhoto', () => {
  const photo = (overrides: Partial<Parameters<typeof applyRetroLookToPhoto>[0]> = {}) =>
    applyRetroLookToPhoto({
      base64: 'AAAA',
      mimeType: 'image/jpeg',
      mode: 'ccd',
      capturedAt,
      seed: 'capture-1',
      ...overrides,
    });
  const frameArg = (call = 0) => draw.mock.calls[call][3];

  it('refuses to run where there is no DOM', async () => {
    Reflect.deleteProperty(globalThis, 'document');
    await expect(photo()).rejects.toThrow(RetroProcessingError);
    await expect(photo()).rejects.toThrow('cannot apply the retro look');
  });

  it('grades the photo on a capped canvas and returns the encoded JPEG', async () => {
    const result = await photo();

    expect(result).toEqual({
      base64: Buffer.from('jpeg-bytes').toString('base64'),
      mimeType: 'image/jpeg',
      width: MAX_RETRO_PHOTO_EDGE,
      height: 1620,
      byteLength: 10,
    });
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw.mock.calls[0][2]).toBe('ccd');
    expect(frameArg()).toMatchObject({
      width: MAX_RETRO_PHOTO_EDGE,
      height: 1620,
      time: 0,
      moving: false,
      capturedAt,
      supportsFilter: true,
      scratch: null,
    });
  });

  it('keeps small photos at their own size', async () => {
    env.imageSize = { width: 801, height: 601 };
    const result = await photo();
    expect(result).toMatchObject({ width: 800, height: 600 });
  });

  it('draws the image it decoded, not the raw bytes', async () => {
    await photo({ base64: 'QUJD', mimeType: 'image/png' });
    const image = draw.mock.calls[0][1] as { src: string };
    expect(image.src).toBe('data:image/png;base64,QUJD');
  });

  it('releases the canvas backing store after success', async () => {
    await photo();
    expect(env.canvases[0].width).toBe(0);
    expect(env.canvases[0].height).toBe(0);
  });

  it('gives VHS a scratch canvas for chroma fringes and releases it too', async () => {
    await photo({ mode: 'vhs' });

    expect(frameArg().scratch).toBe(env.canvases[1].context);
    expect(env.canvases[1].width).toBe(0);
    expect(env.canvases[0].width).toBe(0);
  });

  it('reports that ctx.filter is unavailable so the look can fall back to blend washes', async () => {
    env.contextFor = (index) => (index === 0 ? makeContext(false) : makeContext());
    await photo();
    expect(frameArg().supportsFilter).toBe(false);
  });

  it('is deterministic per seed so a retry sends identical bytes, and varies with seed or mode', async () => {
    const firstDraw = async (input: Parameters<typeof photo>[0]) => {
      draw.mockClear();
      await photo(input);
      return frameArg().random() as number;
    };
    const base = await firstDraw({ seed: 'a', mode: 'ccd' });
    expect(await firstDraw({ seed: 'a', mode: 'ccd' })).toBe(base);
    expect(await firstDraw({ seed: 'b', mode: 'ccd' })).not.toBe(base);
    expect(await firstDraw({ seed: 'a', mode: '8mm' })).not.toBe(base);
  });

  it('continues when decode() rejects but the browser already has the image', async () => {
    env.decode = () => Promise.reject(new Error('decode unsupported'));
    env.imageComplete = true;

    await expect(photo()).resolves.toMatchObject({ mimeType: 'image/jpeg' });
  });

  it('fails clearly when the image cannot be opened', async () => {
    env.decode = () => Promise.reject(new Error('corrupt'));
    env.imageSize = { width: 0, height: 0 };

    await expect(photo()).rejects.toThrow('could not be opened');
    expect(draw).not.toHaveBeenCalled();
  });

  it('fails and still releases canvases when the 2D context is unavailable', async () => {
    env.contextFor = () => null;

    await expect(photo()).rejects.toThrow('cannot draw the retro look');
    expect(env.canvases[0].width).toBe(0);
  });

  it.each([
    ['the encoder returns nothing', () => null],
    ['the encoded image is empty', () => new Blob([])],
  ])('fails when %s', async (_name, blob) => {
    env.photoBlob = blob();

    await expect(photo()).rejects.toThrow('could not be encoded');
    expect(env.canvases[0].width).toBe(0);
  });

  it('fails when the encoded photo cannot be read back', async () => {
    env.readerFails = true;

    await expect(photo()).rejects.toThrow('retro photo could not be read');
    expect(env.canvases[0].width).toBe(0);
  });
});

describe('canProcessRetroVideo', () => {
  it('is true when every browser capability is present', () => {
    expect(canProcessRetroVideo()).toBe(true);
  });

  it('accepts the prefixed webkitAudioContext used by older Safari', () => {
    browser.remove('AudioContext');
    expect(canProcessRetroVideo()).toBe(false);
    browser.define('webkitAudioContext', env.AudioContext);
    expect(canProcessRetroVideo()).toBe(true);
  });

  it.each([
    ['there is no document', () => browser.remove('document')],
    ['there is no canvas class', () => browser.remove('HTMLCanvasElement')],
    [
      'canvas cannot capture a stream',
      () =>
        Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
          configurable: true,
          value: undefined,
        }),
    ],
    ['MediaStream is missing', () => browser.remove('MediaStream')],
    ['Web Audio is missing', () => browser.remove('AudioContext')],
    ['MediaRecorder is missing', () => browser.remove('MediaRecorder')],
    [
      'MediaRecorder cannot test formats',
      () => browser.define('MediaRecorder', class NoSupportCheck {}),
    ],
    ['no MP4 recording type is supported', () => supportedType.mockReturnValue(null)],
  ])('is false when %s', (_name, breakIt) => {
    breakIt();
    expect(canProcessRetroVideo()).toBe(false);
  });
});

describe('applyRetroLookToVideo', () => {
  const baseInput = {
    sourceUri: 'blob:source-clip',
    startSeconds: 0,
    endSeconds: 5,
    mode: 'ccd' as CaptureMode,
    capturedAt,
  };

  /** Starts processing and lets it reach the point where recording is under way. */
  async function begin(
    input: Partial<typeof baseInput> = {},
    options: Parameters<typeof applyRetroLookToVideo>[1] = {},
  ) {
    const promise = applyRetroLookToVideo({ ...baseInput, ...input }, options);
    const outcome = promise.then(
      (value) => ({ value }),
      (error: RetroProcessingError) => ({ error }),
    );
    await flush();
    return { promise, outcome };
  }

  /** Plays the clip to its end frame and resolves. */
  async function playToEnd(end = 5) {
    env.video.setTime(end);
    env.runFrame();
    await flush();
  }

  /** `stage` says how far processing got: no canvas yet, canvas only, or a live capture stream. */
  function expectReleased(stage: 'opening' | 'canvas' | 'recording' = 'recording') {
    expect(env.audioTrack.stop).toHaveBeenCalled();
    expect(env.audio.source.disconnect).toHaveBeenCalled();
    expect(env.audio.close).toHaveBeenCalled();
    expect(env.video.pause).toHaveBeenCalled();
    expect(env.video.removeAttribute).toHaveBeenCalledWith('src');
    expect(env.video.load).toHaveBeenCalled();
    expect(env.video.remove).toHaveBeenCalled();
    if (stage === 'opening') {
      expect(env.canvases).toHaveLength(0);
      return;
    }
    expect(env.canvases[0].width).toBe(0);
    expect(env.canvases[0].height).toBe(0);
    if (stage === 'recording') expect(env.videoTrack.stop).toHaveBeenCalled();
  }

  it('rejects up front when the browser lacks a required capability', async () => {
    browser.remove('MediaRecorder');
    await expect(applyRetroLookToVideo(baseInput)).rejects.toThrow(
      'cannot apply the retro look to video',
    );
    expect(env.AudioContext).not.toHaveBeenCalled();
  });

  it('rejects up front when no MP4 type is supported', async () => {
    supportedType.mockReturnValue(null);
    await expect(applyRetroLookToVideo(baseInput)).rejects.toBeInstanceOf(RetroProcessingError);
    expect(env.AudioContext).not.toHaveBeenCalled();
  });

  it('rejects as cancelled, without creating any media, if already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await applyRetroLookToVideo(baseInput, { signal: controller.signal }).catch(
      (failure) => failure,
    );

    expect(error).toBeInstanceOf(RetroProcessingError);
    expect(error.cancelled).toBe(true);
    expect(env.AudioContext).not.toHaveBeenCalled();
    expect(env.video.play).not.toHaveBeenCalled();
  });

  it('records the playing clip with its audio and resolves with the verified MP4', async () => {
    const progress: number[] = [];
    const { promise } = await begin({}, { onProgress: (percent) => progress.push(percent) });

    // The element is prepared as a muted-to-speakers, offscreen, but attached decoder.
    expect(env.video.src).toBe('blob:source-clip');
    expect(env.video.muted).toBe(false);
    expect(env.video.playsInline).toBe(true);
    expect(env.video.setAttribute).toHaveBeenCalledWith('playsinline', '');
    expect(env.video.style).toMatchObject({
      opacity: '0',
      position: 'fixed',
      pointerEvents: 'none',
    });
    expect(document.body.appendChild).toHaveBeenCalledWith(env.video);
    expect(env.audio.source.connect).toHaveBeenCalledWith(env.audio.destination);

    // Recording starts from the canvas stream plus the routed audio track.
    expect(env.captureStream).toHaveBeenCalledWith(30);
    expect(env.recorder!.stream.tracks).toEqual([env.videoTrack, env.audioTrack]);
    expect(env.recorder!.options).toEqual({
      audioBitsPerSecond: 128_000,
      mimeType: MP4,
      videoBitsPerSecond: 8_000_000,
    });
    expect(env.recorder!.start).toHaveBeenCalledWith(250);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw.mock.calls[0][3]).toMatchObject({ time: 0, moving: true, scratch: null });
    expect(draw.mock.calls[0][2]).toBe('ccd');

    env.recorder!.ondataavailable!({ data: new Blob(['abc']) });
    env.recorder!.ondataavailable!({ data: new Blob([]) });
    env.video.setTime(1);
    env.runFrame();
    env.video.setTime(2.5);
    env.runFrame();
    expect(draw.mock.calls.at(-1)![3]).toMatchObject({ time: 2.5 });
    await playToEnd();

    await expect(promise).resolves.toEqual({
      sourceUri: 'blob:retro-result',
      byteLength: 3 + 'mp4-bytes'.length,
      durationSeconds: 4.5,
      width: 1280,
      height: 720,
    });
    // Progress is monotonic here and never reports completion before the file is ready.
    expect(progress).toEqual([20, 50, 99]);
    expect(env.recorder!.stop).toHaveBeenCalledTimes(1);
    expect(metadata).toHaveBeenCalledWith('blob:retro-result', undefined);
    expectReleased();
    // Result belongs to the caller: it must not be revoked.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('scales large sources down to 1080p-class output', async () => {
    env.video.videoWidth = 3840;
    env.video.videoHeight = 2160;
    const { promise } = await begin();
    await playToEnd();
    await expect(promise).resolves.toMatchObject({ width: 1920, height: 1080 });
  });

  it('seeks to the start of the trimmed segment and reports progress relative to it', async () => {
    const progress: number[] = [];
    const { promise } = await begin(
      { startSeconds: 2, endSeconds: 6 },
      { onProgress: (percent) => progress.push(percent) },
    );

    expect(env.video.currentTime).toBe(2);
    env.video.setTime(1.5); // a frame before the seek has settled
    env.runFrame();
    env.video.setTime(4);
    env.runFrame();
    await playToEnd(6);
    await promise;

    expect(draw.mock.calls[1][3].time).toBe(0); // negative elapsed is clamped
    expect(progress).toEqual([0, 50, 99]);
  });

  it('does not seek when the clip is already at the start', async () => {
    const seeks = jest.spyOn(env.video, 'dispatch');
    const { promise } = await begin({ startSeconds: 0.0005 });
    expect(seeks).not.toHaveBeenCalledWith('seeked');
    await playToEnd();
    await promise;
  });

  it('caps the recorded length just under the 15 second limit', async () => {
    const { promise } = await begin({ startSeconds: 1, endSeconds: 60 });

    env.video.setTime(1 + MAX_RETRO_VIDEO_SECONDS - 0.1);
    env.runFrame();
    expect(env.recorder!.stop).not.toHaveBeenCalled();
    await playToEnd(1 + MAX_RETRO_VIDEO_SECONDS);

    await expect(promise).resolves.toBeDefined();
    expect(env.recorder!.stop).toHaveBeenCalledTimes(1);
  });

  it('prepares a scratch canvas only for the VHS look', async () => {
    const vhs = await begin({ mode: 'vhs' });
    expect(draw.mock.calls[0][3].scratch).toBe(env.canvases[1].context);
    await playToEnd();
    await vhs.promise;
    expect(env.canvases[1].width).toBe(0);
  });

  it('finishes early when the video ends before the end frame is reached', async () => {
    const { promise } = await begin();
    env.video.dispatch('ended');
    env.video.dispatch('ended');
    await flush();

    await expect(promise).resolves.toMatchObject({ durationSeconds: 4.5 });
    expect(env.recorder!.stop).toHaveBeenCalledTimes(1);
    expect(env.frames.size).toBe(0);
  });

  it('stops listening to the document and video once settled', async () => {
    const { promise } = await begin();
    expect(env.documentListeners.get('visibilitychange')?.size).toBe(1);
    expect(env.video.listenerCount('ended')).toBe(1);
    await playToEnd();
    await promise;

    expect(env.documentListeners.get('visibilitychange')?.size).toBe(0);
    expect(env.video.listenerCount('ended')).toBe(0);
    expect(env.video.listenerCount('error')).toBe(0);
  });

  it('waits for metadata when the clip is not ready yet', async () => {
    env.video.readyState = 0;
    const { promise } = await begin();
    expect(env.recorder).toBeNull();

    env.video.dispatch('loadedmetadata');
    await flush();
    expect(env.recorder).not.toBeNull();
    await playToEnd();
    await expect(promise).resolves.toBeDefined();
  });

  it('fails with a clear message if the clip errors while opening', async () => {
    env.video.readyState = 0;
    const { outcome } = await begin();

    env.video.dispatch('error');

    expect(await outcome).toEqual({ error: expect.any(RetroProcessingError) });
    expect(((await outcome) as { error: Error }).error.message).toContain('could not be opened');
    expect(env.recorder).toBeNull();
    expectReleased('opening');
  });

  it('gives up if opening the clip stalls for 20 seconds', async () => {
    jest.useFakeTimers({ doNotFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    env.video.readyState = 0;
    const { outcome } = await begin();

    await jest.advanceTimersByTimeAsync(19_999);
    expect(env.video.remove).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    const { error } = (await outcome) as { error: RetroProcessingError };
    expect(error.message).toContain('could not be opened');
    expect(error.cancelled).toBe(false);
    expectReleased('opening');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('gives up if the seek to the start never completes', async () => {
    jest.useFakeTimers({ doNotFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    env.video.seekStalls = true;
    const { outcome } = await begin({ startSeconds: 3, endSeconds: 8 });

    await jest.advanceTimersByTimeAsync(20_000);

    expect(((await outcome) as { error: Error }).error.message).toContain('could not be opened');
    expect(env.recorder).toBeNull();
  });

  it('can be cancelled while the clip is still opening', async () => {
    env.video.readyState = 0;
    const controller = new AbortController();
    const { outcome } = await begin({}, { signal: controller.signal });

    controller.abort();

    const { error } = (await outcome) as { error: RetroProcessingError };
    expect(error.cancelled).toBe(true);
    expect(error.message).toContain('cancelled');
    expectReleased('opening');
  });

  it.each([
    ['too short', { startSeconds: 1, endSeconds: 1.4 }],
    ['inverted', { startSeconds: 5, endSeconds: 2 }],
    ['not a number', { startSeconds: 0, endSeconds: Number.NaN }],
  ])('rejects a clip range that is %s before recording anything', async (_name, range) => {
    const { outcome } = await begin(range);

    const { error } = (await outcome) as { error: RetroProcessingError };
    expect(error.message).toContain('at least half a second');
    expect(env.recorder).toBeNull();
    expectReleased('opening');
  });

  it('treats a negative start as the beginning of the clip', async () => {
    const { promise } = await begin({ startSeconds: -3, endSeconds: 2 });
    expect(draw.mock.calls[0][3].time).toBe(0);
    await playToEnd(2);
    await promise;
  });

  it('still records when the autoplay unlock is blocked or audio cannot resume', async () => {
    env.video.play.mockRejectedValueOnce(new Error('NotAllowedError'));
    env.audio.resume.mockRejectedValue(new Error('suspended'));
    const { promise } = await begin();

    await playToEnd();
    await expect(promise).resolves.toBeDefined();
  });

  it('survives audio nodes that refuse to disconnect or close during cleanup', async () => {
    env.audio.source.disconnect.mockImplementation(() => {
      throw new Error('already disconnected');
    });
    env.audio.close.mockRejectedValue(new Error('already closed'));
    const { promise } = await begin();

    await playToEnd();

    await expect(promise).resolves.toBeDefined();
    expect(env.video.remove).toHaveBeenCalled();
  });

  it('rejects, releasing everything, when no 2D context can be created for recording', async () => {
    env.contextFor = () => null;
    const { outcome } = await begin();

    expect(((await outcome) as { error: Error }).error.message).toContain('cannot draw');
    expect(env.recorder).toBeNull();
    expectReleased('canvas');
  });

  it('fails if the browser cannot start the recorder', async () => {
    env.startThrows = true;
    const { outcome } = await begin();

    const { error } = (await outcome) as { error: Error };
    expect(error.message).toContain('could not start recording');
    expect(env.video.play).toHaveBeenCalledTimes(1); // only the unlock play happened
    expect(env.frames.size).toBe(0);
    expectReleased();
  });

  it('fails with a retry hint when playback is refused after recording started', async () => {
    env.video.play.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('blocked'));
    const { outcome } = await begin();

    const { error } = (await outcome) as { error: Error };
    expect(error.message).toContain('Tap Upload again');
    expect(env.recorder!.stop).toHaveBeenCalled();
    expectReleased();
  });

  it('cancels mid-recording: stops the recorder and never produces a result', async () => {
    const controller = new AbortController();
    const { outcome } = await begin({}, { signal: controller.signal });
    env.recorder!.stop.mockClear();

    controller.abort();
    await flush();

    const { error } = (await outcome) as { error: RetroProcessingError };
    expect(error.cancelled).toBe(true);
    expect(env.recorder!.stop).toHaveBeenCalledTimes(1);
    expect(env.recorder!.onstop).toBeNull();
    expect(metadata).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(env.frames.size).toBe(0);
    expectReleased();
  });

  it('fails if the user leaves the page while recording', async () => {
    const { outcome } = await begin();

    env.hidden = false;
    env.documentListeners.get('visibilitychange')!.forEach((listener) => listener());
    await flush();
    expect(env.recorder!.stop).not.toHaveBeenCalled(); // still visible: keep going

    env.hidden = true;
    env.documentListeners.get('visibilitychange')!.forEach((listener) => listener());

    const { error } = (await outcome) as { error: Error };
    expect(error.message).toContain('Keep Rewind open');
    expect(env.recorder!.stop).toHaveBeenCalled();
    expectReleased();
  });

  it('fails if the clip hits a playback error while recording', async () => {
    const { outcome } = await begin();

    env.video.dispatch('error');

    expect(((await outcome) as { error: Error }).error.message).toContain('could not be played');
    expectReleased();
  });

  it('fails if the recorder reports an error, ignoring later events', async () => {
    const { outcome } = await begin();

    env.recorder!.onerror!();
    env.video.dispatch('ended');
    await flush();

    expect(((await outcome) as { error: Error }).error.message).toContain('could not record');
    expect(env.recorder!.stop).toHaveBeenCalledTimes(1);
  });

  it('does not stop a recorder that has already stopped itself', async () => {
    const { outcome } = await begin();
    env.recorder!.state = 'inactive';

    env.recorder!.onerror!();

    await outcome;
    expect(env.recorder!.stop).not.toHaveBeenCalled();
  });

  it('tolerates a recorder that throws on stop while failing', async () => {
    const { outcome } = await begin();
    env.recorder!.stop.mockImplementation(() => {
      throw new Error('InvalidStateError');
    });

    env.recorder!.onerror!();

    expect(((await outcome) as { error: Error }).error.message).toContain('could not record');
    expectReleased();
  });

  it('times out when frames never reach the end of the clip', async () => {
    jest.useFakeTimers({ doNotFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const { outcome } = await begin({ startSeconds: 0, endSeconds: 2 });

    await jest.advanceTimersByTimeAsync(2 * 3000 + 15_000 - 1);
    expect(env.recorder!.stop).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    expect(((await outcome) as { error: Error }).error.message).toContain('took too long');
    expect(env.recorder!.stop).toHaveBeenCalled();
    expect(env.frames.size).toBe(0);
    expectReleased();
  });

  it.each([
    ['nothing was recorded', null, MP4],
    ['the browser produced WebM instead of MP4', 'webm-bytes', 'video/webm'],
  ])('rejects when %s', async (_name, bytes, mimeType) => {
    env.finalBytes = bytes;
    env.recorderMimeType = mimeType;
    const { outcome } = await begin();
    env.recorder!.mimeType = mimeType;
    await playToEnd();

    expect(((await outcome) as { error: Error }).error.message).toContain('usable retro MP4');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expectReleased();
  });

  it('falls back to the negotiated type when the recorder reports no mimeType', async () => {
    const { promise } = await begin();
    env.recorder!.mimeType = '';
    await playToEnd();
    await expect(promise).resolves.toMatchObject({ sourceUri: 'blob:retro-result' });
  });

  it('revokes the result URL and fails when the recorded clip cannot be verified', async () => {
    metadata.mockRejectedValue(new Error('unreadable'));
    const { outcome } = await begin();
    await playToEnd();

    expect(((await outcome) as { error: Error }).error.message).toContain('could not be verified');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:retro-result');
    expectReleased();
  });

  it('passes the abort signal to metadata verification', async () => {
    const controller = new AbortController();
    const { promise } = await begin({}, { signal: controller.signal });
    await playToEnd();
    await promise;
    expect(metadata).toHaveBeenCalledWith('blob:retro-result', controller.signal);
  });
});

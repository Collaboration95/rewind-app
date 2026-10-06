import { readVideoMetadata, VIDEO_METADATA_TIMEOUT_MS } from '../src/capture/platform';

// Drive the actual metadata adapter with a stalled/streaming browser decoder.
function metadataVideo(duration = 2) {
  return {
    duration,
    videoHeight: 1280,
    videoWidth: 720,
    currentTime: 0,
    audioTracks: { length: 1 },
    src: '',
    preload: '',
    onloadedmetadata: null as (() => void) | null,
    ondurationchange: null as (() => void) | null,
    ontimeupdate: null as (() => void) | null,
    onerror: null as (() => void) | null,
    pause: jest.fn(),
    removeAttribute: jest.fn(),
    load: jest.fn(),
  };
}

describe('bounded video metadata', () => {
  const originalDocument = globalThis.document;
  afterEach(() => {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    jest.useRealTimers();
  });
  function install(video: ReturnType<typeof metadataVideo>) {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: jest.fn(() => video) },
    });
  }
  function expectReleased(video: ReturnType<typeof metadataVideo>) {
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(video.removeAttribute).toHaveBeenCalledWith('src');
    expect(video.load).toHaveBeenCalledTimes(1);
    expect(video.onloadedmetadata).toBeNull();
    expect(video.onerror).toBeNull();
    expect(video.ontimeupdate).toBeNull();
    expect(video.ondurationchange).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  }
  it('rejects a decoder that never emits metadata after ten seconds and releases it', async () => {
    jest.useFakeTimers();
    const video = metadataVideo();
    install(video);
    const pending = readVideoMetadata('blob:stalled');
    const rejected = expect(pending).rejects.toThrow(
      "This video couldn't be read. Try recording again.",
    );
    await jest.advanceTimersByTimeAsync(VIDEO_METADATA_TIMEOUT_MS);
    await rejected;
    expectReleased(video);
  });
  it('recovers an Infinity duration by seeking to the end without retaining the decoder', async () => {
    jest.useFakeTimers();
    const video = metadataVideo(Infinity);
    install(video);
    const pending = readVideoMetadata('blob:streaming');
    video.onloadedmetadata!();
    expect(video.currentTime).toBe(1e101);
    video.duration = 2.5;
    video.ondurationchange!();
    await expect(pending).resolves.toEqual({
      durationSeconds: 2.5,
      height: 1280,
      width: 720,
      hasAudio: true,
    });
    expectReleased(video);
  });
  it('treats an empty WebKit audioTracks list at loadedmetadata as unknown audio', async () => {
    const video = { ...metadataVideo(), audioTracks: { length: 0 } };
    install(video);
    const pending = readVideoMetadata('blob:webkit');
    video.onloadedmetadata!();
    await expect(pending).resolves.toEqual({
      durationSeconds: 2,
      height: 1280,
      width: 720,
      hasAudio: null,
    });
  });
  it.each(['error', 'abort', 'bad duration', 'Infinity timeout'])(
    'cleans up after %s',
    async (reason) => {
      jest.useFakeTimers();
      const video = metadataVideo(
        reason === 'Infinity timeout' ? Infinity : reason === 'bad duration' ? 0 : 2,
      );
      install(video);
      const controller = new AbortController();
      const pending = readVideoMetadata('blob:bad', controller.signal);
      const rejected = expect(pending).rejects.toThrow(
        "This video couldn't be read. Try recording again.",
      );
      if (reason === 'error') video.onerror!();
      else if (reason === 'abort') controller.abort();
      else video.onloadedmetadata!();
      if (reason === 'Infinity timeout')
        await jest.advanceTimersByTimeAsync(VIDEO_METADATA_TIMEOUT_MS);
      await rejected;
      expectReleased(video);
    },
  );
});

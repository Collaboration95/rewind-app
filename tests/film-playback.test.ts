import { createFilmPlayback } from '../src/real/film-playback';

class FilmMedia {
  src = '';
  readyState = 0;
  paused = true;
  error: unknown = null;
  readonly listeners = new Map<string, Set<() => void>>();
  play = jest.fn((): Promise<void> => {
    this.paused = false;
    return Promise.resolve();
  });
  pause = jest.fn(() => {
    this.paused = true;
  });
  load = jest.fn();
  addEventListener(event: string, callback: () => void) {
    const callbacks = this.listeners.get(event) ?? new Set();
    callbacks.add(callback);
    this.listeners.set(event, callbacks);
  }
  removeEventListener(event: string, callback: () => void) {
    this.listeners.get(event)?.delete(callback);
  }
  emit(event: string) {
    for (const callback of this.listeners.get(event) ?? []) callback();
  }
}

function fixture() {
  const media = new FilmMedia();
  const player = { replaceAsync: jest.fn(async () => {}), play: jest.fn(), pause: jest.fn() };
  const blocked = jest.fn();
  const error = jest.fn();
  const playback = createFilmPlayback(player);
  playback.connect(() => media as unknown as HTMLVideoElement, blocked, error);
  return { media, player, blocked, error, playback };
}

it('loads without playing, autoplays once ready, and never restarts after pause', async () => {
  const { playback, media, player } = fixture();
  await playback.replaceAsync('/film.mp4');
  expect(media.src).toBe('/film.mp4');
  expect(media.load).toHaveBeenCalledTimes(1);
  expect(player.replaceAsync).not.toHaveBeenCalled();
  playback.play();
  playback.play();
  expect(media.play).not.toHaveBeenCalled();
  media.readyState = 4;
  media.emit('canplay');
  media.emit('canplay');
  expect(media.play).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  playback.pause();
  media.emit('canplay');
  expect(media.paused).toBe(true);
  expect(media.play).toHaveBeenCalledTimes(1);
});

it.each(['pause', 'dispose'] as const)('%s cancels playback queued during load', async (action) => {
  const { playback, media } = fixture();
  await playback.replaceAsync('/film.mp4');
  playback.play();
  playback[action]();
  media.readyState = 4;
  media.emit('canplay');
  expect(media.play).not.toHaveBeenCalled();
  expect(media.listeners.get('canplay')?.size).toBe(0);
  expect(media.listeners.get('error')?.size).toBe(0);
});

it.each(['pause', 'dispose', 'replace'] as const)(
  'observes a pending play promise aborted by %s',
  async (action) => {
    const { playback, media, blocked, error } = fixture();
    let reject!: (error: unknown) => void;
    media.readyState = 4;
    media.play.mockImplementationOnce(() => new Promise((_, fail) => (reject = fail)));
    playback.play();
    if (action === 'replace') await playback.replaceAsync('/replay.mp4');
    else playback[action]();
    reject({ name: 'AbortError' });
    await Promise.resolve();
    expect(blocked).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  },
);

it('offers a retry when autoplay is denied and reports other play failures', async () => {
  const { playback, media, blocked, error } = fixture();
  media.readyState = 4;
  media.play.mockRejectedValueOnce({ name: 'NotAllowedError' });
  playback.play();
  await Promise.resolve();
  expect(blocked).toHaveBeenCalledTimes(1);
  const failure = { name: 'NotSupportedError' };
  media.play.mockRejectedValueOnce(failure);
  playback.play();
  await Promise.resolve();
  expect(media.play).toHaveBeenCalledTimes(2);
  expect(error).toHaveBeenCalledWith(failure);
});

it('does not hide an AbortError without a Film cancellation or a media load error', async () => {
  const { playback, media, error } = fixture();
  media.readyState = 4;
  const abort = { name: 'AbortError' };
  media.play.mockRejectedValueOnce(abort);
  playback.play();
  await Promise.resolve();
  expect(error).toHaveBeenCalledWith(abort);
  media.readyState = 0;
  playback.play();
  media.error = { message: 'Could not decode film' };
  media.emit('error');
  expect(error).toHaveBeenCalledWith(media.error);
  expect(media.listeners.get('canplay')?.size).toBe(0);
});

it('keeps native replace, play and pause on Expo and leaves release to its hook', async () => {
  const player = { replaceAsync: jest.fn(async () => {}), play: jest.fn(), pause: jest.fn() };
  const playback = createFilmPlayback(player);
  await playback.replaceAsync('/film.mp4');
  playback.play();
  playback.pause();
  playback.dispose();
  expect(player.replaceAsync).toHaveBeenCalledWith('/film.mp4');
  expect(player.play).toHaveBeenCalledTimes(1);
  expect(player.pause).toHaveBeenCalledTimes(1);
});

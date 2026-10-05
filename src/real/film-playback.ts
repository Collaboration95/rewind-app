type FilmPlayer = {
  replaceAsync(source: string): Promise<void>;
  play(): void;
  pause(): void;
};

/** Film owns one VideoView. Use its documented nativeRef on web: Expo's
 * replaceAsync starts playback during load and discards the play promise. */
export function createFilmPlayback(player: FilmPlayer) {
  let getWebVideo: (() => HTMLVideoElement | null) | undefined;
  let onBlocked = () => {};
  let onError = (_error: unknown) => {};
  let video: HTMLVideoElement | null = null;
  let generation = 0;
  let cancelReady: (() => void) | undefined;
  let pending = false;

  const pause = () => {
    generation += 1;
    cancelReady?.();
    cancelReady = undefined;
    pending = false;
    if (getWebVideo) video?.pause();
    else player.pause();
  };

  const play = () => {
    if (!getWebVideo) {
      player.play();
      return;
    }
    video = getWebVideo() ?? video;
    const media = video;
    if (!media || pending) return;
    pending = true;
    const request = ++generation;
    const failed = (error: unknown) => {
      const name = (error as { name?: string } | null)?.name;
      if (name === 'AbortError' && request !== generation) return;
      if (request === generation) pending = false;
      if (name === 'NotAllowedError') {
        if (request === generation) onBlocked();
      } else onError(error);
    };
    const start = () => {
      cancelReady?.();
      cancelReady = undefined;
      if (request !== generation) return;
      // Observe the promise immediately, including pause/load/unmount aborts.
      void media.play().then(() => {
        if (request === generation) pending = false;
      }, failed);
    };
    if (media.readyState >= 3) start();
    else {
      const loadError = () => {
        cancelReady?.();
        cancelReady = undefined;
        failed(media.error);
      };
      media.addEventListener('canplay', start);
      media.addEventListener('error', loadError);
      cancelReady = () => {
        media.removeEventListener('canplay', start);
        media.removeEventListener('error', loadError);
      };
    }
  };

  return {
    connect(
      getVideo: (() => HTMLVideoElement | null) | undefined,
      blocked: () => void,
      error: (error: unknown) => void,
    ) {
      getWebVideo = getVideo;
      onBlocked = blocked;
      onError = error;
    },
    async replaceAsync(source: string) {
      if (!getWebVideo) return player.replaceAsync(source);
      video = getWebVideo();
      if (!video) throw new Error('The film video is not mounted.');
      pause();
      // Leave Expo's declarative source null, so a React render cannot reload
      // the source after our request to play. Player events/seek still use this view.
      video.src = source;
      video.load();
    },
    play,
    pause,
    dispose() {
      // Native useVideoPlayer releases its own player. Web needs to cancel
      // readiness callbacks and pause the element even after its ref is detached.
      if (getWebVideo) pause();
    },
  };
}

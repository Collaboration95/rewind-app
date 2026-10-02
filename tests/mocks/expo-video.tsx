import type { ComponentProps } from 'react';
import { useEffect, useMemo, useRef } from 'react';
import { View } from 'react-native';
import type { VideoPlayer, VideoSource } from 'expo-video';

type MockListener = (payload: Record<string, unknown>) => void;

type MockVideoViewProps = ComponentProps<typeof View> & {
  nativeControls?: boolean;
  player?: VideoPlayer | null;
  testID?: string;
};

export class MockVideoPlayer {
  readonly source: VideoSource;
  loop = false;
  muted = false;
  timeUpdateEventInterval = 0;
  currentTime = 0;
  playing = false;
  released = false;
  private readonly listeners = new Map<string, Set<MockListener>>();

  constructor(source: VideoSource) {
    this.source = source;
  }

  addListener(event: string, listener: MockListener) {
    const listeners = this.listeners.get(event) ?? new Set<MockListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return { remove: () => listeners.delete(listener) };
  }

  emit(event: string, payload: Record<string, unknown> = {}) {
    if (event === 'timeUpdate' && typeof payload.currentTime === 'number') {
      this.currentTime = payload.currentTime;
    }
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  play() {
    this.playing = true;
    this.emit('playingChange', { isPlaying: true });
  }

  pause() {
    this.playing = false;
    this.emit('playingChange', { isPlaying: false });
  }

  seekBy(seconds: number) {
    this.currentTime += seconds;
    this.emit('timeUpdate', { currentTime: this.currentTime });
  }

  release() {
    this.released = true;
  }
}

const players: MockVideoPlayer[] = [];

export function getLatestMockVideoPlayer(): MockVideoPlayer | null {
  return players.length === 0 ? null : players[players.length - 1];
}

export function resetMockVideoPlayers(): void {
  players.length = 0;
}

/** Native playback is exercised on-device; Jest only needs an inspectable view. */
export function VideoView({
  nativeControls: _nativeControls,
  player: _player,
  testID,
  ...props
}: MockVideoViewProps) {
  return <View {...props} testID={testID} />;
}

export function useVideoPlayer(
  source: VideoSource,
  setup?: (player: VideoPlayer) => void,
): VideoPlayer {
  const setupRef = useRef(setup);
  const player = useMemo(() => {
    return new MockVideoPlayer(source);
  }, [source]);
  useEffect(() => {
    setupRef.current?.(player as unknown as VideoPlayer);
    players.push(player);
    return () => player.release();
  }, [player]);
  return player as unknown as VideoPlayer;
}

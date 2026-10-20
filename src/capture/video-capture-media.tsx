import { createElement, useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';

import type { CaptureMode, RecordedClip } from '../domain/video';
import { IconButton } from '../ui/primitives';
import { Notice } from './camera-ui';
import { LookPreview } from './LookPreview';
import { clampTrimmedPlaybackTime } from './video-review';
import { styles } from './video-capture-styles';

export function CapturedVideoReview({
  clip,
  endSeconds,
  mode,
  panelHeight,
  onMounted,
  onUnmounted,
  startSeconds,
}: {
  clip: RecordedClip;
  endSeconds: number;
  mode: CaptureMode;
  panelHeight: number;
  onMounted: () => void;
  onUnmounted: () => void;
  startSeconds: number;
}) {
  const player = useVideoPlayer(clip.sourceUri, (instance) => {
    instance.loop = false;
    instance.muted = false;
    instance.timeUpdateEventInterval = 0.1;
  });
  const [currentTime, setCurrentTime] = useState(startSeconds);
  const [playing, setPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  useEffect(() => {
    onMounted();
    return onUnmounted;
  }, [onMounted, onUnmounted]);

  useEffect(() => {
    player.pause();
    player.seekBy(startSeconds - player.currentTime);
  }, [endSeconds, player, startSeconds]);

  useEffect(() => {
    const timeSubscription = player.addListener('timeUpdate', ({ currentTime: time }) => {
      const boundedTime = clampTrimmedPlaybackTime(time, startSeconds, endSeconds);
      if (time >= endSeconds) {
        if (time > endSeconds) player.seekBy(endSeconds - time);
        player.pause();
        setPlaying(false);
      }
      setCurrentTime(boundedTime);
    });
    const playingSubscription = player.addListener('playingChange', ({ isPlaying }) => {
      setPlaying(isPlaying);
    });
    const statusSubscription = player.addListener('statusChange', ({ status }) => {
      if (status === 'error') {
        setPlaybackError(
          'This captured video could not be played. Retake it to record another clip.',
        );
      }
    });
    const endSubscription = player.addListener('playToEnd', () => {
      player.pause();
      setPlaying(false);
      setCurrentTime(endSeconds);
    });
    return () => {
      timeSubscription.remove();
      playingSubscription.remove();
      statusSubscription.remove();
      endSubscription.remove();
    };
  }, [endSeconds, player, startSeconds]);

  const seek = (deltaSeconds: number) => {
    const target = clampTrimmedPlaybackTime(
      player.currentTime + deltaSeconds,
      startSeconds,
      endSeconds,
    );
    player.seekBy(target - player.currentTime);
    setCurrentTime(target);
    if (target >= endSeconds && playing) {
      player.pause();
      setPlaying(false);
    }
  };

  const togglePlayback = () => {
    if (playing) {
      player.pause();
      setPlaying(false);
      return;
    }
    if (player.currentTime < startSeconds || player.currentTime >= endSeconds) {
      player.seekBy(startSeconds - player.currentTime);
      setCurrentTime(startSeconds);
    }
    setPlaybackError(null);
    player.play();
    setPlaying(true);
  };

  return (
    <View pointerEvents="box-none" style={[styles.playerArea, { bottom: panelHeight + 8 }]}>
      <View
        style={
          clip.width > clip.height
            ? [styles.landscapeMedia, { aspectRatio: clip.width / clip.height }]
            : styles.portraitMedia
        }
      >
        <LookPreview fit="contain" mode={mode} testID="video-review-look">
          <VideoView
            accessible
            accessibilityLabel="Captured video preview with audio"
            contentFit="contain"
            nativeControls={false}
            player={player}
            playsInline
            style={styles.fillVideo}
            testID="video-review-player"
          />
        </LookPreview>
      </View>
      <View
        pointerEvents="box-none"
        style={[styles.playLayer, clip.width < clip.height && styles.portraitPlayback]}
        testID="video-review-playback"
      >
        <View style={styles.playRow}>
          <IconButton dark icon="back" label="Back 5 seconds" onPress={() => seek(-5)} size={44} />
          <IconButton
            dark
            filled
            icon={playing ? 'pause' : 'play'}
            label={playing ? 'Pause preview' : 'Play preview'}
            onPress={togglePlayback}
            size={72}
            testID="video-review-playback-toggle"
          />
          <IconButton
            dark
            icon="forward"
            label="Forward 5 seconds"
            onPress={() => seek(5)}
            size={44}
          />
        </View>
        <Text style={styles.playbackTime} testID="video-review-time">
          {currentTime.toFixed(1)} / {endSeconds.toFixed(1)} seconds
        </Text>
        {playbackError ? <Notice>{playbackError}</Notice> : null}
      </View>
    </View>
  );
}

export function BrowserVideoPreview({
  fit,
  onAspect,
  stream,
}: {
  fit: 'cover' | 'contain';
  onAspect?: (aspect: number) => void;
  stream: MediaStream | null;
}) {
  const setPreviewRef = useCallback(
    (video: HTMLVideoElement | null) => {
      if (!video) return;
      video.srcObject = stream;
      // Frame size changes when the phone rotates.
      const measure = () => {
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          onAspect?.(video.videoWidth / video.videoHeight);
        }
      };
      video.onloadedmetadata = measure;
      video.onresize = measure;
    },
    [onAspect, stream],
  );
  return createElement('video', {
    'aria-label': 'Live camera preview',
    autoPlay: true,
    'data-testid': 'video-live-preview',
    muted: true,
    playsInline: true,
    ref: setPreviewRef,
    style: {
      backgroundColor: 'transparent',
      height: '100%',
      objectFit: fit,
      width: '100%',
    },
  });
}

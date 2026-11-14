import { useCallback, useEffect, useState } from 'react';

import { MAX_CLIP_DURATION_SECONDS, type RecordedClip } from '../domain/video';
import { userMessage } from '../domain/user-message';
import type { CameraPlatform } from './contracts';
import { isCaptureCancelled, removeManagedRecordedClip } from './platform';
import { ClipReviewSession } from './video-review';
import { validateRecordedClip } from './video-recording';
import type { BoundedVideoRecordingSession } from './video-recording';
import type { AccessStatus } from './video-capture-helpers';
import type { useCaptureLifecycle } from './useCaptureLifecycle';
import type { useClipReviewState } from './useClipReviewState';

export interface VideoRecordingFlowOptions {
  platform: CameraPlatform;
  recorder: BoundedVideoRecordingSession | null;
  access: AccessStatus;
  clipLimit: number;
  reviewState: ReturnType<typeof useClipReviewState>;
  lifecycle: ReturnType<typeof useCaptureLifecycle>;
  setBrowserPreviewStream: (stream: MediaStream | null) => void;
  setError: (message: string | null) => void;
}

/**
 * Getting a clip into review: the recording timer, start and stop, choosing a
 * file, and swapping the previous clip for the new one.
 */
export function useVideoRecordingFlow({
  platform,
  recorder,
  access,
  clipLimit,
  reviewState,
  lifecycle,
  setBrowserPreviewStream,
  setError,
}: VideoRecordingFlowOptions) {
  const { mode, reviewStore, setClip, setReview, setTrimEnd, setTrimStart } = reviewState;
  const {
    clipRef,
    isCaptureActive,
    releaseOwnedClip,
    reviewRef,
    setReviewPlayerVisible,
    unmountReviewPlayer,
  } = lifecycle;
  const [recording, setRecording] = useState(false);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const replaceClip = useCallback(
    async (selected: RecordedClip): Promise<boolean> => {
      try {
        validateRecordedClip(selected);
      } catch (validationError) {
        await removeManagedRecordedClip(selected.sourceUri).catch(() => undefined);
        throw validationError;
      }
      if (!isCaptureActive()) {
        await removeManagedRecordedClip(selected.sourceUri);
        return false;
      }

      const previousClip = clipRef.current;
      try {
        if (previousClip) await unmountReviewPlayer();
        await reviewRef.current?.retake();
        if (previousClip && previousClip.sourceUri !== selected.sourceUri) {
          await releaseOwnedClip(previousClip);
        }
      } catch (cleanupError) {
        if (previousClip) {
          clipRef.current = previousClip;
          setReviewPlayerVisible(true);
        }
        await removeManagedRecordedClip(selected.sourceUri).catch(() => undefined);
        throw cleanupError;
      }
      if (!isCaptureActive()) {
        await removeManagedRecordedClip(selected.sourceUri);
        return false;
      }

      const nextReview = new ClipReviewSession(selected, reviewStore);
      clipRef.current = selected;
      reviewRef.current = nextReview;
      setClip(selected);
      setReview(nextReview);
      setReviewPlayerVisible(true);
      setTrimStart(0);
      setTrimEnd(selected.durationSeconds);
      nextReview.setMode(mode);
      return true;
    },
    [
      clipRef,
      isCaptureActive,
      mode,
      releaseOwnedClip,
      reviewRef,
      reviewStore,
      setClip,
      setReview,
      setReviewPlayerVisible,
      setTrimEnd,
      setTrimStart,
      unmountReviewPlayer,
    ],
  );

  useEffect(() => {
    if (!recording || recordingStartedAt === null || !recorder) return undefined;
    const interval = setInterval(() => {
      const elapsed = Math.min(15, (Date.now() - recordingStartedAt) / 1000);
      recorder.setElapsed(elapsed);
      setElapsedSeconds(elapsed);
      // The platform stops by itself at 15 s; a smaller weekly limit stops here.
      if (clipLimit < MAX_CLIP_DURATION_SECONDS && elapsed >= clipLimit) recorder.stop();
    }, 250);
    return () => clearInterval(interval);
  }, [clipLimit, recording, recordingStartedAt, recorder]);

  const startRecording = async () => {
    if (!isCaptureActive() || !recorder || access !== 'ready') return;
    setError(null);
    setRecording(true);
    setRecordingStartedAt(Date.now());
    setElapsedSeconds(0);
    try {
      const recorded = await recorder.start();
      setBrowserPreviewStream(platform.getVideoPreviewStream?.() ?? null);
      if (!(await replaceClip(recorded))) return;
      setRecording(false);
      setRecordingStartedAt(null);
    } catch (recordingError) {
      setBrowserPreviewStream(platform.getVideoPreviewStream?.() ?? null);
      if (!isCaptureActive() || recorder.getState().status === 'cancelled') return;
      setRecording(false);
      setRecordingStartedAt(null);
      setError(userMessage(recordingError, 'The clip could not be recorded.'));
    }
  };

  const chooseVideoFile = async () => {
    if (!isCaptureActive() || !platform.pickVideoFile) return;
    setError(null);
    try {
      const selected = await platform.pickVideoFile();
      await replaceClip(selected);
    } catch (fileError) {
      if (!isCaptureActive() || isCaptureCancelled(fileError)) return;
      setError(userMessage(fileError, 'The video file could not be used.'));
    }
  };

  // Backgrounding drops a recording in progress.
  const resetRecording = useCallback(() => {
    setRecording(false);
    setRecordingStartedAt(null);
    setElapsedSeconds(0);
  }, []);

  return { chooseVideoFile, elapsedSeconds, recording, resetRecording, startRecording };
}

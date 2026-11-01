import { useEffect } from 'react';
import { AppState } from 'react-native';

import {
  EXHAUSTED_UPLOAD_MESSAGE,
  INTERRUPTED_UPLOAD_MESSAGE,
  decideInterruption,
} from './capture-interruption';
import type { CameraPlatform } from './contracts';
import type { ClipUploadProgress } from './clip-uploader';
import type { useCaptureLifecycle } from './useCaptureLifecycle';

export interface AppStateInterruptionOptions {
  platform: CameraPlatform;
  lifecycle: ReturnType<typeof useCaptureLifecycle>;
  refresh: () => Promise<void>;
  resetRecording: () => void;
  setBrowserPreviewStream: (stream: MediaStream | null) => void;
  setUploadProgress: (progress: ClipUploadProgress) => void;
}

/** Foreground and background handling for the video screen. */
export function useAppStateInterruption({
  platform,
  lifecycle,
  refresh,
  resetRecording,
  setBrowserPreviewStream,
  setUploadProgress,
}: AppStateInterruptionOptions) {
  const {
    activeUploadRef,
    contributionWorkRef,
    invalidateContributionWork,
    reconcileInterruptedUpload,
    recorderRef,
    reviewRef,
    setContributionStatus,
    uploadSessionRef,
  } = lifecycle;
  // Native Settings does not tell the route when the user changes a
  // permission, so re-check on foreground. Backgrounding is an interruption:
  // a recording cannot continue while suspended, and an in-flight upload has
  // lost its transport. Both are resolved explicitly instead of being left to
  // resolve themselves, and the local clip is kept for a bounded retry.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void refresh();
        reconcileInterruptedUpload();
        return;
      }
      if (nextState === 'background' || nextState === 'inactive') {
        platform.releaseVideoCapture?.();
        setBrowserPreviewStream(null);
        const decision = decideInterruption('background');
        if (decision.cancelRecording && recorderRef.current?.getState().status === 'recording') {
          recorderRef.current.cancel();
          resetRecording();
        }
        const interruptedUpload = activeUploadRef.current;
        if (contributionWorkRef.current) invalidateContributionWork();
        if (decision.cancelUploadRequest && interruptedUpload) {
          void uploadSessionRef.current?.cancel().catch(() => undefined);
          setUploadProgress({ status: 'cancelled', percent: 0 });
          if (decision.retainLocalCaptureForRetry) {
            const retryable = uploadSessionRef.current?.canRetry() ?? false;
            setContributionStatus({
              createdAt: new Date().toISOString(),
              durationSeconds: reviewRef.current?.getReview().endSeconds,
              message: retryable ? INTERRUPTED_UPLOAD_MESSAGE : EXHAUSTED_UPLOAD_MESSAGE,
              retryable,
              state: 'failed',
            });
          }
        }
      }
    });
    return () => subscription.remove();
  }, [
    activeUploadRef,
    contributionWorkRef,
    invalidateContributionWork,
    platform,
    reconcileInterruptedUpload,
    recorderRef,
    refresh,
    resetRecording,
    reviewRef,
    setBrowserPreviewStream,
    setContributionStatus,
    setUploadProgress,
    uploadSessionRef,
  ]);
}

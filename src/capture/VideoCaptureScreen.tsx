import { useCallback, useRef, useState } from 'react';
import { useAllowLandscape } from '../runtime/PortraitGuard';
import { CameraView } from 'expo-camera';
import { Platform, StyleSheet, useWindowDimensions } from 'react-native';

import type { RuntimeClient } from '../runtime/local-runtime-client';
import type { AuthenticatedRequest } from './real-account-video-runtime';
import { MAX_CLIP_DURATION_SECONDS } from '../domain/video';
import { LookPreview } from './LookPreview';
import type { ContributionLedgerAllowance } from '../domain/contributions';
import type { CameraPlatform } from './contracts';
import { Button, Dialog, useToast } from '../ui/primitives';
import { CamTop, CameraFrame, MomentsDialog, SealedOverlay, allowanceLeft } from './camera-ui';
import { VideoAccessCard } from './VideoAccessCard';
import { RecordingTimer, VideoCaptureControls } from './VideoCaptureControls';
import { VideoReviewLayer } from './VideoReviewLayer';
import { useAppStateInterruption } from './useAppStateInterruption';
import { useCaptureLifecycle } from './useCaptureLifecycle';
import { useClipReplacement } from './useClipReplacement';
import { useClipReviewState } from './useClipReviewState';
import { useClipUpload } from './useClipUpload';
import { useVideoAccess } from './useVideoAccess';
import { useVideoCaptureRuntime } from './useVideoCaptureRuntime';
import { useVideoRecordingFlow } from './useVideoRecordingFlow';
import { BrowserVideoPreview } from './video-capture-media';

export interface VideoCaptureScreenProps {
  platform?: CameraPlatform;
  runtimeClient?: RuntimeClient | null;
  realAccount?: {
    groupId: string;
    authenticatedRequest: AuthenticatedRequest;
    transferMode?: 'server' | 'direct';
  };
  /** The Photo tab of the mode switch (and Close, when `onClose` is not given). */
  onBack?: () => void;
  /** Close (×) and Done: back to the group. */
  onClose?: () => void;
  onContributionDeleted?: () => void;
  /** This week's allowance from the group ledger, for the pill before any moment exists. */
  allowance?: ContributionLedgerAllowance | null;
}

export function VideoCaptureScreen({
  onBack,
  onClose,
  onContributionDeleted,
  platform: platformProp,
  runtimeClient = null,
  allowance: allowanceProp = null,
  realAccount,
}: VideoCaptureScreenProps = {}) {
  useAllowLandscape();
  const cameraRef = useRef<CameraView>(null);
  const getCameraRef = useCallback(() => cameraRef.current, []);
  const runtime = useVideoCaptureRuntime({
    platformProp,
    runtimeClient,
    realAccount,
    getCameraRef,
  });
  const { platform, recorder } = runtime;
  const [error, setError] = useState<string | null>(null);
  const { height: viewportHeight, width: viewportWidth } = useWindowDimensions();
  // Fill the screen when the camera's shape matches it (phone upright, camera
  // upright); otherwise show the whole frame so nothing recorded is hidden.
  const [previewAspect, setPreviewAspect] = useState(9 / 16);
  const previewFit =
    previewAspect < 1 === viewportWidth / Math.max(1, viewportHeight) < 1 ? 'cover' : 'contain';
  const [momentsOpen, setMomentsOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const toast = useToast();
  const reviewState = useClipReviewState();
  const { clip, mode, review } = reviewState;
  const lifecycle = useCaptureLifecycle({
    recorder,
    uploadSession: runtime.uploadSession,
    clip,
    review,
  });
  const { contributionStatus, isCaptureActive, leaveCapture } = lifecycle;
  const {
    access,
    browserPreviewStream,
    openSettings,
    refresh,
    requestAccess,
    setBrowserPreviewStream,
  } = useVideoAccess({ platform, recorder, isCaptureActive, clipRef: lifecycle.clipRef, setError });

  // Longest clip: 15 s, or the seconds left this week when that is less.
  const allowance = contributionStatus?.allowance ?? allowanceProp;
  const left = allowanceLeft(allowance);
  const clipLimit = Math.min(MAX_CLIP_DURATION_SECONDS, left?.seconds ?? MAX_CLIP_DURATION_SECONDS);

  const { chooseVideoFile, elapsedSeconds, recording, resetRecording, startRecording } =
    useVideoRecordingFlow({
      platform,
      recorder,
      access,
      clipLimit,
      reviewState,
      lifecycle,
      setBrowserPreviewStream,
      setError,
    });
  const upload = useClipUpload({ runtime, reviewState, lifecycle, setError, toast });
  const { failureDismissed, retroPercent, retryInFlight, sealedHere, uploadProgress } = upload;
  useAppStateInterruption({
    platform,
    lifecycle,
    refresh,
    resetRecording,
    setBrowserPreviewStream,
    setUploadProgress: upload.setUploadProgress,
  });
  const { canDeleteContribution, deleteContributionForReplacement, retake } = useClipReplacement({
    runtime,
    reviewState,
    lifecycle,
    upload,
    setError,
    setMomentsOpen,
    onContributionDeleted,
  });

  const contributionFailed = contributionStatus?.state === 'failed';
  const canRetryContribution = contributionFailed && contributionStatus.retryable && !retryInFlight;
  const inReview = Boolean(review && clip && !recording);
  const uploading =
    retroPercent !== null ||
    uploadProgress.status === 'uploading' ||
    uploadProgress.status === 'validating';
  const showFailure = inReview && contributionFailed && !failureDismissed && !uploading;
  const showSealed = sealedHere && contributionStatus?.state === 'sealed';
  const hasFileFallback = Boolean(platform.supportsFileFallback && platform.pickVideoFile);
  const viewfinder = access === 'ready' && !clip;
  const browserPreviewMissing = Platform.OS === 'web' && !browserPreviewStream;
  const exitTo = onClose ?? onBack;
  const close = () => {
    // A moment in review is lost on close, so ask first.
    if (clip && !uploading) setConfirmDiscard(true);
    else leaveCapture(exitTo);
  };

  return (
    <CameraFrame bokeh={!viewfinder && !inReview} testID="video-capture-screen">
      {viewfinder ? (
        Platform.OS === 'web' ? (
          <LookPreview fit={previewFit} mode={mode} testID="video-live-look">
            <BrowserVideoPreview
              fit={previewFit}
              onAspect={setPreviewAspect}
              stream={browserPreviewStream}
            />
          </LookPreview>
        ) : (
          <CameraView
            facing="back"
            mode="video"
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            testID="video-live-preview"
          />
        )
      ) : null}
      {inReview && clip ? (
        <VideoReviewLayer
          access={access}
          canRetryContribution={canRetryContribution}
          clip={clip}
          contributionFailed={contributionFailed}
          contributionStatus={contributionStatus}
          error={error}
          mode={mode}
          panelHeight={reviewState.reviewPanelHeight}
          playerVisible={lifecycle.reviewPlayerVisible}
          retroPercent={retroPercent}
          retryInFlight={retryInFlight}
          showFailure={showFailure}
          trimEnd={reviewState.trimEnd}
          trimStart={reviewState.trimStart}
          uploadProgress={uploadProgress}
          uploading={uploading}
          onBackToReview={() => upload.setFailureDismissed(true)}
          onCancelRetro={() => lifecycle.retroAbortRef.current?.abort()}
          onCancelUpload={() => void upload.cancelUpload()}
          onChangeMode={(option) => {
            reviewState.setMode(option);
            review?.setMode(option);
          }}
          onChangeTrim={reviewState.changeTrim}
          onPanelLayout={reviewState.setReviewPanelHeight}
          onPlayerMounted={lifecycle.onReviewPlayerMounted}
          onPlayerUnmounted={lifecycle.onReviewPlayerUnmounted}
          onRetake={() => void retake()}
          onRetry={() => void upload.retryUpload()}
          onSeal={() => void upload.upload()}
        />
      ) : null}

      <CamTop allowance={allowance} closeTestID="video-close" onClose={exitTo ? close : undefined}>
        {viewfinder ? (
          <RecordingTimer
            clipLimit={clipLimit}
            elapsedSeconds={elapsedSeconds}
            recording={recording}
          />
        ) : null}
      </CamTop>

      {clip ? null : (
        <VideoAccessCard
          access={access}
          error={error}
          hasFileFallback={hasFileFallback}
          platform={platform}
          onChooseFile={() => void chooseVideoFile()}
          onOpenSettings={() => void openSettings()}
          onRefresh={() => void refresh()}
          onRequestAccess={() => void requestAccess()}
        />
      )}

      {clip ? null : (
        <VideoCaptureControls
          access={access}
          allowance={allowance}
          browserPreviewMissing={browserPreviewMissing}
          clipLimit={clipLimit}
          contributionStatus={contributionStatus}
          elapsedSeconds={elapsedSeconds}
          error={error}
          mode={mode}
          recording={recording}
          viewfinder={viewfinder}
          onChangeMode={reviewState.setMode}
          onOpenMoments={() => setMomentsOpen(true)}
          onPhoto={onBack ? () => leaveCapture(onBack) : undefined}
          onRestorePreview={() => void requestAccess()}
          onStart={() => void startRecording()}
          onStop={() => recorder?.stop()}
        />
      )}

      {showSealed ? (
        <SealedOverlay
          left={left?.moments ?? null}
          onDone={() => {
            upload.setSealedHere(false);
            if (onClose) leaveCapture(onClose);
          }}
          testID="camera-contribution-status-sealed"
        />
      ) : null}
      {momentsOpen ? (
        <MomentsDialog
          onClose={() => setMomentsOpen(false)}
          onDelete={canDeleteContribution ? deleteContributionForReplacement : undefined}
          onRetry={canRetryContribution ? () => void upload.retryUpload() : undefined}
          retryLabel="Retry upload"
          status={contributionStatus}
        />
      ) : null}
      {confirmDiscard ? (
        <Dialog
          body="It hasn’t been sealed, so it won’t count."
          label="Discard this video?"
          onDismiss={() => setConfirmDiscard(false)}
          title="Discard this video?"
        >
          <Button
            label="Discard"
            onPress={() => {
              setConfirmDiscard(false);
              leaveCapture(exitTo);
            }}
            variant="danger"
          />
          <Button label="Keep" onPress={() => setConfirmDiscard(false)} />
        </Dialog>
      ) : null}
    </CameraFrame>
  );
}

import { StyleSheet, Text, View } from 'react-native';

import type { CaptureMode, RecordedClip } from '../domain/video';
import type { ClipUploadProgress } from './clip-uploader';
import {
  CamBottom,
  CamButton,
  FailedPanel,
  LookPicker,
  Notice,
  ReviewActions,
  Tag,
  TrimBar,
  UploadPanel,
} from './camera-ui';
import type { ContributionStatus } from './contribution-status';
import type { AccessStatus } from './video-capture-helpers';
import { CapturedVideoReview } from './video-capture-media';
import { styles } from './video-capture-styles';

export interface VideoReviewLayerProps {
  access: AccessStatus;
  canRetryContribution: boolean;
  clip: RecordedClip;
  contributionFailed: boolean;
  contributionStatus: ContributionStatus | null;
  error: string | null;
  mode: CaptureMode;
  panelHeight: number;
  playerVisible: boolean;
  retroPercent: number | null;
  retryInFlight: boolean;
  showFailure: boolean;
  trimEnd: number;
  trimStart: number;
  uploadProgress: ClipUploadProgress;
  uploading: boolean;
  onBackToReview: () => void;
  onCancelRetro: () => void;
  onCancelUpload: () => void;
  onChangeMode: (mode: CaptureMode) => void;
  onChangeTrim: (start: number, end: number) => void;
  onPanelLayout: (height: number) => void;
  onPlayerMounted: () => void;
  onPlayerUnmounted: () => void;
  onRetake: () => void;
  onRetry: () => void;
  onSeal: () => void;
}

/** The review of a recorded clip: the player and the trim, look and Seal panel. */
export function VideoReviewLayer({
  access,
  canRetryContribution,
  clip,
  contributionFailed,
  contributionStatus,
  error,
  mode,
  panelHeight,
  playerVisible,
  retroPercent,
  retryInFlight,
  showFailure,
  trimEnd,
  trimStart,
  uploadProgress,
  uploading,
  onBackToReview,
  onCancelRetro,
  onCancelUpload,
  onChangeMode,
  onChangeTrim,
  onPanelLayout,
  onPlayerMounted,
  onPlayerUnmounted,
  onRetake,
  onRetry,
  onSeal,
}: VideoReviewLayerProps) {
  // V7 copy by failure kind; the message itself is in the notice below it.
  const failure = contributionFailed
    ? contributionStatus?.reason === 'quota_exceeded'
      ? { title: 'No moments left', body: 'You’ve used all your moments this cycle.' }
      : contributionStatus?.retryable
        ? {
            title: 'Couldn’t upload',
            body: 'It’s kept on this phone and doesn’t count until it’s sealed.',
          }
        : {
            title: 'Couldn’t seal this moment',
            body: 'This one can’t be retried. Take it again to add a new moment.',
          }
    : null;

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill} testID="video-review">
      {playerVisible ? (
        <CapturedVideoReview
          clip={clip}
          endSeconds={trimEnd}
          mode={mode}
          panelHeight={panelHeight}
          onMounted={onPlayerMounted}
          onUnmounted={onPlayerUnmounted}
          startSeconds={trimStart}
        />
      ) : null}
      <CamBottom onLayout={(event) => onPanelLayout(event.nativeEvent.layout.height)}>
        {clip.source === 'file' ? <Tag>Chosen from a file</Tag> : null}
        <Text style={styles.caption} testID="video-review-facts">
          {clip.source === 'file'
            ? `Selected MP4 ${clip.durationSeconds.toFixed(1)} seconds · ${clip.width} × ${clip.height} · audio track detected; server verifies`
            : `Recorded ${clip.durationSeconds.toFixed(1)} seconds · ${clip.width} × ${clip.height} · audio included`}
        </Text>
        {retroPercent !== null ? (
          <UploadPanel
            cancelLabel="Cancel retro look"
            label={`Applying look ${retroPercent}%`}
            onCancel={() => onCancelRetro()}
            percent={retroPercent}
            testID="video-retro-processing"
          />
        ) : uploading ? (
          <UploadPanel
            label={`Uploading ${uploadProgress.percent}%`}
            onCancel={() => onCancelUpload()}
            percent={uploadProgress.percent}
            testID="video-uploading"
          />
        ) : showFailure && failure ? (
          <FailedPanel
            accessibilityLabel={`${failure.title}. ${failure.body}${contributionStatus?.message ? ` ${contributionStatus.message}` : ''}`}
            detail={failure.body}
            onBackToReview={canRetryContribution ? () => onBackToReview() : undefined}
            onRetake={canRetryContribution ? undefined : () => onRetake()}
            onRetry={canRetryContribution ? () => onRetry() : undefined}
            testID="camera-contribution-status-failed"
            title={failure.title}
          />
        ) : uploadProgress.status === 'complete' && !contributionFailed ? (
          <>
            <Notice alert={false}>Upload queued as one pending contribution.</Notice>
            <CamButton height={52} label="Retake" onPress={() => onRetake()} />
          </>
        ) : (
          <>
            <TrimBar
              duration={clip.durationSeconds}
              end={trimEnd}
              onChange={onChangeTrim}
              start={trimStart}
            />
            <LookPicker disabled={retroPercent !== null} mode={mode} onChange={onChangeMode} />
            <ReviewActions>
              <CamButton label="Retake" onPress={() => onRetake()} style={styles.retake} />
              {contributionFailed && !canRetryContribution ? null : (
                <CamButton
                  busy={retryInFlight}
                  icon="lock"
                  label="Seal"
                  onPress={() => (contributionFailed ? onRetry() : onSeal())}
                  primary
                  style={styles.seal}
                  testID="video-seal"
                />
              )}
            </ReviewActions>
          </>
        )}
        {error && access !== 'error' ? <Notice>{error}</Notice> : null}
      </CamBottom>
    </View>
  );
}

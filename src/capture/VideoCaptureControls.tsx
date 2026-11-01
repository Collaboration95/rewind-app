import { Platform, Text, View } from 'react-native';

import { MAX_CLIP_DURATION_SECONDS, type CaptureMode } from '../domain/video';
import type { ContributionLedgerAllowance } from '../domain/contributions';
import {
  CamBottom,
  CamButton,
  LookPicker,
  ModeSwitch,
  MomentsButton,
  Notice,
  Shutter,
  ShutterRow,
  clock,
} from './camera-ui';
import type { ContributionStatus } from './contribution-status';
import type { AccessStatus } from './video-capture-helpers';
import { styles } from './video-capture-styles';

/** The elapsed / longest-clip timer shown at the top of the viewfinder. */
export function RecordingTimer({
  clipLimit,
  elapsedSeconds,
  recording,
}: {
  clipLimit: number;
  elapsedSeconds: number;
  recording: boolean;
}) {
  return (
    <View
      accessibilityLabel={
        recording
          ? `Recording, ${Math.floor(elapsedSeconds)} of ${clipLimit} seconds`
          : `Up to ${clipLimit} seconds`
      }
      accessible
      style={styles.timer}
      testID={recording ? 'video-recording' : undefined}
    >
      <View
        style={[styles.dot, recording && styles.dotOn]}
        {...(recording ? { dataSet: { rw: 'blink' } } : {})}
      />
      <Text style={styles.timerText}>
        {clock(elapsedSeconds)} / {clock(clipLimit)}
      </Text>
    </View>
  );
}

export interface VideoCaptureControlsProps {
  access: AccessStatus;
  allowance: ContributionLedgerAllowance | null | undefined;
  browserPreviewMissing: boolean;
  clipLimit: number;
  contributionStatus: ContributionStatus | null;
  elapsedSeconds: number;
  error: string | null;
  mode: CaptureMode;
  recording: boolean;
  viewfinder: boolean;
  onChangeMode: (mode: CaptureMode) => void;
  onOpenMoments: () => void;
  /** Present only when the host can go back to the Photo tab. */
  onPhoto: (() => void) | undefined;
  onRestorePreview: () => void;
  onStart: () => void;
  onStop: () => void;
}

/** The mode switch, look picker, shutter and guidance under the viewfinder. */
export function VideoCaptureControls({
  access,
  allowance,
  browserPreviewMissing,
  clipLimit,
  contributionStatus,
  elapsedSeconds,
  error,
  mode,
  recording,
  viewfinder,
  onChangeMode,
  onOpenMoments,
  onPhoto,
  onRestorePreview,
  onStart,
  onStop,
}: VideoCaptureControlsProps) {
  const guidance =
    Platform.OS === 'web'
      ? `Up to ${clipLimit} s with sound · portrait or landscape`
      : `Up to ${clipLimit} s with sound · hold your phone upright`;

  return (
    <CamBottom>
      {error && access !== 'error' && access !== 'temporarily-unavailable' ? (
        <Notice>{error}</Notice>
      ) : null}
      {recording ? null : (
        <ModeSwitch mode="video" onPhoto={onPhoto} photoTestID="video-photo-mode" />
      )}
      {viewfinder ? (
        <LookPicker
          disabled={recording}
          mode={mode}
          onChange={onChangeMode}
          testID="video-live-look-picker"
        />
      ) : null}
      {viewfinder && browserPreviewMissing ? (
        <CamButton
          label="Restore camera preview"
          onPress={() => onRestorePreview()}
          testID="video-preview-recovery"
        />
      ) : viewfinder ? (
        <ShutterRow
          center={
            <Shutter
              disabled={clipLimit < 1 && !recording}
              fraction={elapsedSeconds / MAX_CLIP_DURATION_SECONDS}
              hint={recording ? undefined : `Records up to ${clipLimit} seconds`}
              kind="video"
              label={recording ? 'Stop recording' : 'Start recording'}
              onPress={() => (recording ? onStop() : onStart())}
              recording={recording}
              testID="video-record"
            />
          }
          left={
            contributionStatus && !recording ? (
              <MomentsButton count={allowance?.countUsed} onPress={() => onOpenMoments()} />
            ) : null
          }
        />
      ) : null}
      {recording ? null : (
        <Text style={styles.caption} testID="video-portrait-guidance">
          {guidance}
        </Text>
      )}
    </CamBottom>
  );
}

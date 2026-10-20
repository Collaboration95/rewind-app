import type { ReactNode } from 'react';

import type { CameraPlatform } from './contracts';
import { CamButton, CamCard } from './camera-ui';
import type { AccessStatus } from './video-capture-helpers';

export interface VideoAccessCardProps {
  access: AccessStatus;
  error: string | null;
  hasFileFallback: boolean;
  platform: CameraPlatform;
  onChooseFile: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onRequestAccess: () => void;
}

/** The card shown in place of the viewfinder until recording access is ready. */
export function VideoAccessCard({
  access,
  error,
  hasFileFallback,
  platform,
  onChooseFile,
  onOpenSettings,
  onRefresh,
  onRequestAccess,
}: VideoAccessCardProps): ReactNode {
  return access === 'checking' ? (
    <CamCard body="Camera and microphone are being checked." title="Checking recording access…" />
  ) : access === 'unsupported' ? (
    <CamCard
      body={[
        platform.getVideoCaptureUnavailableReason?.(),
        hasFileFallback
          ? 'Live recording is not supported here. Choose an MP4 no longer than 15 seconds with an audio track; the server verifies it before upload. It remains labelled as a file contribution.'
          : 'Use a physical device with camera and microphone access. Unsupported recording cannot be started here.',
      ]
        .filter((message): message is string => Boolean(message))
        .join(' ')}
      testID="video-unsupported"
      title="Recording is not supported here"
    >
      {hasFileFallback ? (
        <CamButton height={48} label="Choose a video file" onPress={() => onChooseFile()} soft />
      ) : null}
    </CamCard>
  ) : access === 'temporarily-unavailable' ? (
    <CamCard
      body={error ?? 'The device capability check is not ready yet. Try again shortly.'}
      testID="video-temporarily-unavailable"
      title="Recording is temporarily unavailable"
    >
      <CamButton
        height={48}
        label={hasFileFallback ? 'Choose a video file' : 'Check again'}
        onPress={() => (hasFileFallback ? onChooseFile() : onRefresh())}
        soft
      />
    </CamCard>
  ) : access === 'permission-undecided' ? (
    // V1: asked only when the camera first opens; there is no skip.
    <CamCard
      body="Rewind records short videos with sound."
      testID="video-permission"
      title="Allow camera and mic"
    >
      <CamButton height={48} label="Continue" onPress={() => onRequestAccess()} soft />
    </CamCard>
  ) : access === 'permission-denied' || access === 'permission-blocked' ? (
    // V2: the system prompt will not show again, so Settings is the way back.
    <CamCard
      body="Turn Camera and Microphone on for Rewind in your phone’s Settings, then come back. Nothing was recorded."
      testID={
        access === 'permission-blocked' ? 'video-permission-blocked' : 'video-permission-denied'
      }
      title="Camera or mic is off"
    >
      <CamButton height={48} label="Open Settings" onPress={() => onOpenSettings()} soft />
      <CamButton
        height={48}
        label="Check again"
        onPress={() => (access === 'permission-denied' ? onRequestAccess() : onRefresh())}
      />
      {hasFileFallback ? (
        <CamButton height={48} label="Choose a video file" onPress={() => onChooseFile()} />
      ) : null}
    </CamCard>
  ) : access === 'error' ? (
    <CamCard body={error ?? 'Try again.'} title="Recording access needs checking">
      <CamButton height={48} label="Check again" onPress={() => onRefresh()} soft />
    </CamCard>
  ) : null;
}

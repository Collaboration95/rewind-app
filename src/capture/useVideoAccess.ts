import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

import type { RecordedClip } from '../domain/video';
import { userMessage } from '../domain/user-message';
import type { CameraPlatform, PermissionSnapshot } from './contracts';
import type { BoundedVideoRecordingSession } from './video-recording';
import type { AccessStatus } from './video-capture-helpers';

export interface VideoAccessOptions {
  platform: CameraPlatform;
  recorder: BoundedVideoRecordingSession | null;
  isCaptureActive: () => boolean;
  clipRef: { current: RecordedClip | null };
  setError: (message: string | null) => void;
}

/**
 * Camera and microphone access: the capability and permission check, the
 * permission request, the Settings hand-off, and the web preview stream.
 */
export function useVideoAccess({
  platform,
  recorder,
  isCaptureActive,
  clipRef,
  setError,
}: VideoAccessOptions) {
  const [access, setAccess] = useState<AccessStatus>('checking');
  const [browserPreviewStream, setBrowserPreviewStream] = useState<MediaStream | null>(null);

  const refresh = useCallback(
    async (videoPermissionSnapshot?: PermissionSnapshot) => {
      if (!isCaptureActive()) return;
      setAccess('checking');
      setError(null);
      if (platform.supportsVideoRecording === false || !recorder) {
        setAccess('unsupported');
        return;
      }
      try {
        const permissionCheck =
          videoPermissionSnapshot ??
          (Platform.OS === 'web'
            ? platform.getVideoPermissions?.()
            : (platform.getVideoPermissions?.() ?? platform.getPermissions()));
        if (!permissionCheck) {
          throw new Error('The video permission status is unavailable on this platform.');
        }
        const [capabilities, permissions] = await Promise.all([
          platform.getCapabilities(),
          permissionCheck,
        ]);
        if (!isCaptureActive()) return;
        if (capabilities.camera === 'undecided' || capabilities.microphone === 'undecided') {
          setAccess('temporarily-unavailable');
        } else if (capabilities.camera !== 'supported' || capabilities.microphone !== 'supported') {
          setAccess('unsupported');
        } else if (permissions.camera === 'blocked' || permissions.microphone === 'blocked') {
          setAccess('permission-blocked');
        } else if (
          permissions.camera === 'undetermined' ||
          permissions.microphone === 'undetermined'
        ) {
          setAccess('permission-undecided');
        } else if (permissions.camera === 'denied' || permissions.microphone === 'denied') {
          setAccess('permission-denied');
        } else {
          if (Platform.OS === 'web' && !clipRef.current) {
            let stream = platform.getVideoPreviewStream?.() ?? null;
            if (!stream && platform.requestVideoPermissions) {
              const restored = await platform.requestVideoPermissions();
              if (!isCaptureActive()) {
                platform.releaseVideoCapture?.();
                return;
              }
              if (restored.camera !== 'granted' || restored.microphone !== 'granted') {
                setAccess('permission-denied');
                return;
              }
              stream = platform.getVideoPreviewStream?.() ?? null;
            }
            setBrowserPreviewStream(stream);
          }
          setAccess('ready');
        }
      } catch {
        if (!isCaptureActive()) return;
        setAccess('temporarily-unavailable');
        setError('We could not check recording access yet. Try again.');
      }
    },
    [clipRef, isCaptureActive, platform, recorder, setError],
  );

  useEffect(() => {
    void Promise.resolve().then(() => refresh());
  }, [refresh]);

  useEffect(
    () => () => {
      platform.releaseVideoCapture?.();
    },
    [platform],
  );

  const requestAccess = useCallback(async () => {
    if (!isCaptureActive()) return;
    setError(null);
    try {
      const permissionRequest =
        Platform.OS === 'web'
          ? platform.requestVideoPermissions?.()
          : (platform.requestVideoPermissions?.() ?? platform.requestPermissions());
      if (!permissionRequest) {
        throw new Error('Video permission requests are unavailable on this platform.');
      }
      const permissions = await permissionRequest;
      setBrowserPreviewStream(platform.getVideoPreviewStream?.() ?? null);
      if (permissions.camera === 'denied' || permissions.microphone === 'denied') {
        setAccess('permission-denied');
        return;
      }
      if (isCaptureActive() && Platform.OS === 'web') {
        if (!platform.getVideoPermissions) {
          throw new Error('Browser video permissions could not be refreshed. Try again.');
        }
        const refreshedPermissions = await platform.getVideoPermissions();
        if (isCaptureActive()) await refresh(refreshedPermissions);
      } else if (isCaptureActive()) {
        await refresh();
      }
    } catch (permissionError) {
      if (!isCaptureActive()) return;
      setBrowserPreviewStream(platform.getVideoPreviewStream?.() ?? null);
      if (
        permissionError instanceof Error &&
        ['NotFoundError', 'OverconstrainedError'].includes(permissionError.name)
      ) {
        setAccess('unsupported');
        setError('This device does not have an available camera and microphone for recording.');
        return;
      }
      setAccess('temporarily-unavailable');
      setError('Camera access could not be checked right now. Try again or open Settings.');
    }
  }, [isCaptureActive, platform, refresh, setError]);

  const openSettings = useCallback(async () => {
    if (!isCaptureActive()) return;
    setError(null);
    try {
      await platform.openSettings();
      if (isCaptureActive()) await refresh();
    } catch (settingsError) {
      if (!isCaptureActive()) return;
      setError(
        userMessage(settingsError, 'Open this app settings to allow camera and microphone access.'),
      );
    }
  }, [isCaptureActive, platform, refresh, setError]);

  return {
    access,
    browserPreviewStream,
    openSettings,
    refresh,
    requestAccess,
    setBrowserPreviewStream,
  };
}

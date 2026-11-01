import { useEffect, useMemo } from 'react';
import type { CameraView } from 'expo-camera';

import type { RuntimeClient } from '../runtime/local-runtime-client';
import {
  createRealAccountVideoRuntimeClient,
  type AuthenticatedRequest,
} from './real-account-video-runtime';
import { ClipUploadSession } from './clip-uploader';
import { BoundedVideoRecordingSession } from './video-recording';
import { ExpoCameraPlatform } from './platform';
import type { CameraPlatform } from './contracts';
import { isVideoPlatform } from './video-capture-helpers';

export interface VideoCaptureRuntimeOptions {
  platformProp?: CameraPlatform;
  runtimeClient: RuntimeClient | null;
  realAccount?: {
    groupId: string;
    authenticatedRequest: AuthenticatedRequest;
    transferMode?: 'server' | 'direct';
  };
  getCameraRef: () => CameraView | null;
}

/**
 * The platform, recorder, runtime client and upload session the screen works
 * with. An injected platform or runtime client wins; otherwise the real-account
 * client is created (and disposed) here.
 */
export function useVideoCaptureRuntime({
  platformProp,
  runtimeClient,
  realAccount,
  getCameraRef,
}: VideoCaptureRuntimeOptions) {
  const platform = useMemo(
    () =>
      platformProp ??
      // Video keeps the in-page recorder: the phone camera sheet records web
      // video at a low preset (about 480p) that a page cannot raise.
      new ExpoCameraPlatform({
        getCameraRef,
      }),
    [getCameraRef, platformProp],
  );
  const recorder = useMemo(
    () => (isVideoPlatform(platform) ? new BoundedVideoRecordingSession(platform) : null),
    [platform],
  );
  const realGroupId = realAccount?.groupId;
  const authenticatedRequest = realAccount?.authenticatedRequest;
  const transferMode = realAccount?.transferMode ?? 'server';
  const ownedRealRuntimeClient = useMemo(
    () =>
      authenticatedRequest && realGroupId
        ? createRealAccountVideoRuntimeClient(authenticatedRequest, { transferMode })
        : null,
    [authenticatedRequest, realGroupId, transferMode],
  );
  useEffect(() => () => ownedRealRuntimeClient?.dispose(), [ownedRealRuntimeClient]);
  const activeRuntimeClient = useMemo(
    () => runtimeClient ?? ownedRealRuntimeClient,
    [ownedRealRuntimeClient, runtimeClient],
  );
  const uploadSessionId = realGroupId ? 'real-account-session' : null;
  const uploadGroupId = realGroupId ?? null;
  const uploadSession = useMemo(() => {
    if (
      !activeRuntimeClient?.uploadClip ||
      !activeRuntimeClient.cancelClipUpload ||
      !uploadSessionId ||
      !uploadGroupId
    ) {
      return null;
    }
    return new ClipUploadSession({
      cancelClipUpload: (jobId) =>
        activeRuntimeClient.cancelClipUpload!(uploadSessionId, uploadGroupId, jobId),
      uploadClip: (input, signal) =>
        activeRuntimeClient.uploadClip!(uploadSessionId, uploadGroupId, input, signal),
    });
  }, [activeRuntimeClient, uploadGroupId, uploadSessionId]);

  return {
    activeRuntimeClient,
    // The real-account client this screen created itself, not an injected one.
    ownsRealRuntime: Boolean(ownedRealRuntimeClient && !runtimeClient),
    platform,
    recorder,
    transferMode,
    uploadGroupId,
    uploadSession,
    uploadSessionId,
  };
}
